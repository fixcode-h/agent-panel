import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, symlink, appendFile, lstat, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import type { TaskWorktree } from '../../shared/schema.ts'
import { type ChildHold, childHoldText } from '../../shared/task.ts'
import { t } from '../../shared/i18n.ts'
import { DATA_DIR } from '../store.ts'
import { capture } from './process.ts'
import { log } from '../log.ts'

/** 任务的独立工作目录放在数据目录里，不放进项目目录，免得被项目自己的 git 和工具扫到 */
export const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees')

const git = (cwd: string, ...args: string[]) =>
  capture('git', ['-c', 'core.quotepath=off', ...args], cwd, process.env, 60_000)
const fail = (r: { stderr: string; stdout: string }, fallback: string) =>
  new Error((r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n') || fallback)

/** 分支名里只留字母数字，中文标题就只用任务 id */
const branchName = (taskId: string, title: string) => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  return `agent-panel/${slug ? `${slug}-` : ''}${taskId.slice(0, 8)}`
}

/** 不复制过去的环境文件：带后缀的通常是本机真实密钥，只留在项目目录里，子对话需要时自己问用户 */
const SECRET_ENV = /^\.env\.(local|production|prod|development|dev|staging|test)$/i

/** 依赖目录会被 npm / pip 按各自那份 package.json 修剪，必须各用各的，不能链接共用 */
const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor']

/** 一批复制多少个文件：27k 个文件、596MB 的 node_modules 实测 12–20 秒，再往上并发提升不明显 */
const COPY_BATCH = 64

/**
 * 把整个依赖目录复制一份到独立目录（逐层建目录、逐文件复制）。
 * 不用硬链接：跨分卷用不了（数据目录在 C:、项目常在别的盘），同分卷时 npm 原地重写
 * node_modules/.package-lock.json 又会顺着 inode 改到项目那一份。复制最稳，代价是一次性成本。
 * 复制失败时把没复制完的目录删掉：留着的话下次 existsSync 会当成已经准备好，问题被藏起来。
 */
async function cloneDir(from: string, to: string) {
  const dirs: string[] = []
  const files: [string, string][] = []
  const links: [string, string][] = []
  const walk = async (src: string, dst: string) => {
    dirs.push(dst)
    for (const e of await readdir(src, { withFileTypes: true })) {
      const s = path.join(src, e.name)
      const d = path.join(dst, e.name)
      if (e.isDirectory()) await walk(s, d)
      else if (e.isSymbolicLink()) links.push([s, d])
      else files.push([s, d])
    }
  }
  await walk(from, to)
  for (const d of dirs) await mkdir(d, { recursive: true })
  // 依赖里的符号链接（npm 在 Linux/macOS 上给 .bin 建的那种）按原来的相对目标重建；
  // Windows 上建不了就复制目标内容（那边走的是 .cmd，不影响命令能不能跑起来）
  for (const [s, d] of links) {
    const target = await readlink(s).catch(() => '')
    const ok = target
      ? await symlink(target, d).then(
          () => true,
          () => false,
        )
      : false
    if (!ok) await copyFile(s, d).catch(() => {})
  }
  for (let i = 0; i < files.length; i += COPY_BATCH) {
    await Promise.all(files.slice(i, i + COPY_BATCH).map(([s, d]) => copyFile(s, d).catch(() => {})))
  }
  return files.length
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

async function packageJson(dir: string): Promise<PackageJson | null> {
  const text = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '')
  if (!text) return null
  // 手写坏的 package.json 不在这里报错：这里只是顺手检查依赖全不全
  try {
    return JSON.parse(text) as PackageJson
  } catch {
    return null
  }
}

/**
 * package.json 里声明、但 node_modules 里没装上的包。
 * 共用依赖被某个工作目录跑安装/清理修剪掉之后，后面的命令只会各自报「找不到模块」；
 * 开独立目录时先看一眼，直接把「哪个目录、少了什么、怎么补」写进面板日志。
 */
export async function missingDeps(dir: string) {
  const pkg = await packageJson(dir)
  if (!pkg) return []
  const want = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  return want.filter((name) => !existsSync(path.join(dir, 'node_modules', name, 'package.json')))
}

/** 依赖不完整时说清缺哪些、怎么补，别让后面每条命令各报一句「找不到模块」 */
function warnMissingDeps(dir: string, missing: string[]) {
  if (!missing.length) return
  log.error('worktree', '依赖不完整：这个目录里少装了声明的包，接下来会接连报「找不到模块」', {
    dir: path.join(dir, 'node_modules'),
    missing: missing.slice(0, 20).join('、') + (missing.length > 20 ? ` 等 ${missing.length} 个` : ''),
    recover:
      '在一份完整的独立目录里跑 npm ci --include=dev，或者把完好的 node_modules 整份复制回来；不要在多个对话共用的目录里跑 npm install / npm ci',
  })
}

/**
 * 把项目里的依赖目录复制一份到独立目录，不建链接：链接过去时子对话在自己的目录里跑 npm install
 * 会按它那份 package.json 修剪依赖，剪掉的正是项目里那一份真目录（2026-10 的事故：主工作区
 * node_modules 从满装变成 0 项，几个对话的验证一起失败）。返回复制过去的目录名。
 * 失败不算错：Agent 自己在独立目录里也会看到缺什么。
 */
export async function isolateDeps(dir: string, repo: string) {
  const prepared: string[] = []
  for (const name of DEP_DIRS) {
    const from = path.join(repo, name)
    const to = path.join(dir, name)
    if (!existsSync(from)) continue
    const st = await lstat(to).catch(() => null)
    // 早先开的工作目录里是链接，正好是事故的来源：换成独立的一份，它再跑安装也动不到项目
    if (st?.isSymbolicLink()) await rm(to, { force: true }).catch(() => {})
    else if (st) continue
    const started = Date.now()
    const files = await cloneDir(from, to).catch(async (e: Error) => {
      await rm(to, { recursive: true, force: true }).catch(() => {})
      log.warn('worktree', '依赖目录没复制过去，这个工作目录里要自己装', {
        from,
        error: e.message,
      })
      return 0
    })
    if (!files) continue
    prepared.push(name)
    log.info('worktree', '依赖目录复制到独立目录', { name, files, ms: Date.now() - started })
  }
  return prepared
}

/** 独立目录的准备工作：依赖各用一份（见 isolateDeps），环境文件复制一份——含密钥的 .env.local 等不复制 */
async function prepare(dir: string, repo: string) {
  const prepared = await isolateDeps(dir, repo)
  // 项目没忽略这些目录时，合并前的 git add -A 会把整个依赖装进提交：写进这个工作目录自己的 exclude
  for (const name of prepared) {
    const ignored = await capture('git', ['check-ignore', '-q', name], dir, process.env, 10_000)
    if (ignored.code === 0) continue
    const exclude = await capture('git', ['rev-parse', '--git-path', 'info/exclude'], dir, process.env, 10_000)
    if (exclude.code === 0) await appendFile(path.resolve(dir, exclude.stdout.trim()), `/${name}\n`).catch(() => {})
  }
  const envs = await readdir(repo).catch(() => [] as string[])
  for (const name of envs) {
    if (!name.startsWith('.env') || SECRET_ENV.test(name)) continue
    const from = path.join(repo, name)
    await copyFile(from, path.join(dir, name)).catch(() => {})
  }
  warnMissingDeps(repo, await missingDeps(repo))
}

/** 能不能开独立分支：要是 git 仓库、至少有一个提交；不能时抛出给用户看的原因 */
export async function checkRepo(repo: string) {
  const inside = await git(repo, 'rev-parse', '--is-inside-work-tree')
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new Error(t('项目不是 git 仓库，不能用独立分支执行'))
  const head = await git(repo, 'rev-parse', '--verify', 'HEAD')
  if (head.code !== 0) throw new Error(t('项目还没有任何提交，不能用独立分支执行'))
}

/** UE 这类大项目：项目目录或仓库根目录里有 .uproject */
async function isBigProject(repo: string) {
  const root = (await git(repo, 'rev-parse', '--show-toplevel')).stdout.trim() || repo
  for (const dir of new Set([repo, root])) {
    const names = await readdir(dir).catch(() => [] as string[])
    if (names.some((n) => n.toLowerCase().endsWith('.uproject'))) return true
  }
  return false
}

/**
 * 给任务建一个独立的 git 工作目录（git worktree）和分支，从项目当前的提交出发。
 * Agent 在里面改，不影响项目目录，也不和同时执行的其他任务互相干扰；做完后再合并或丢弃。
 */
export async function createWorktree(repo: string, taskId: string, title: string): Promise<TaskWorktree> {
  await checkRepo(repo)
  const baseBranch = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  const dir = path.join(WORKTREES_DIR, taskId)
  await mkdir(WORKTREES_DIR, { recursive: true })
  const branch = branchName(taskId, title)
  // 一般项目完整检出（包括 LFS 文件），编译、写代码要用的都在；git 不管的中间文件和临时文件本来就不会带过去。
  // 只有 UE 这类大项目不下载 LFS 大文件（贴图、uasset），只留指针文件：改代码用不着，全量下载太慢也太占磁盘
  const big = await isBigProject(repo)
  const r = await capture(
    'git',
    ['-c', 'core.quotepath=off', 'worktree', 'add', '-b', branch, dir, 'HEAD'],
    repo,
    big ? { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } : process.env,
    10 * 60_000,
  )
  if (r.code !== 0) throw fail(r, t('创建独立分支失败'))
  await prepare(dir, repo)
  return { path: dir, branch, baseBranch: baseBranch === 'HEAD' ? '' : baseBranch, state: 'active', note: '' }
}

/** 分支在本地仓库里还在 */
async function hasBranch(cwd: string, branch: string) {
  return (await git(cwd, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`)).code === 0
}

/**
 * 工作区被回收后又被继续（合并完删了目录和分支、用户手动清理过）：按原来的分支名把工作区建回来。
 * - 目录和分支都在：什么都不做，直接接着用；
 * - 目录没了、分支还在：把那个分支检出来，之前没合完的提交还在；
 * - 目录和分支都没了：从 cwd 现在的提交重新开一个同名分支（已经合回原分支的对话继续改，从这里往前走）。
 * cwd 是子对话时传父对话的目录，基点就是父对话所在的分支。
 * 建不出来时抛错，并把这半截目录清掉，不留半成品。
 */
export async function ensureWorktree(
  cwd: string,
  wt: TaskWorktree,
  taskId: string,
  title: string,
): Promise<{ worktree: TaskWorktree; rebuilt: boolean }> {
  await checkRepo(cwd)
  const branch = wt.branch || branchName(taskId, title)
  const dir = wt.path || path.join(WORKTREES_DIR, taskId)
  if (existsSync(dir) && (await hasBranch(cwd, branch))) return { worktree: wt, rebuilt: false }
  const baseBranch = (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  const branchAlive = await hasBranch(cwd, branch)
  // 目录还在、分支没了这种不一致：先把残留目录清掉，否则 worktree add 会因为目录已存在失败
  await wipe(dir)
  // 目录是手动删掉的时候，git 里还登记着这个工作区：先 prune，不然同名分支会被当成「已经在别处检出」
  await git(cwd, 'worktree', 'prune')
  await mkdir(WORKTREES_DIR, { recursive: true })
  const big = await isBigProject(cwd)
  const r = await capture(
    'git',
    ['-c', 'core.quotepath=off', 'worktree', 'add', ...(branchAlive ? [dir, branch] : ['-b', branch, dir, 'HEAD'])],
    cwd,
    big ? { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } : process.env,
    10 * 60_000,
  )
  if (r.code !== 0) {
    // 失败也可能已经建出目录来：清掉，下次重试从干净的状态开始
    await git(cwd, 'worktree', 'remove', '--force', dir)
    await wipe(dir)
    await git(cwd, 'worktree', 'prune')
    throw new Error(
      t('重建独立工作区失败：{error}', { error: (r.stderr || r.stdout).trim().split('\n').slice(-4).join('\n') }) +
        '\n' +
        t(
          '已经尝试重建（分支 {branch}，目录 {dir}），没有留下半个工作区。可以到原目录跑 git worktree prune 和 git branch -d {branch} 清掉残留后再试一次；或者把这个对话的独立分支删掉，让它回到原目录执行。',
          {
            branch,
            dir,
          },
        ),
    )
  }
  await prepare(dir, cwd)
  const next: TaskWorktree = {
    ...wt,
    path: dir,
    branch,
    baseBranch: baseBranch === 'HEAD' ? '' : baseBranch,
    state: 'active',
    note: '',
  }
  return { worktree: next, rebuilt: true }
}

/** 没配置 git 用户时用面板的身份提交，免得提交失败 */
async function identity(cwd: string) {
  const email = (await git(cwd, 'config', 'user.email')).stdout.trim()
  return email ? [] : ['-c', 'user.name=Agent Panel', '-c', 'user.email=agent-panel@localhost']
}

/**
 * 合并：先把独立目录里还没提交的改动提交到任务分支，再合并进目标目录当前所在的分支。
 * target 默认是项目目录；子对话传父对话的目录，合成「子 → 父 → 项目」的顺序。
 * 有冲突时放弃这次合并，目标目录保持原样，返回冲突的说明。keep 为 false 时成功后删掉独立目录和分支。
 */
export async function mergeWorktree(repo: string, wt: TaskWorktree, message: string, target = repo, keep = false) {
  await commitWorktree(wt, message)
  const into = (await git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  // 从哪开的分支就合回哪：原目录后来换了分支就不合，免得合到别的分支上
  if (wt.baseBranch && into !== wt.baseBranch)
    throw new Error(
      t('原目录现在在「{now}」，不是开分支时的「{base}」，没有合并。切回「{base}」后再合并。', {
        now: into || 'HEAD',
        base: wt.baseBranch,
      }),
    )
  const m = await git(target, ...(await identity(target)), 'merge', '--no-ff', '--no-edit', '-m', message, wt.branch)
  if (m.code !== 0) {
    await git(target, 'merge', '--abort')
    throw Object.assign(
      new Error(
        t('合并到「{branch}」时有冲突或那个目录里有未提交的改动挡住了，目录没有改动。可以在那里手动合并分支 {name}。', {
          branch: into,
          name: wt.branch,
        }) + `\n\n${(m.stderr || m.stdout).trim().split('\n').slice(-6).join('\n')}`,
      ),
      { conflict: true },
    )
  }
  if (!keep) await removeWorktree(repo, wt, false)
  return into
}

/** 独立分支现在的情况：目录还在不在、比原分支多几个提交、有几个没提交的文件、是不是已经都合回原分支 */
export interface WorktreeStatus {
  exists: boolean
  /** 分支还在 */
  branch: boolean
  /** 原分支里还没有的提交数 */
  ahead: number
  /** 独立目录里没提交的文件数 */
  dirty: number
  /**
   * 改动都已经在原分支里了（没有改动也算）。
   * 判定的依据是 ahead 和 dirty，不是 task.worktree.state：分支被删掉之后 state 常常还停在 active
   * （手动删了分支、面板合并后清掉了目录），只看 state 会把「已合回原分支」显示成「未合并」
   */
  merged: boolean
}

export async function worktreeStatus(repo: string, wt: TaskWorktree): Promise<WorktreeStatus> {
  const exists = existsSync(wt.path)
  const has = (await git(repo, 'rev-parse', '-q', '--verify', `refs/heads/${wt.branch}`)).code === 0
  let dirty = 0
  if (exists) {
    const st = await git(wt.path, 'status', '--porcelain')
    dirty = st.code === 0 ? st.stdout.split('\n').filter((l) => l.trim()).length : 0
  }
  if (!has) {
    // 分支已经不在了：没提交的改动就再也提交不了，剩下的只能按任务记录的状态判断。
    // active 还留着分支被删的残留（面板合并、submit_build 之后手动清理过），算改动已经进了原分支；
    // discarded 是用户主动丢弃，仍然算没合并。
    const merged = wt.state !== 'discarded' && dirty === 0
    return { exists, branch: false, ahead: 0, dirty, merged }
  }
  // 不知道从哪开的（分离 HEAD）、或者开分支时的那个分支后来被删了：和项目目录现在的提交比，
  // 不然 rev-list 直接失败，会被当成 ahead=0 而误判成已合并
  const baseAlive = wt.baseBranch
    ? (await git(repo, 'rev-parse', '-q', '--verify', `refs/heads/${wt.baseBranch}`)).code === 0
    : false
  const base = baseAlive ? wt.baseBranch : 'HEAD'
  const r = await git(repo, 'rev-list', '--count', `${base}..refs/heads/${wt.branch}`)
  const ahead = r.code === 0 ? Number(r.stdout.trim()) || 0 : 0
  return { exists, branch: true, ahead, dirty, merged: ahead === 0 && dirty === 0 }
}

/**
 * 删掉一个独立目录。早先开的独立目录里 node_modules 是指向项目的链接（见 prepare 的迁移），
 * 先解开链接再递归删，免得顺着链接把项目的依赖一起删掉
 */
async function wipe(dir: string) {
  if (!existsSync(dir)) return
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const full = path.join(dir, name)
    if ((await lstat(full).catch(() => null))?.isSymbolicLink()) await rm(full, { force: true }).catch(() => {})
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** 删掉独立目录；force 时连分支一起删（丢弃），否则分支已经合并，用 -d 删 */
export async function removeWorktree(repo: string, wt: TaskWorktree, force: boolean) {
  await git(repo, 'worktree', 'remove', '--force', wt.path)
  await wipe(wt.path)
  await git(repo, 'worktree', 'prune')
  await git(repo, 'branch', force ? '-D' : '-d', wt.branch)
}

/**
 * 子对话彻底完成后回收独立分支：还差条件（见 shared/task.ts 的 childHolds）就原样保留，返回原因；
 * 全部满足才删掉目录和分支。合并成功、这一轮结束、后台命令结束都走这里，
 * 调用方负责先把等下一句的 CLI 和还在跑的后台命令停下来。
 */
export async function releaseWorktree(repo: string, wt: TaskWorktree, holds: ChildHold[]): Promise<string> {
  if (holds.length) return childHoldText(holds)
  // 再核一次合并状态：这里删了就找不回来了，不能只靠调用方记得传对
  const st = await worktreeStatus(repo, wt).catch(() => null)
  if (!st?.merged) return childHoldText(['unmerged'])
  await removeWorktree(repo, wt, true)
  return ''
}

/** 目录当前所在的分支；分离 HEAD 时返回空 */
export async function currentBranch(dir: string) {
  const b = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  return b === 'HEAD' ? '' : b
}

/** 独立目录里还没提交的改动提交到任务分支；没有改动返回 false */
export async function commitWorktree(wt: TaskWorktree, message: string) {
  if (!existsSync(wt.path)) return false
  await git(wt.path, 'add', '-A')
  if ((await git(wt.path, 'diff', '--cached', '--quiet')).code === 0) return false
  const c = await git(wt.path, ...(await identity(wt.path)), 'commit', '-q', '-m', message)
  if (c.code !== 0) throw fail(c, t('提交改动失败'))
  return true
}

/**
 * 试合并：把分支合进目标目录但先不提交（编译通过再提交，失败就撤回）。
 * 有冲突时直接撤回，目标目录保持原样；分支没有新提交时返回 nothing
 */
export async function trialMerge(target: string, branch: string) {
  const m = await git(target, ...(await identity(target)), 'merge', '--no-commit', '--no-ff', branch)
  if (m.code !== 0) {
    const conflicts = (await git(target, 'diff', '--name-only', '--diff-filter=U')).stdout.trim()
    // 合并根本没开始：原目录里没提交的改动会被覆盖，git 直接拒绝，不是两个分支之间的冲突
    const dirty =
      !conflicts && /would be overwritten|会被合并覆盖|untracked working tree files/.test(m.stderr + m.stdout)
    await abortMerge(target)
    return {
      ok: false as const,
      dirty,
      error:
        (conflicts ? `冲突的文件：\n${conflicts}\n\n` : '') +
        (m.stderr || m.stdout).trim().split('\n').slice(-6).join('\n'),
    }
  }
  const pending = (await git(target, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).code === 0
  const files = (await git(target, 'diff', '--cached', '--name-only')).stdout.trim()
  return { ok: true as const, nothing: !pending, files: files ? files.split('\n') : [] }
}

/**
 * 合并前看一眼目标目录：有没做完的合并，或者暂存区里有别人的改动时不能合——
 * 合并提交会把暂存区一起带进去，撤回时也可能连带清掉。返回不能合的原因，能合时返回空字符串
 */
export async function mergeBlocker(target: string) {
  if ((await git(target, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).code === 0)
    return '原目录里有一次没做完的合并（MERGE_HEAD 还在）'
  const staged = (await git(target, '-c', 'core.quotepath=off', 'diff', '--cached', '--name-only')).stdout.trim()
  if (staged) return `原目录的暂存区里有还没提交的改动：\n${staged.split('\n').slice(0, 20).join('\n')}`
  return ''
}

/** 试合并通过后提交 */
export async function commitMerge(target: string, message: string) {
  const c = await git(target, ...(await identity(target)), 'commit', '-q', '--no-edit', '-m', message)
  if (c.code !== 0) throw fail(c, t('提交改动失败'))
  return (await git(target, 'rev-parse', '--short', 'HEAD')).stdout.trim()
}

/** 撤回试合并：目标目录回到合并前的样子 */
export async function abortMerge(target: string) {
  if ((await git(target, 'merge', '--abort')).code !== 0) await git(target, 'reset', '--merge')
}
