import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  rm,
  symlink,
  appendFile,
  lstat,
  readFile,
  readlink,
  rename,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
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
/**
 * 在主仓库里跑 git 时显式指定 work-tree：.git/config 里的 core.worktree 可能被别的平台写成
 * /mnt/...（本机真实遇到过），不指定的话 rev-parse / rev-list 全部报 Invalid path。
 */
const gitRepo = (repo: string, ...args: string[]) => git(repo, '--work-tree', repo, ...args)
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

/**
 * node_modules 只放一份在项目分组目录下（见 sharedDepsDir）：Node / npm 会沿目录向上找最近的
 * node_modules，独立目录里既不放目录也不建链接。其他依赖目录（Python venv、PHP vendor）按自己的
 * 路径找，不能共用，仍然各复制一份。
 */
const HOISTED_DEPS = 'node_modules'
const LOCAL_DEP_DIRS = ['.venv', 'venv', 'vendor']

/**
 * 项目根：按 git common dir 的父目录算。子对话从父对话的独立目录里开时（worktreeHome），
 * 也是同一个主仓库、同一个项目，依赖不会分家；不是 git 仓库时用传进来的目录。
 */
async function repoRoot(repo: string) {
  const common = (await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')).stdout.trim()
  return path.resolve(common ? path.dirname(common) : repo)
}

/**
 * 每个项目一组目录：worktrees/<项目>-<路径哈希>/<任务 id>。
 * 依赖按项目分开是有必要的：数据目录里会有多个项目，共用一个位置时后开的项目会把前一个的依赖换掉。
 * 路径哈希让同名但不同路径的项目也能分开（Windows 路径不分大小写，和 normPath 口径一致）。
 */
const repoKey = async (repo: string) => {
  const abs = await repoRoot(repo)
  const name =
    path
      .basename(abs)
      .replace(/[^\w.-]+/g, '-')
      .slice(0, 40) || 'repo'
  const hash = createHash('sha1')
    .update(process.platform === 'win32' ? abs.toLowerCase() : abs)
    .digest('hex')
    .slice(0, 8)
  return `${name}-${hash}`
}

/** 任务的独立目录：项目分组目录下按任务 id 建 */
const taskDir = async (repo: string, taskId: string) => path.join(WORKTREES_DIR, await repoKey(repo), taskId)

/**
 * 共用依赖放在每条独立目录的上级，Node / npm 才找得到（同一个项目的子对话共用一份）。
 * 每个子对话各复制一份时，本机 600MB / 2.7 万个文件实测 12–20 秒，6 个并行要写约 4GB；
 * 共用一份只付一次，之后开子对话的依赖成本接近 0。
 * 和 2026-10 事故（把项目那份链接进子对话，npm 按分支的 package.json 修剪掉真目录）的区别：
 * 子对话里既没有 node_modules 目录也没有链接，npm install 的 prefix 是它自己的 package.json，
 * 写出来的是它自己目录下的新目录，动不到共用的这一份。
 */
export const sharedDepsDir = async (repo: string) => path.join(WORKTREES_DIR, await repoKey(repo), HOISTED_DEPS)

/** 共用依赖目录里记录「按哪份 lock 复制的」：lock 变了才重新复制 */
const DEPS_MARK = '.agent-panel-deps.json'
/** 复制共用依赖时占位 / 临时用的目录：清扫时要跳过（见 sweepWorktrees） */
const DEPS_LOCK = `${HOISTED_DEPS}.lock`
const DEPS_TMP_PREFIX = `${HOISTED_DEPS}.tmp-`
/** 复制期间每多久更新一次锁的时间（心跳）：进程被杀后别人靠它判断锁已经没人了 */
const DEPS_HEARTBEAT_MS = 2_000
/** 锁这么久没更新就当复制方已经没了（进程被杀、面板重启），可以直接抢 */
const DEPS_LOCK_DEAD_MS = 15_000
/** 等别人复制完最多等多久：大项目 + 慢盘也够；等不到再抢一次锁，两次都不行就记 warn 让这个目录自己装 */
const DEPS_WAIT_MS = 90_000
const DEPS_WAIT_STEP_MS = 200
/** 换上新的一份时 Windows 上刚复制完的目录偶尔还被扫描 / 句柄占着：改名失败时等一会儿再试 */
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 150

/** 一批复制多少个文件：27k 个文件、600MB 的 node_modules 实测 12–20 秒，再往上并发提升不明显 */
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

/** 共用依赖是按哪个文件复制的：锁文件和 package.json 的大小、修改时间 */
interface DepsStamp {
  source: string
  size: number
  mtimeMs: number
}

const sameStamp = (a: DepsStamp | null, b: DepsStamp | null) =>
  !!a && !!b && a.source === b.source && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1

/** 判断共用依赖要不要重做：优先 package-lock，没有就用 package.json，再没有就用依赖目录本身 */
async function depsStamp(root: string): Promise<DepsStamp | null> {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'package.json', HOISTED_DEPS]) {
    const st = await stat(path.join(root, name)).catch(() => null)
    if (st) return { source: name, size: st.size, mtimeMs: Math.round(st.mtimeMs) }
  }
  return null
}

/** 共用依赖现在这一份是按什么复制的；读不到记录时返回 null */
async function sharedDepsStamp(shared: string): Promise<DepsStamp | null> {
  const text = await readFile(path.join(shared, DEPS_MARK), 'utf8').catch(() => '')
  if (!text) return null
  try {
    const mark = JSON.parse(text) as DepsStamp
    return typeof mark?.source === 'string' ? mark : null
  } catch {
    return null
  }
}

/** 共用依赖存在，而且是按现在这份 lock 复制的 */
async function sharedDepsReady(shared: string, stamp: DepsStamp | null) {
  if (!stamp || !existsSync(shared)) return false
  return sameStamp(await sharedDepsStamp(shared), stamp)
}

/** 抢复制锁：mkdir 是原子的，同一个项目的多个子对话同时开时只有一个去复制，其余等它 */
async function acquireDepsLock(group: string, lock: string) {
  await mkdir(group, { recursive: true })
  const st = await lstat(lock).catch(() => null)
  // 复制方每 2 秒更新一次锁的时间：很久没更新说明它已经没了，把锁挪走重抢。
  // 用 rename 接替过期的锁是原子的：不能先 rm 再 mkdir——两个调用方同时看到同一把过期锁时，
  // 都会删掉对方刚建的那把、各自都以为拿到了锁，然后两个进程同时复制 682MB，
  // 换装时还会互相把对方刚放好的那一份挪走。rename 失败的说明锁已经被别人接走，直接去竞争 mkdir。
  if (st && Date.now() - st.mtimeMs > DEPS_LOCK_DEAD_MS) {
    const stale = `${lock}.stale-${process.pid}-${Date.now()}`
    if (
      await rename(lock, stale).then(
        () => true,
        () => false,
      )
    )
      await rm(stale, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {})
  }
  return mkdir(lock).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      // 已经被别人占着是正常情况；其他错误（权限、磁盘）也按「没抢到」处理，等超时后记 warn
      if (e.code !== 'EEXIST') log.warn('worktree', '建不了共用依赖的复制锁', { dir: lock, error: e.message })
      return false
    },
  )
}

/** 等别人复制完：返回就绪 / 锁没了（可以重新抢） / 超时 */
async function waitSharedDeps(shared: string, stamp: DepsStamp | null, lock: string) {
  const until = Date.now() + DEPS_WAIT_MS
  while (Date.now() < until) {
    if (await sharedDepsReady(shared, stamp)) return 'ready'
    const st = await lstat(lock).catch(() => null)
    // 锁没了，或者复制方已经很久没心跳（进程被杀、面板重启）：重新抢，不要干等到超时
    if (!st || Date.now() - st.mtimeMs > DEPS_LOCK_DEAD_MS) return 'gone'
    await new Promise((r) => setTimeout(r, DEPS_WAIT_STEP_MS))
  }
  return 'timeout'
}

/** 改名带重试：Windows 上刚复制完的目录偶尔还被扫描 / 句柄占着。返回空串表示成功，否则是最后一次的错误 */
async function renameDir(from: string, to: string) {
  let last = ''
  for (let i = 0; i < RENAME_ATTEMPTS; i++) {
    try {
      await rename(from, to)
      return ''
    } catch (e) {
      last = (e as Error).message
    }
    if (i < RENAME_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, RENAME_RETRY_MS))
  }
  return last || '改名失败'
}

/**
 * 用新复制的一份换掉旧的：先把旧的改名挪开、再把新的改名进来，最后删旧的。
 * 不能先删旧的再改名：删到一半失败（Windows 上子对话正在读里面的文件）会留下残缺的一份，
 * 同项目的所有子对话都会缺包。换装失败会回滚（新的改名失败就把旧的放回去），
 * 两次 rename 之间有一个很短的窗口 shared 不在，期间新起的命令会暂时找不到依赖；
 * 成功后就是完整的新版，不会出现「半新半旧」。
 */
async function replaceSharedDeps(shared: string, tmp: string) {
  const old = `${shared}.old-${Date.now()}`
  const moved = existsSync(shared)
  if (moved) {
    const err = await renameDir(shared, old)
    if (err) {
      // 旧的还在原地、没被动过：这轮先用旧的
      log.warn('worktree', '旧的共用依赖正被使用，这次先不换', { dir: shared, error: err })
      return false
    }
  }
  const err = await renameDir(tmp, shared)
  if (err) {
    if (moved) await renameDir(old, shared)
    log.warn('worktree', '共用依赖改名失败，这轮先用旧的', { dir: shared, error: err })
    return false
  }
  // 旧的一份可能正被别的子对话读着（Windows 上删不掉）：留着，下次准备时再清
  if (moved) await rm(old, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {})
  return true
}

/** 上次换装没删掉的旧份（node_modules.old-<时间戳>）：删得掉就删，删不掉下次再试 */
async function cleanOldDeps(shared: string) {
  const prefix = `${path.basename(shared)}.old-`
  const group = path.dirname(shared)
  for (const name of await readdir(group).catch(() => [] as string[])) {
    if (!name.startsWith(prefix)) continue
    await rm(path.join(group, name), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {})
  }
}

/** 复制一份到共用的依赖目录（同项目、同 lock 只做一次）；失败时清掉临时目录、保留旧的一份 */
async function copySharedDeps(shared: string, from: string, stamp: DepsStamp | null, lock: string) {
  const group = path.dirname(shared)
  const tmp = path.join(group, `${DEPS_TMP_PREFIX}${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  const started = Date.now()
  // 复制期间定时更新锁的时间：进程被杀后等待方不用干等到超时
  const beat = setInterval(() => {
    const now = new Date()
    utimes(lock, now, now).catch(() => {})
  }, DEPS_HEARTBEAT_MS)
  try {
    const files = await cloneDir(from, tmp).catch(async (e: Error) => {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      log.warn('worktree', '依赖没复制到共用目录，这个子对话要自己装', { from, error: e.message })
      return 0
    })
    if (!files) return false
    if (stamp) await writeFile(path.join(tmp, DEPS_MARK), JSON.stringify(stamp)).catch(() => {})
    if (!(await replaceSharedDeps(shared, tmp))) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      log.warn('worktree', '共用依赖没能换成新的一份，这轮先用旧的', { dir: shared, stamp })
      return false
    }
    await cleanOldDeps(shared)
    log.info('worktree', '依赖复制到共用目录（同项目的子对话不再各复制一份）', {
      dir: shared,
      files,
      ms: Date.now() - started,
    })
    return true
  } finally {
    clearInterval(beat)
  }
}

/**
 * 准备共用的依赖：项目里有 node_modules 时复制一份到项目的分组目录下，只在 lock 变化时重做。
 * 项目自己没装依赖时什么都不做（返回 missing），由子对话按需自己装。
 */
export async function ensureSharedDeps(repo: string): Promise<'ready' | 'copied' | 'missing' | 'failed'> {
  // 源目录和 lock 都按项目根读：传进来的可能是父对话的独立目录（那里没有 node_modules，
  // 不归一化的话会当成「项目没装依赖」，从父对话里开的子对话就不会刷新依赖）
  const root = await repoRoot(repo)
  const from = path.join(root, HOISTED_DEPS)
  if (!existsSync(from)) return 'missing'
  const shared = await sharedDepsDir(repo)
  const group = path.dirname(shared)
  const lock = path.join(group, DEPS_LOCK)
  // 分组回退到 repo 本身时（不是 git 仓库、读不到 common dir）别把自己复制给自己
  if (path.resolve(from) === path.resolve(shared)) return 'ready'
  // 抢锁失败就等：锁没了（上一次复制被杀、面板重启）就再抢一次，最多两轮，不干等满超时
  for (let attempt = 0; attempt < 2; attempt++) {
    const stamp = await depsStamp(root)
    if (await sharedDepsReady(shared, stamp)) {
      await cleanOldDeps(shared)
      return 'ready'
    }
    if (!(await acquireDepsLock(group, lock))) {
      if ((await waitSharedDeps(shared, stamp, lock)) === 'ready') return 'ready'
      continue
    }
    try {
      // 等锁的时候别人可能已经复制好了（含 lock 刚被改过的情况）
      const now = await depsStamp(root)
      if (await sharedDepsReady(shared, now)) return 'ready'
      if (!(await copySharedDeps(shared, from, now, lock))) return 'failed'
      return 'copied'
    } finally {
      await rm(lock, { recursive: true, force: true }).catch(() => {})
    }
  }
  return 'failed'
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

/** 从 dir 向上找最近的 node_modules：独立目录里不再各放一份，靠的就是祖先这一份 */
function nearestNodeModules(dir: string) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    const nm = path.join(at, HOISTED_DEPS)
    if (existsSync(nm)) return nm
    if (path.dirname(at) === at) return ''
  }
}

/**
 * package.json 里声明、但 node_modules 里没装上的包。
 * 依赖目录被某个工作目录跑安装/清理修剪掉之后，后面的命令只会各自报「找不到模块」；
 * 开独立目录时先看一眼，直接把「哪个目录、少了什么、怎么补」写进面板日志。
 */
export async function missingDeps(dir: string) {
  const pkg = await packageJson(dir)
  if (!pkg) return []
  const nm = nearestNodeModules(dir)
  if (!nm) return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  const want = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  return want.filter((name) => !existsSync(path.join(nm, name, 'package.json')))
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
 * 早先开的工作目录里各有一份 node_modules（副本，或指向项目的链接——2026-10 事故的来源）。
 * 现在改用共用的一份（见 ensureSharedDeps），准备目录时把旧的清掉：链接只删链接本身、不删目标，副本直接删省磁盘。
 * 只在这个目录刚被再次准备时调用（新建、重建），不会动正在跑命令的目录。
 */
async function dropCopiedDeps(dir: string) {
  const mine = path.join(dir, HOISTED_DEPS)
  const st = await lstat(mine).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink()) {
    await rm(mine, { force: true }).catch(() => {})
    return
  }
  // 旧布局的任务目录（worktrees/<任务 id>）不在项目分组目录下，删了自己这份就向上找不到了：
  // 只有上级已经有可用的一份时才删（新布局 <项目分组>/<任务 id> 才有）
  if (!nearestNodeModules(path.dirname(dir))) return
  await rm(mine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((e: Error) => {
    log.warn('worktree', '旧的依赖副本没删掉，先用共用的一份', { dir: mine, error: e.message })
  })
}

/**
 * 独立目录里不能共用的依赖目录（.venv / venv / vendor）各复制一份，并清掉旧版的 node_modules 副本。
 * 返回复制过去的目录名（写进 git exclude 用）。复制失败不算错：Agent 自己在独立目录里也会看到缺什么。
 */
export async function isolateDeps(dir: string, repo: string) {
  await dropCopiedDeps(dir)
  const prepared: string[] = []
  for (const name of LOCAL_DEP_DIRS) {
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

/** 独立目录的准备工作：依赖共用一份（见 ensureSharedDeps），环境文件复制一份——含密钥的 .env.local 等不复制 */
async function prepare(dir: string, repo: string) {
  // 先准备共用的一份（第一次开子对话时付一次复制成本），再清理旧布局里各目录的副本
  const shared = await ensureSharedDeps(repo)
  if (shared === 'failed') log.warn('worktree', '共用依赖没准备好，这个子对话里要自己装', { repo })
  const prepared = await isolateDeps(dir, repo)
  // 项目没忽略这些目录时，合并前的 git add -A 会把整个依赖装进提交：写进这个工作目录自己的 exclude。
  // node_modules 也要写：子对话里自己 npm install 会建一份（项目漏写 .gitignore 时不能让它进提交）
  for (const name of new Set([HOISTED_DEPS, ...prepared])) {
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

/** UE 这类大项目：项目目录或仓库根目录里有 .uproject（UE 项目的编译也按这个判断归父对话） */
export async function isBigProject(repo: string) {
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
  const dir = await taskDir(repo, taskId)
  await mkdir(path.dirname(dir), { recursive: true })
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
  return (await gitRepo(cwd, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`)).code === 0
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
  const dir = wt.path || (await taskDir(cwd, taskId))
  if (existsSync(dir) && (await hasBranch(cwd, branch))) return { worktree: wt, rebuilt: false }
  const baseBranch = (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  const branchAlive = await hasBranch(cwd, branch)
  // 目录还在、分支没了这种不一致：先把残留目录清掉，否则 worktree add 会因为目录已存在失败
  await wipe(dir)
  // 目录是手动删掉的时候，git 里还登记着这个工作区：先 prune，不然同名分支会被当成「已经在别处检出」
  await git(cwd, 'worktree', 'prune')
  await mkdir(path.dirname(dir), { recursive: true })
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

/**
 * 两个提交（分支）从共同基点起都改过的文件。
 * git 只在同一处改动上报冲突：一方在文件上面加了一段、另一方改了文件的另一个函数，合并会静默成功，
 * 看起来没冲突，实际上两边改的是同一个文件。合并前后都拿这份交集提示「两边都动过，核对有没有盖掉对方的改动」。
 * 读不出来（分支已删、共同基点找不到）时返回空数组：算不出重叠不能挡住合并。
 */
export async function branchesOverlap(repo: string, a: string, b: string): Promise<string[]> {
  const mb = await git(repo, 'merge-base', a, b)
  const base = mb.code === 0 ? mb.stdout.trim() : ''
  if (!base) return []
  const list = async (to: string) => {
    // -z 按 NUL 分隔、不做路径转义：文件名带中文和空格也不会被拆错
    const r = await git(repo, 'diff', '-z', '--name-only', base, to)
    return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : null
  }
  const [mine, theirs] = await Promise.all([list(a), list(b)])
  if (!mine || !theirs) return []
  const also = new Set(theirs)
  return mine.filter((f) => also.has(f)).sort()
}

/** 本分支和目标目录现在所在分支都改过的文件（见 branchesOverlap） */
export function mergeOverlap(target: string, branch: string): Promise<string[]> {
  return branchesOverlap(target, 'HEAD', branch)
}

/** 合并双方各自做了什么：各有哪些提交、改了哪些文件 */
export interface MergeSide {
  /** 分支名；目标目录分离 HEAD 时是 HEAD */
  branch: string
  /** 比共同基点多的提交数 */
  count: number
  /** 这些提交，一行一个「短 hash 标题」（最多列 MAX_SIDE_COMMITS 条） */
  commits: string[]
  /** 这个分支改过的文件 */
  files: string[]
}

/** 合并前两边的情况：交给接手合并的一方看懂双方意图，见 project-vcs 技能的「合并审查」 */
export interface MergeSides {
  /** 共同基点 */
  base: string
  /** 目标目录现在所在的分支（改动要合进来的那一边） */
  into: MergeSide
  /** 要合进来的分支 */
  by: MergeSide
  /** 两边都改过的文件：git 自动合上也可能互相盖掉，必须逐文件核对 */
  overlap: string[]
}

/** 最多列多少条提交：多了会把交回给子对话的信息撑很长，超出部分让接手的人自己看 git log */
const MAX_SIDE_COMMITS = 20

/**
 * 合并前把两边各自的提交记录和改动文件算出来。
 * 只告诉接手方「哪些文件冲突」不够：看不到对方为什么这么改，就分不清该保留哪段意图、哪些是已经废弃的旧实现，
 * 结果要么两套并存、要么把对方真正需要的内容合丢。合完目标目录已经是合并后的提交，比不出来，必须在合并前取。
 */
export async function mergeSides(target: string, branch: string): Promise<MergeSides> {
  const mb = await git(target, 'merge-base', 'HEAD', branch)
  const base = mb.code === 0 ? mb.stdout.trim() : ''
  if (!base) throw new Error(t('算不出两个分支的共同基点，给不出双方的提交记录'))
  const side = async (ref: string, name: string): Promise<MergeSide> => {
    const log = await git(target, 'log', '--format=%h %s', `${base}..${ref}`)
    const commits = log.code === 0 ? log.stdout.split('\n').filter(Boolean) : []
    // -z 按 NUL 分隔、不做路径转义：文件名带中文和空格也不会被拆错
    const list = await git(target, 'diff', '-z', '--name-only', base, ref)
    return {
      branch: name,
      count: commits.length,
      commits: commits.slice(0, MAX_SIDE_COMMITS),
      files: list.code === 0 ? list.stdout.split('\0').filter(Boolean) : [],
    }
  }
  const into = await currentBranch(target)
  const [mine, theirs] = await Promise.all([side('HEAD', into || 'HEAD'), side(branch, branch)])
  const also = new Set(theirs.files)
  return { base, into: mine, by: theirs, overlap: mine.files.filter((f) => also.has(f)).sort() }
}

/**
 * 双方的提交记录写成给接手方看的几行：各自动了什么、各为什么（提交说明），以及两边都动过的地方必须核对。
 * 接在冲突提示和「自动合并但两边都改过同一文件」的提示后面，让接手的人有依据判断，而不是只看 diff 拍脑袋。
 */
export function mergeSidesText(sides: MergeSides): string {
  const side = (s: MergeSide) => {
    const more =
      s.count > s.commits.length
        ? t('（还有 {n} 个提交没列出，需要时自己看 git log）', { n: String(s.count - s.commits.length) })
        : ''
    return (
      t('·「{branch}」{count} 个提交，改 {files} 个文件：{commits}', {
        branch: s.branch,
        count: String(s.count),
        files: String(s.files.length),
        commits: s.commits.join('；') || t('没有提交'),
      }) + more
    )
  }
  const lines = [
    t('双方的提交记录（合并前先看清各自为什么这么改，按 project-vcs 技能 git.md 的「合并审查」做）：'),
    side(sides.into),
    side(sides.by),
  ]
  if (sides.overlap.length)
    lines.push(
      t('两边都改过这些文件：{list}。必须逐文件核对有没有盖掉对方的改动，核对结论写进合并结论。', {
        list:
          sides.overlap.slice(0, 20).join('、') + (sides.overlap.length > 20 ? ` 等 ${sides.overlap.length} 个` : ''),
      }),
    )
  return lines.join('\n')
}

/**
 * 合并失败是不是因为 index.lock 被别的 git 进程占着。新一点的 git（2.43 起）合并前先跑 `git stash create`，
 * 撞上锁时报的是「fatal: stash failed」而不是 index.lock：只认 index.lock 的话会把它当成冲突报给子对话
 * （本机 git 2.43 实测）。stash failed 的原因不止锁，所以只在锁文件真的在时才算
 */
async function lockBusy(target: string, stderr: string) {
  if (/index\.lock|Unable to write index/.test(stderr)) return true
  if (!/stash failed/.test(stderr)) return false
  const lock = (await git(target, 'rev-parse', '--git-path', 'index.lock')).stdout.trim()
  return !!lock && existsSync(path.resolve(target, lock))
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
  // 合并前记下两边都改过的文件和各自的提交记录：合完目标目录已经是合并后的提交，比不出来
  const sides = await mergeSides(target, wt.branch).catch(() => null)
  const overlap = sides?.overlap ?? []
  // 冲突时把双方的提交记录一起交回：只给冲突文件的话，接手的人看不到对方为什么这么改
  const about = sides ? `\n\n${mergeSidesText(sides)}` : ''
  const args = [...(await identity(target)), 'merge', '--no-ff', '--no-edit', '-m', message, wt.branch]
  let m = await git(target, ...args)
  // 别的 git 进程（Agent 自己的 git add / commit、面板的状态查询）正好占着 index.lock：合并根本没开始，
  // 不是冲突，等一下重试；直接报「有冲突」会让父对话、子对话去处理一个不存在的冲突
  // 写索引那一步才撞上锁时 git 已经留下了 MERGE_HEAD：先撤掉这次没合成的，再重来（撤也撞锁就下一圈再撤）
  for (let i = 1; m.code !== 0 && i <= 5 && (await lockBusy(target, m.stderr)); i++) {
    await new Promise((r) => setTimeout(r, 200 * i))
    const head = (await git(target, 'rev-parse', '--git-path', 'MERGE_HEAD')).stdout.trim()
    if (head && existsSync(path.resolve(target, head)) && (await git(target, 'merge', '--abort')).code !== 0) continue
    m = await git(target, ...args)
  }
  if (m.code !== 0) {
    await git(target, 'merge', '--abort')
    throw Object.assign(
      new Error(
        t('合并到「{branch}」时有冲突或那个目录里有未提交的改动挡住了，目录没有改动。可以在那里手动合并分支 {name}。', {
          branch: into,
          name: wt.branch,
        }) +
          `\n\n${(m.stderr || m.stdout).trim().split('\n').slice(-6).join('\n')}` +
          about,
      ),
      { conflict: true, sides },
    )
  }
  if (!keep) {
    const problem = await removeWorktree(repo, wt, false)
    if (problem) log.warn('worktree', '合并成功但独立目录没删掉，下次回收时再试', { dir: wt.path, error: problem })
  }
  return { into, overlap, sides }
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
    // 只读：status 默认会顺手刷新索引并加锁，子对话栏轮询时和 CLI 自己的 git add/commit 抢 index.lock
    const st = await git(wt.path, '--no-optional-locks', 'status', '--porcelain')
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
 * 刚删完时 Windows 上目录可能还会短暂出现（杀毒软件扫描、句柄释放延迟）：
 * 等一小会儿再判，不要把一个刚删掉的目录记成失败、下一轮又完整再扫一遍。
 */
async function gone(dir: string): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    if (!existsSync(dir)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !existsSync(dir)
}

/**
 * 删掉一个独立目录。早先开的独立目录里 node_modules 是指向项目的链接（见 prepare 的迁移），
 * 先解开链接再递归删，免得顺着链接把项目的依赖一起删掉。
 * 返回没删掉的原因（空字符串表示删干净了）：Windows 上文件被占用（CLI 正在退出、杀毒软件扫描）
 * 时删不掉是常事，吞掉失败会让目录留在磁盘上、任务却被标成「已回收」。
 */
async function wipe(dir: string): Promise<string> {
  if (!existsSync(dir)) return ''
  const problems: string[] = []
  const note = (what: string, e: unknown) => problems.push(`${what}：${(e as Error).message}`)
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const full = path.join(dir, name)
    if (!(await lstat(full).catch(() => null))?.isSymbolicLink()) continue
    await rm(full, { force: true }).catch((e: Error) => note(`${name}（链接）`, e))
  }
  // 句柄可能刚被放开：重试几次再判失败（Windows 上杀毒软件扫描大目录时尤其明显）
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((e: Error) => note(dir, e))
  return problems.join('；')
}

/**
 * 删掉独立目录；force 时连分支一起删（丢弃），否则分支已经合并，用 -d 删。
 * 返回没删掉的原因（空字符串表示目录和分支都清干净了）。git 报错不一定真失败：
 * 目录被手动删过时 worktree remove 会报「不是工作树」，以最后的实际状态为准。
 */
export async function removeWorktree(repo: string, wt: TaskWorktree, force: boolean): Promise<string> {
  const problems: string[] = []
  const r = await git(repo, 'worktree', 'remove', '--force', wt.path)
  const why = (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')
  const wiped = await wipe(wt.path)
  if (wiped) problems.push(wiped)
  // git 的报错不一定真失败：目录已经手动删过、core.worktree 被写坏时 worktree remove 都会报错。
  // 以最后的实际状态为准，只有目录真没删掉才把 git 的原因附上
  if (!(await gone(wt.path))) problems.push(`目录还在：${wt.path}${why ? `（${why}）` : ''}`)
  await git(repo, 'worktree', 'prune')
  if (await hasBranch(repo, wt.branch)) {
    const b = await gitRepo(repo, 'branch', force ? '-D' : '-d', wt.branch)
    if (b.code !== 0 && (await hasBranch(repo, wt.branch)))
      problems.push(`删分支 ${wt.branch}：${(b.stderr || b.stdout).trim().split('\n').slice(-2).join(' ')}`)
  }
  return problems.join('；')
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
  const problems = await removeWorktree(repo, wt, true)
  if (!problems) return ''
  // 不抛错：调用方（server/tasks.ts 的 completeChild）把抛错当成「回收完了」吞掉，失败会被藏起来。
  // 返回非空原因让它按「还没收口」处理：任务不会被标成干净回收，下一轮还会再试一次。
  log.error('worktree', '独立目录或分支没删掉，任务不算回收完成', {
    dir: wt.path,
    branch: wt.branch,
    error: problems,
  })
  return t('独立目录没删掉：{error}。等文件不再被占用后再标记一次完成，或者手动删掉 {dir} 和分支 {branch}', {
    error: problems,
    dir: wt.path,
    branch: wt.branch,
  })
}

/** 一条独立目录的清理判定 */
export interface SweepItem {
  /** 目录名就是任务 id */
  taskId: string
  dir: string
  branch: string
  /** orphan：git 注册表外的残留；merged：改动都已合回原分支、任务也已收口 */
  kind: 'orphan' | 'merged'
  /** 判定依据，写进日志和 dry-run 清单 */
  reason: string
}

export interface SweepResult {
  dryRun: boolean
  /** 判定可以清、已经清掉的（dryRun 时是「会清掉的」） */
  removed: SweepItem[]
  /** 判定不能碰的 */
  kept: { dir: string; taskId: string; why: string }[]
  /** 判定能清但没删掉的 */
  failed: { dir: string; error: string }[]
}

/** 清理判定要用到的任务信息，由调用方从任务记录里取（worktree.ts 不依赖任务存储） */
export interface SweepTaskInfo {
  /**
   * 任务已经结束：显式收口（标记完成 / 归档），或这一轮已经跑完、被停掉（status done / stopped）。
   * 还在等下一句、预热中的不算——那种是 CLI 还活着，目录不能动。
   */
  done: boolean
  /** 还在跑：CLI 正在执行、等下一句、预热、后台命令还没结束 */
  working: boolean
  projectPath: string
  branch: string
  baseBranch: string
}

export interface SweepOptions {
  /** 扫哪个目录，默认 WORKTREES_DIR（测试和 dry-run 传别的） */
  root?: string
  /** 只看清单不删 */
  dryRun?: boolean
  /**
   * 目录最近这么多毫秒内被动过就先不动（默认 10 分钟）。
   * 刚建出来、刚合完的目录可能马上又要用（测试、e2e、正在收尾的子对话），晚一点再收不迟。
   */
  minAgeMs?: number
  /**
   * 任务 id → 记录。返回 null 表示记录确实不在了；抛错按「读不到，先别动」处理。
   * 不传这个函数时只清 git 注册表外的残留。
   */
  taskInfo?: (id: string) => Promise<SweepTaskInfo | null>
}

const normPath = (p: string) => {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** 目录所在主仓库的 .git 目录；不是 git 工作目录时返回空 */
async function commonGitDir(dir: string): Promise<string> {
  // --path-format=absolute 是 git 2.31 起的；旧版退回相对路径自己拼
  const abs = await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const out =
    (abs.code === 0 ? abs.stdout : '').trim() || (await git(dir, 'rev-parse', '--git-common-dir')).stdout.trim()
  return out ? path.resolve(dir, out) : ''
}

/** git 登记的工作区：路径 → 分支名（分离 HEAD 时为空）；读不出来时返回 null */
async function worktreeRegistry(repo: string, common: string): Promise<Map<string, string> | null> {
  const r = await git(repo, 'worktree', 'list', '--porcelain')
  if (r.code === 0) return parseRegistry(r.stdout)
  // git 列不出来（.git/config 里的 core.worktree 指向别的平台路径、某条注册坏掉）时：
  // 直接读 .git/worktrees 下的注册文件，免得把整个仓的目录都当成「不在注册表里」误清
  const map = new Map<string, string>()
  const dir = path.join(common, 'worktrees')
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const meta = path.join(dir, name)
    const at = (await readFile(path.join(meta, 'gitdir'), 'utf8').catch(() => '')).trim()
    if (!at) continue
    const head = (await readFile(path.join(meta, 'HEAD'), 'utf8').catch(() => '')).trim()
    const branch = head.startsWith('ref: ') ? head.slice(5).replace(/^refs\/heads\//, '') : ''
    map.set(normPath(at.replace(/[\\/]\.git$/, '')), branch)
  }
  return map.size ? map : null
}

/** 解析 git worktree list --porcelain 的输出 */
function parseRegistry(text: string) {
  const map = new Map<string, string>()
  let at = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      at = normPath(line.slice('worktree '.length))
      map.set(at, '')
    } else if (line.startsWith('branch ') && at) {
      map.set(
        at,
        line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, ''),
      )
    }
  }
  return map
}

/**
 * 独立目录现在的实际状态（清扫用）：读不出时返回 null——
 * 不要像 worktreeStatus 那样把读失败当成 ahead=0，那会把没合的改动误判成已合并。
 */
async function worktreeFacts(repo: string, dir: string, branch: string, baseBranch: string) {
  const dirtyOut = await git(dir, '--no-optional-locks', 'status', '--porcelain')
  if (dirtyOut.code !== 0) return null
  const dirty = dirtyOut.stdout.split('\n').filter((l) => l.trim()).length
  if (!branch) return { dirty, ahead: 0 }
  // 分支已经删了：只剩目录里没提交的改动可能丢
  if (!(await hasBranch(repo, branch))) return { dirty, ahead: 0 }
  const baseAlive = baseBranch ? await hasBranch(repo, baseBranch) : false
  const base = baseAlive ? baseBranch : 'HEAD'
  const r = await gitRepo(repo, 'rev-list', '--count', `${base}..refs/heads/${branch}`)
  if (r.code !== 0) return null
  return { dirty, ahead: Number(r.stdout.trim()) || 0 }
}

/**
 * 守护式清理：扫数据目录下的独立工作目录，把没人管的收掉。
 *
 * 面板重启、父对话结束、任务记录丢了之后就不再有人触发 advanceChildTo，已合并的目录会一直留在磁盘上。
 * 判定：不在 git 注册表里的当残留清；在注册表里的要「改动都已合回原分支 + 任务已经收口」才清。
 * 有未提交改动、分支上有没合回的提交、任务还在跑的一律不碰；读不出 git 状态也按在用处理。
 * dryRun 只出清单不删；启动时和定时任务调它（见 server/index.ts）。
 */
export async function sweepWorktrees(opts: SweepOptions = {}): Promise<SweepResult> {
  const root = opts.root ?? WORKTREES_DIR
  const minAge = opts.minAgeMs ?? 10 * 60_000
  const result: SweepResult = { dryRun: opts.dryRun === true, removed: [], kept: [], failed: [] }
  const entries = await readdir(root, { withFileTypes: true }).catch((e: Error) => e)
  if (!Array.isArray(entries)) {
    if ((entries as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn('worktree', '清扫独立目录时读不到目录', { root, error: (entries as Error).message })
    return result
  }
  const drop = async (item: SweepItem, repo: string) => {
    if (result.dryRun) {
      log.info('worktree', '独立目录可以清掉（预演，没有删）', item)
      result.removed.push(item)
      return
    }
    const problem = repo
      ? await removeWorktree(
          repo,
          { path: item.dir, branch: item.branch, baseBranch: '', state: 'active', note: '' },
          true,
        )
      : await wipe(item.dir)
    if (problem || !(await gone(item.dir))) {
      const error = problem || '目录还在'
      log.error('worktree', '清扫独立目录失败，下次启动再试', { ...item, error })
      result.failed.push({ dir: item.dir, error })
      return
    }
    log.info('worktree', '清扫了没人管的独立目录', item)
    result.removed.push(item)
  }
  /** 一个任务目录的清扫判定：新旧布局（worktrees/<任务> 与 worktrees/<项目>/<任务>）共用 */
  const sweepOne = async (dir: string, taskId: string) => {
    // 刚建出来、刚改过的目录先不动：可能有人（测试、e2e、正在收尾的子对话）马上还要用。
    // minAgeMs: 0 表示不看年龄（测试用）；文件 mtime 可能比 Date.now() 还新几毫秒
    const own = await lstat(dir).catch(() => null)
    if (minAge > 0 && own && Date.now() - own.mtimeMs < minAge) {
      result.kept.push({ dir, taskId, why: `最近 ${Math.round(minAge / 60_000)} 分钟内动过，先不动` })
      return
    }
    const common = await commonGitDir(dir)
    // 数据目录里的任务目录都是 git 工作目录：连 git 都不是的，是测试或手动留下的
    if (!common) {
      await drop({ taskId, dir, branch: '', kind: 'orphan', reason: '不是 git 工作目录（测试或手动残留）' }, '')
      return
    }
    const owner = path.dirname(common)
    const head = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
    const named = head && head !== 'HEAD' ? head : ''
    const registry = await worktreeRegistry(owner, common)
    if (!registry) {
      // 连注册表都读不出来时一个都不清：宁可留着，也不能把整个仓的目录当残留
      log.warn('worktree', '读不出 git 注册表，这次不清扫', { dir, repo: owner })
      result.kept.push({ dir, taskId, why: '读不出 git 注册表，按在用处理' })
      return
    }
    if (!registry.has(normPath(dir))) {
      // 注册表外的残留：prune 之后目录还在（面板重启、手动清过注册）
      const st = await worktreeFacts(owner, dir, named, '')
      if (!st) {
        result.kept.push({ dir, taskId, why: '读不出 git 状态，按在用处理' })
        return
      }
      if (st.dirty > 0) {
        result.kept.push({ dir, taskId, why: `有 ${st.dirty} 个没提交的文件` })
        return
      }
      if (st.ahead > 0) {
        result.kept.push({ dir, taskId, why: `分支上还有 ${st.ahead} 个没合回原分支的提交` })
        return
      }
      await drop(
        {
          taskId,
          dir,
          branch: named,
          kind: 'orphan',
          reason: '不在 git worktree 注册表里（面板重启或手动清理后的残留）',
        },
        owner,
      )
      return
    }
    const info = opts.taskInfo ? await opts.taskInfo(taskId).catch(() => 'unreadable' as const) : undefined
    if (info === 'unreadable') {
      result.kept.push({ dir, taskId, why: '读不到任务记录，按在用处理' })
      return
    }
    if (info?.working) {
      result.kept.push({ dir, taskId, why: '任务还在执行' })
      return
    }
    const branch = registry.get(normPath(dir)) || named
    const st = await worktreeFacts(owner, dir, branch, info?.baseBranch ?? '')
    if (!st) {
      result.kept.push({ dir, taskId, why: '读不出 git 状态，按在用处理' })
      return
    }
    if (st.dirty > 0) {
      result.kept.push({ dir, taskId, why: `有 ${st.dirty} 个没提交的文件` })
      return
    }
    if (st.ahead > 0) {
      result.kept.push({ dir, taskId, why: `分支上还有 ${st.ahead} 个没合回原分支的提交` })
      return
    }
    if (info && !info.done) {
      result.kept.push({ dir, taskId, why: '任务还没收口（没标记完成也没归档）' })
      return
    }
    await drop(
      {
        taskId,
        dir,
        branch,
        kind: 'merged',
        reason: info ? '任务已收口、改动都已合回原分支' : '任务记录已不存在、改动都已合回原分支',
      },
      owner,
    )
  }
  /** 共用依赖、复制锁和临时目录不是任务目录，不能当残留清 */
  const isDepsDir = (name: string) => name === HOISTED_DEPS || name.startsWith(`${HOISTED_DEPS}.`)
  for (const e of entries) {
    if (!e.isDirectory() || isDepsDir(e.name)) continue
    const at = path.join(root, e.name)
    // 新布局是 worktrees/<项目>/<任务 id>：项目分组目录本身不是 git 工作目录，
    // 任务目录是 git worktree（有 .git 文件）；旧布局是 worktrees/<任务 id>
    if (existsSync(path.join(at, '.git'))) {
      await sweepOne(at, e.name)
      continue
    }
    const subs = await readdir(at, { withFileTypes: true }).catch(() => null)
    if (!subs) continue
    for (const sub of subs) {
      if (!sub.isDirectory() || isDepsDir(sub.name)) continue
      await sweepOne(path.join(at, sub.name), sub.name)
    }
  }
  return result
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
