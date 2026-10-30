import { type Context } from 'hono'
import { gitFileDiff, gitNumstat } from '../exec/git.ts'
import { uploadFileOf } from '../uploads.ts'
import { listDir, listLevel, rawInDir, readInDir, revealInDir, searchInDir, searchNameInDir } from '../files.ts'
import path from 'node:path'
import { sessionInfo } from '../session-bar.ts'
import { t } from '../../shared/i18n.ts'
import type { TasksScope } from './scope.ts'

/**
 * 对话工作目录里的文件：改动差异、会话栏、文件树、读文件和看图、在文件管理器里打开。
 */
export function registerFileRoutes(s: TasksScope) {
  // 一个改动文件的差异：git 仓库和任务开始时的提交比；不是仓库时拼出 Agent 改这个文件时给出的改动
  s.routes.get('/:id/diff', async (c) => {
    const tk = await s.current(c.req.param('id'))
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    const file = c.req.query('path') ?? ''
    if (!tk.changes.some((x) => x.path === file)) return s.bad(c, t('这个文件不在任务的改动里'))
    const dir = await s.taskDir(tk)
    // 导入的任务改的是别人电脑上的文件，只能拼出 Agent 当时给出的改动
    const isGit = !tk.imported && !!dir && (await gitNumstat(dir, tk.baseRef).catch(() => null)) !== null
    if (isGit) {
      const diff = await gitFileDiff(dir, tk.baseRef, file)
      return c.json({ path: file, dir, diff, git: true, before: file in tk.baseline })
    }
    const patches = tk.messages
      .flatMap((m) => m.tools)
      .filter((x) => x.kind === 'edit' && x.label === file && x.input)
      .map((x) => x.input!)
    return c.json({ path: file, dir, diff: patches.join('\n'), git: false, before: false })
  })

  // 会话栏：环境、说明文件、Skill、新建的文件；cli 是这个对话当前用的 CLI（页面按角色算好传来）
  s.routes.get('/:id/session', async (c) => {
    const tk = await s.current(c.req.param('id'))
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    return c.json(await sessionInfo(tk, tk.imported ? '' : await s.taskDir(tk), c.req.query('cli') ?? ''))
  })

  /** 任务的工作目录；导入的任务没有本机目录，读文件时直接拒绝 */
  const readableDir = async (id: string | undefined) => {
    const tk = id ? await s.current(id) : null
    if (!tk) throw Object.assign(new Error(t('任务不存在')), { status: 404 })
    if (tk.imported) throw Object.assign(new Error(t('导入的任务看不到对方电脑上的文件')), { status: 400 })
    const dir = await s.taskDir(tk)
    if (!dir) throw Object.assign(new Error(t('任务没有工作目录')), { status: 404 })
    return dir
  }

  /** 拿到任务目录跑一段；读不了时按原因返回错误 */
  const inTaskDir = async (c: Context, run: (dir: string) => Promise<Response>) => {
    try {
      return await run(await readableDir(c.req.param('id')))
    } catch (e) {
      // 路径越界、不是图片这类参数问题按 400；任务或目录找不到的情况自己带上 404
      const status = (e as { status?: 400 | 404 }).status ?? 400
      return s.bad(c, (e as Error).message, status)
    }
  }

  // 任务目录的根信息：右栏的文件系统，独立分支时是 worktree 目录
  s.routes.get('/:id/files', (c) => inTaskDir(c, async (dir) => c.json(await listDir(dir))))

  // 任务目录里列一层：展开目录时读它的直接子项
  s.routes.get('/:id/files/list', (c) =>
    inTaskDir(c, async (dir) =>
      c.json(await listLevel(dir, c.req.query('path') ?? '', { refresh: c.req.query('refresh') === '1' })),
    ),
  )

  // 任务目录里搜索：默认按文件名，content 按内容
  s.routes.get('/:id/files/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (!q) return c.json({ files: [], truncated: false })
    const name = (c.req.query('mode') ?? 'content') === 'name'
    return inTaskDir(c, async (dir) => c.json(name ? await searchNameInDir(dir, q) : await searchInDir(dir, q)))
  })

  // Agent 输出里提到的文件：读出内容给任务页显示。只能读任务目录里面的文件和上传的附件
  s.routes.get('/:id/file', async (c) => {
    const want = (c.req.query('path') ?? '').trim()
    if (!want) return s.bad(c, t('缺少文件路径'))
    const up = uploadFileOf(want)
    if (up) {
      const dir = path.dirname(up)
      return c.json({ ...(await readInDir(dir, path.basename(up))), dir })
    }
    return inTaskDir(c, async (dir) => c.json({ ...(await readInDir(dir, want)), dir }))
  })

  // 读到的文件是图片时给页面看图：返回原始内容，只能读任务目录里面的文件和上传的附件
  s.routes.get('/:id/file/raw', async (c) => {
    const want = (c.req.query('path') ?? '').trim()
    if (!want) return s.bad(c, t('缺少文件路径'))
    const up = uploadFileOf(want)
    if (up) {
      try {
        const { type, buf } = await rawInDir(path.dirname(up), path.basename(up))
        return c.body(new Uint8Array(buf), 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=60' })
      } catch (e) {
        return s.bad(c, (e as Error).message, 404)
      }
    }
    return inTaskDir(c, async (dir) => {
      const { type, buf } = await rawInDir(dir, want)
      return c.body(new Uint8Array(buf), 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=60' })
    })
  })

  // 在系统的文件管理器里打开这个文件所在的文件夹并选中它；传空路径时打开任务目录
  // （只能打开任务目录里面的文件）
  s.routes.post('/:id/reveal', async (c) => {
    const { path: file } = (await c.req.json().catch(() => ({}))) as { path?: string }
    const want = String(file ?? '').trim()
    return inTaskDir(c, async (dir) => {
      await revealInDir(dir, want)
      return c.json({ ok: true, dir })
    })
  })

  return { readableDir }
}
