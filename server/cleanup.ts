/**
 * 数据目录的清理：对话工作目录（chats/<对话 id>）、失效的独立分支目录、构建产物。
 *
 * 单独一个文件而不是塞进 server/data.ts：这里要逐个目录 stat、还要判 git 状态（分支合没合、
 * 有没有没提交的改动），比 /data 那套「按分类扫路径」重得多，路由也分开放（/data/cleanup）。
 * 判定和定时清扫共用一份（sweepWorktrees 的 dryRun），不另写一套「失效」标准。
 */
import { lstat, readdir, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  BUILD_OUTPUTS,
  CHAT_WORKSPACE_TOP_N,
  CleanupReport,
  WorktreeCleanup,
  type BuildOutputId,
} from '../shared/data.ts'
import type { Project, Task } from '../shared/schema.ts'
import { taskDeleted } from '../shared/task.ts'
import { CHATS_DIR, DATA_DIR } from './store.ts'
import { WORKTREES_DIR, sweepWorktrees, type SweepTaskInfo } from './exec/worktree.ts'
import { appDir } from './update.ts'
import { log } from './log.ts'
import { t } from '../shared/i18n.ts'

type Lister<T> = { list(): Promise<T[]>; get(id: string): Promise<T | null> }

/** 清理要用到的任务接口：列任务（工作目录要名字和回收站标记）、正在跑的任务（不能清） */
export type CleanupTasks = {
  list(): Promise<Task[]>
  workingTasks(): { id: string }[]
  get(id: string): Promise<Task | null>
}

const BUILD_IDS = BUILD_OUTPUTS.map((b) => b.id) as [BuildOutputId, ...BuildOutputId[]]

/** 相对数据目录的路径：清单里显示它，不把用户目录的绝对路径（带用户名）铺在界面上 */
const relTo = (full: string) => path.relative(DATA_DIR, full).split(path.sep).join('/')

/**
 * 目录占用：递归统计，不跟随链接。
 * 链接指向的是数据目录外面（共用依赖、别的盘），跟进去会把别人的文件算成这里的占用
 */
export async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  const s = await lstat(dir).catch(() => null)
  if (!s) return { bytes: 0, files: 0 }
  if (!s.isDirectory()) return { bytes: s.size, files: 1 }
  let bytes = 0
  let files = 0
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const r = await dirSize(path.join(dir, name))
    bytes += r.bytes
    files += r.files
  }
  return { bytes, files }
}

/**
 * worktrees 下指向已经不存在的目标的链接（面板重启、仓库被挪走 / 删掉后的 junction、symlink）。
 * sweepWorktrees 只处理目录（readdir 的 isDirectory 不跟随链接），这类死链它看不见，
 * 但它们不占空间也修不好，属于纯垃圾，这里单独挑出来
 */
export async function deadWorktreeLinks(root = WORKTREES_DIR): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    for (const e of entries ?? []) {
      const at = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        // stat 跟随链接：目标在就是活的，读不到才是死链
        if (!(await stat(at).catch(() => null))) out.push(at)
        continue
      }
      // 新布局 worktrees/<项目>/<任务 id>：只往下走一层，再深就不是任务目录了
      if (e.isDirectory() && depth < 1) await walk(at, depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

type SweepBase = { root?: string; taskInfo?: (id: string) => Promise<SweepTaskInfo | null>; minAgeMs?: number }

/** 清单和真清用同一份参数：两边判定必须一样，否则列出来的清不掉 */
const sweepArgs = (opts: SweepBase) => ({
  root: opts.root ?? WORKTREES_DIR,
  // 不传就用 sweepWorktrees 的默认值（10 分钟内动过的不动），测试传 0
  ...(opts.minAgeMs !== undefined ? { minAgeMs: opts.minAgeMs } : {}),
  ...(opts.taskInfo ? { taskInfo: opts.taskInfo } : {}),
})

/**
 * 「失效的独立分支目录」清单：判定和定时清扫完全一致（sweepWorktrees 的 dryRun），
 * 加上它看不见的死链。这里只出清单，不删
 */
export async function staleWorktrees(opts: SweepBase = {}) {
  const res = await sweepWorktrees({ ...sweepArgs(opts), dryRun: true })
  const out: { dir: string; bytes: number; reason: string }[] = []
  for (const item of res.removed) {
    out.push({ dir: relTo(item.dir), bytes: (await dirSize(item.dir)).bytes, reason: item.reason })
  }
  for (const link of await deadWorktreeLinks(sweepArgs(opts).root)) {
    out.push({ dir: relTo(link), bytes: 0, reason: t('链接指向的目录已经不在了') })
  }
  return out
}

/** 清掉失效的独立分支目录（死链 + 定时清扫会清的），返回真的删了几个、释放了多少字节 */
export async function clearStaleWorktrees(opts: SweepBase = {}) {
  const args = sweepArgs(opts)
  // 先按清单算要释放多少：删完目录就不在了
  const before = await staleWorktrees(opts)
  const bytes = before.reduce((n, i) => n + i.bytes, 0)
  let removed = 0
  for (const link of await deadWorktreeLinks(args.root)) {
    try {
      await unlink(link)
      removed++
    } catch (e) {
      log.warn('cleanup', '删失效链接失败', { link, error: (e as Error).message })
    }
  }
  const res = await sweepWorktrees(args)
  removed += res.removed.length
  return { removed, failed: res.failed.length, bytes }
}

/**
 * 这个对话现在算不算在跑：正在执行、等下一句、预热中都不能动。
 * 只在这一处判定：统计里的 running 标记和 POST 的拒绕都用它（否则两处迟早不一致）
 */
const chatBusy = (tk: Task, working: Set<string>) =>
  working.has(tk.id) || tk.working === true || tk.awaitingUser === true || tk.prewarming === true

/** 目录名能不能当对话 id：只允许单段名字，防止 `../tasks` 这种借清理删到别的目录 */
const isChatDirName = (id: string) =>
  !!id && id !== '.' && id !== '..' && id === path.basename(id) && !id.includes(path.sep) && !id.includes('/')

/**
 * 对话工作目录：以 chats/ 下的目录为准（不是以任务记录为准）。
 * 记录已删但目录还在的（删对话时文件被占用、rm 失败）也要能列出来清掉，
 * 否则它会一直算在占用里、界面上却没有任何清理入口。按占用倒序，只取前 CHAT_WORKSPACE_TOP_N 个
 */
export async function chatWorkspaces(tasks: CleanupTasks) {
  const working = new Set(tasks.workingTasks().map((w) => w.id))
  const known = new Map((await tasks.list()).map((tk) => [tk.id, tk]))
  const entries = await readdir(CHATS_DIR, { withFileTypes: true }).catch(() => [])
  const rows: CleanupReport['chats']['top'] = []
  let bytes = 0
  let files = 0
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const size = await dirSize(path.join(CHATS_DIR, e.name))
    // 空目录不列（列表会全是 0 B）
    if (!size.files) continue
    bytes += size.bytes
    files += size.files
    const tk = known.get(e.name)
    rows.push({
      id: e.name,
      title: tk?.title ?? '',
      bytes: size.bytes,
      files: size.files,
      trashed: !!tk && taskDeleted(tk),
      running: !!tk && chatBusy(tk, working),
      orphan: !tk,
    })
  }
  rows.sort((a, b) => b.bytes - a.bytes)
  return {
    bytes,
    files,
    top: rows.slice(0, CHAT_WORKSPACE_TOP_N),
    more: Math.max(0, rows.length - CHAT_WORKSPACE_TOP_N),
  }
}

/**
 * 这个对话的工作目录能不能清：返回不能清的原因，能清时返回空字符串。
 * 前端按同一份状态禁用按钮，这里再判一次——按钮禁用挡不住直接调接口
 */
export function chatWorkspaceBlock(tk: Task | null, working: boolean): string {
  // 记录已经不在了（孤儿目录）：没人会再用它，直接清
  if (!tk) return ''
  // 回收站里的目录是恢复后要接着用的，清了恢复出来也没有工作目录
  if (taskDeleted(tk)) return t('回收站里的对话不能清工作目录：恢复后还要用它')
  if (working) return t('对话正在执行，等它结束后再清')
  return ''
}

/**
 * 清掉一个对话的工作目录（只删目录内容，对话记录在 tasks/ 里，不动）。
 * 下次执行时 chatWorkspace 会重新建这个目录，Agent 从头开始
 */
export async function clearChatWorkspace(id: string): Promise<number> {
  const dir = path.join(CHATS_DIR, id)
  const { bytes } = await dirSize(dir)
  await rm(dir, { recursive: true, force: true })
  return bytes
}

/** 构建产物（dist / dist-demo / release / ui-shots）：不在数据目录里，是 npm run 生成的，可以清 */
export async function buildOutputs(dir = appDir()) {
  return Promise.all(
    BUILD_OUTPUTS.map(async (b) => {
      const full = path.join(dir, b.id)
      const present = !!(await lstat(full).catch(() => null))
      return { id: b.id, bytes: present ? (await dirSize(full)).bytes : 0, present }
    }),
  )
}

/**
 * 清扫和「一键清理失效目录」共用的任务快照。
 * 放在这里而不是各写一份：working 的判定一旦两处不一致，一键清理就会删掉在跑的目录
 */
export function sweepTaskInfoOf(tasks: CleanupTasks, projects: Lister<Project>) {
  return async (id: string): Promise<SweepTaskInfo | null> => {
    // 在跑的任务从内存里拿（任务记录里的 working 可能是上一轮留下的），而且每次调用都要重新取：
    // 面板启动时一个都没在跑，快照一次会让之后所有请求的「在跑保护」永远失效
    const working = new Set(tasks.workingTasks().map((w) => w.id))
    const tk = await tasks.get(id)
    if (!tk) return null
    const p = tk.projectId ? await projects.get(tk.projectId) : null
    return {
      // 显式收口，或者这一轮已经跑完 / 被停掉：剩下没人会再触发收口（面板重启、父对话结束）
      done: tk.resolved === true || tk.archived === true || tk.status === 'done' || tk.status === 'stopped',
      // 等下一句、预热中的 CLI 还活着，也算在用，目录不能动。
      // 进了回收站的对话也算在用：保留期内还要能恢复，目录得留着；到期由 tasks.cleanupTrash 连目录一起删
      working:
        !!tk.deletedAt || working.has(id) || tk.working === true || tk.awaitingUser === true || tk.prewarming === true,
      projectPath: p?.path ?? '',
      branch: tk.worktree?.branch ?? '',
      baseBranch: tk.worktree?.baseBranch ?? '',
    }
  }
}

export function cleanupApi(deps: { tasks: CleanupTasks; projects: Lister<Project> }) {
  const routes = new Hono()
  // 每次请求新建：里面要读当前在跑的任务、扫当前目录，不能拿一份启动时算好的快照
  const taskInfo = () => sweepTaskInfoOf(deps.tasks, deps.projects)

  routes.get('/', async (c) => {
    // 只回轻的（对话目录 + 构建产物）：独立分支要跑 git 判定、递归四 GB，用下面的 /worktrees 单独拉
    const [chats, builds] = await Promise.all([chatWorkspaces(deps.tasks), buildOutputs()])
    return c.json(CleanupReport.parse({ chats, builds }))
  })

  routes.get('/worktrees', async (c) => {
    const stale = await staleWorktrees({ taskInfo: taskInfo() })
    // 总占用按目录逐个数（不跟随链接）：失效的已经算在 stale 里，合起来才是 worktrees 这一项
    const { bytes } = await dirSize(WORKTREES_DIR)
    return c.json(WorktreeCleanup.parse({ bytes, stale, staleBytes: stale.reduce((n, i) => n + i.bytes, 0) }))
  })

  routes.post('/chat', async (c) => {
    const body = z.object({ id: z.string().min(1) }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('请选择要清理的对话') }, 400)
    const id = body.data.id
    // id 只能是一个目录名：拿 `../tasks` 这种拼进来就能删到 chats/ 以外的目录
    if (!isChatDirName(id)) return c.json({ error: t('不认识的对话目录') }, 400)
    if (!(await lstat(path.join(CHATS_DIR, id)).catch(() => null)))
      return c.json({ error: t('这个对话没有工作目录') }, 404)
    const tk = await deps.tasks.get(id)
    // 用接口再判一次：界面按状态禁用了按钮，但请求可以绕过按钮直接发
    const block = chatWorkspaceBlock(tk, !!tk && chatBusy(tk, new Set(deps.tasks.workingTasks().map((w) => w.id))))
    if (block) return c.json({ error: block }, 409)
    const bytes = await clearChatWorkspace(id)
    log.info('cleanup', '清理了对话工作目录', { id, bytes })
    return c.json({ ok: true, bytes })
  })

  routes.post('/worktrees', async (c) => {
    const res = await clearStaleWorktrees({ taskInfo: taskInfo() })
    log.info('cleanup', '清理失效的独立分支目录', res)
    return c.json({ ok: true, ...res })
  })

  routes.post('/builds', async (c) => {
    const body = z
      .object({ ids: z.array(z.enum(BUILD_IDS)).optional() })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: t('不认识的构建产物') }, 400)
    // 不指定就全清：这类目录都由 npm run 重新生成
    const ids = body.data.ids?.length ? body.data.ids : BUILD_IDS
    const before = await buildOutputs()
    const bytes = before.filter((b) => ids.includes(b.id)).reduce((n, b) => n + b.bytes, 0)
    for (const id of ids) await rm(path.join(appDir(), id), { recursive: true, force: true })
    log.info('cleanup', '清理了构建产物', { ids, bytes })
    return c.json({ ok: true, bytes })
  })

  return routes
}
