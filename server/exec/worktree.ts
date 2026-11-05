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
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { TaskWorktree } from '../../shared/schema.ts'
import { type ChildHold, childHoldText } from '../../shared/task.ts'
import { t } from '../../shared/i18n.ts'
import { DATA_DIR } from '../store.ts'
import { capture } from './process.ts'
import { log } from '../log.ts'
import { aroundMerge } from '../turn-changes.ts'

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
 * 每个独立目录各有一份 node_modules（2026-11-02 用户决定，见 docs/lessons/worktree.md）：
 * 在 A 里 npm install / 改依赖不会影响 B 和项目主目录，npm 修剪也只动自己这份。
 * 复制的是真实文件，不建任何链接：2026-10 的事故是把项目那份链接进子对话，
 * npm 顺着链接删掉了项目里的真目录。
 * 其他依赖目录（Python venv、PHP vendor）按自己的路径找，同样各复制一份。
 */
const DEPS_DIR = 'node_modules'
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
 * 按项目分组让不同项目的任务目录不混在一起，清理和排查时一眼能分清；
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

/** 依赖副本里记录「按哪份 lock 复制的」：项目的 lock 变了才重新复制 */
const DEPS_MARK = '.agent-panel-deps.json'
/** 复制用的临时 / 换下来的旧副目录：都放在独立目录里，随目录一起删 */
const DEPS_TMP_PREFIX = `${DEPS_DIR}.tmp-`
const DEPS_OLD_PREFIX = `${DEPS_DIR}.old-`
/** 临时目录多久没动过算复制中断留下的残留：可能还有别的准备正在写这份，刚建的不动 */
const DEPS_TMP_STALE_MS = 10 * 60_000
/** 换上新的一份时 Windows 上刚复制完的目录偶尔还被扫描 / 句柄占着：改名失败时等一会儿再试 */
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 150
/** 单个文件复制失败时最多试几次：Windows 上杀毒软件扫描会让 copyFile 偶发 EPERM */
const COPY_ATTEMPTS = 3
const COPY_RETRY_MS = 50

/** 一批复制多少个文件：27k 个文件、600MB 的 node_modules 实测 12–20 秒，再往上并发提升不明显 */
const COPY_BATCH = 64

/**
 * 把整个依赖目录复制一份到独立目录（逐层建目录、逐文件复制）。
 * 不用硬链接：跨分卷用不了（数据目录在 C:、项目常在别的盘），同分卷时 npm 原地重写
 * node_modules/.package-lock.json 又会顺着 inode 改到项目那一份。复制最稳，代价是一次性成本。
 * 任何一个文件没复制成功都算失败（调用方会删掉半份）：留着半份会被当成已经准备好，问题被藏起来。
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
  const failed: string[] = []
  const copyWithRetry = async (s: string, d: string) => {
    let last: Error | null = null
    for (let i = 0; i < COPY_ATTEMPTS; i++) {
      try {
        await copyFile(s, d)
        return
      } catch (e) {
        last = e as Error
      }
      if (i < COPY_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, COPY_RETRY_MS))
    }
    failed.push(`${path.basename(s)}：${last?.message ?? '复制失败'}`)
  }
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
    if (ok) continue
    // 目录链接（npm workspaces 的 node_modules/<子包>）在 Windows 上可能建不出来：
    // 旧实现是跳过，这里也一样，不让一个链接把整份复制判失败；缺的那份由子对话自己装
    if ((await stat(s).catch(() => null))?.isDirectory()) {
      log.warn('worktree', '依赖里的目录链接没建出来，副本里少这一份', { from: s, target })
      continue
    }
    await copyWithRetry(s, d)
  }
  for (let i = 0; i < files.length; i += COPY_BATCH)
    await Promise.all(files.slice(i, i + COPY_BATCH).map(([s, d]) => copyWithRetry(s, d)))
  if (failed.length) throw new Error(`${failed.length} 个文件没复制过去，例如 ${failed.slice(0, 3).join('；')}`)
  return files.length
}

/** 依赖副本是按哪个文件复制的：锁文件和 package.json 的大小、修改时间 */
interface DepsStamp {
  source: string
  size: number
  mtimeMs: number
}

const sameStamp = (a: DepsStamp | null, b: DepsStamp | null) =>
  !!a && !!b && a.source === b.source && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1

/** 判断依赖副本要不要重做：优先 package-lock，没有就用 package.json，再没有就用依赖目录本身 */
async function depsStamp(root: string): Promise<DepsStamp | null> {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'package.json', DEPS_DIR]) {
    const st = await stat(path.join(root, name)).catch(() => null)
    if (st) return { source: name, size: st.size, mtimeMs: Math.round(st.mtimeMs) }
  }
  return null
}

/** 这个独立目录的依赖是按什么复制的；读不到记录时返回 null */
async function copiedDepsStamp(dir: string): Promise<DepsStamp | null> {
  const text = await readFile(path.join(dir, DEPS_DIR, DEPS_MARK), 'utf8').catch(() => '')
  if (!text) return null
  try {
    const mark = JSON.parse(text) as DepsStamp
    return typeof mark?.source === 'string' ? mark : null
  } catch {
    return null
  }
}

/** 这个目录里已经有一份完整的副本，而且是按现在这份 lock 复制的 */
async function depsReady(dir: string, stamp: DepsStamp | null) {
  if (!stamp || !existsSync(path.join(dir, DEPS_DIR))) return false
  return sameStamp(await copiedDepsStamp(dir), stamp)
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
 * 用新复制的一份换掉这个目录里的旧依赖：先把旧的改名挪开、再把新的改名进来，最后删旧的。
 * 不能先删旧的再改名：删到一半失败（Windows 上子对话正在读里面的文件）会留下残缺的一份。
 * 换装失败会回滚（新的改名失败就把旧的放回去），成功后要么完整旧版、要么完整新版。
 */
async function replaceDirDeps(dir: string, tmp: string) {
  const target = path.join(dir, DEPS_DIR)
  const old = path.join(dir, `${DEPS_OLD_PREFIX}${Date.now()}`)
  // 2026-10 事故的旧布局可能是指向项目依赖的链接：只删链接本身，不把它改名后再递归删，
  // 免得某些平台上顺着链接动到项目那份
  const st = await lstat(target).catch(() => null)
  const linked = st?.isSymbolicLink() === true
  if (linked) await rm(target, { force: true }).catch(() => {})
  const moved = !linked && !!st
  if (moved) {
    const err = await renameDir(target, old)
    if (err) {
      // 旧的还在原地、没被动过：这轮先用旧的
      log.warn('worktree', '旧的依赖副本正被使用，这次先不换', { dir: target, error: err })
      return false
    }
  }
  const err = await renameDir(tmp, target)
  if (err) {
    if (moved) await renameDir(old, target)
    log.warn('worktree', '依赖副本改名失败，这轮先用旧的', { dir: target, error: err })
    return false
  }
  // 旧的一份可能正被这个目录里的命令读着（Windows 上删不掉）：留着，下次准备时再清
  if (moved) await rm(old, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {})
  return true
}

/**
 * 清掉复制留下的副目录：换装挪开的旧份直接删；复制中断留下的临时目录只有很久没动过才删
 * （可能还有别的准备正在写这份，刚建的不能动）。删不掉的下次再试，随任务目录回收时也会一起删。
 */
async function cleanLeftoverDeps(dir: string) {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const at = path.join(dir, name)
    const staleTmp =
      name.startsWith(DEPS_TMP_PREFIX) &&
      Date.now() - ((await lstat(at).catch(() => null))?.mtimeMs ?? Date.now()) > DEPS_TMP_STALE_MS
    if (!name.startsWith(DEPS_OLD_PREFIX) && !staleTmp) continue
    await rm(at, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {})
  }
}

/** 复制一份到独立目录；失败时清掉临时目录、保留旧的一份 */
async function copyDirDeps(dir: string, from: string, stamp: DepsStamp | null) {
  const tmp = path.join(dir, `${DEPS_TMP_PREFIX}${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  const started = Date.now()
  try {
    const files = await cloneDir(from, tmp).catch(async (e: Error) => {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      log.warn('worktree', '依赖没复制到这个独立目录，它要自己装', { dir, from, error: e.message })
      return 0
    })
    if (!files) return false
    if (stamp)
      await writeFile(path.join(tmp, DEPS_MARK), JSON.stringify(stamp)).catch((e: Error) => {
        log.warn('worktree', '依赖复制记录没写成功，下次准备会再复制一遍', { dir, error: e.message })
      })
    if (!(await replaceDirDeps(dir, tmp))) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      return false
    }
    await cleanLeftoverDeps(dir)
    log.info('worktree', '依赖复制到这个独立目录（每个 worktree 各一份）', {
      dir: path.join(dir, DEPS_DIR),
      files,
      ms: Date.now() - started,
    })
    return true
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    log.warn('worktree', '依赖复制失败，这个独立目录要自己装', { dir, error: (e as Error).message })
    return false
  }
}

/**
 * 准备这个独立目录自己的依赖：从项目根复制一份真实的 node_modules，项目的 lock 变了才刷新。
 * 每份目标路径都不同，并发开多个子对话时各复制各的、不会互相踩，因此不需要共用一份时的全局锁。
 * 项目自己没装依赖时跳过（返回 missing），不让开 worktree 因此失败。
 */
export async function ensureWorktreeDeps(
  dir: string,
  repo: string,
): Promise<'ready' | 'copied' | 'missing' | 'failed'> {
  // 源目录和 lock 都按项目根读：传进来的可能是父对话的独立目录
  const root = await repoRoot(repo)
  const from = path.join(root, DEPS_DIR)
  if (!existsSync(from)) return 'missing'
  const target = path.join(dir, DEPS_DIR)
  // 读不到 common dir、项目根就是 dir 本身时：别把自己复制给自己
  if (path.resolve(from) === path.resolve(target)) return 'ready'
  const stamp = await depsStamp(root)
  if (await depsReady(dir, stamp)) {
    await cleanLeftoverDeps(dir)
    return 'ready'
  }
  // 有按同一份 lock 备好的副本就直接改名拿过来（同一个分卷，瞬间完成），再在后台补一份给下一个
  if (await takeSpareDeps(dir, repo, stamp)) {
    refillSpareDeps(repo)
    return 'copied'
  }
  const ok = await copyDirDeps(dir, from, stamp)
  // 这次是现复制的：顺手在后台备一份，下一个独立目录就不用再等十几秒
  if (ok) refillSpareDeps(repo)
  return ok ? 'copied' : 'failed'
}

/**
 * 备用的依赖副本（worktrees/<项目>/node_modules.spare/）：开独立目录时直接改名拿走，不用当场复制十几秒。
 * 仍是每个目录各一份真实文件、不建链接（docs/lessons/worktree.md），代价是每个项目多占一份磁盘；名字以 node_modules. 开头，清扫会跳过
 */
const SPARE_DEPS = `${DEPS_DIR}.spare`
const spareDepsDir = async (repo: string) => path.join(WORKTREES_DIR, await repoKey(repo), SPARE_DEPS)
/** 正在补副本的项目：同一个项目同时只补一份 */
const spareFilling = new Map<string, Promise<void>>()

/** 拿走备用副本换进这个独立目录；没有、lock 对不上、被别人先拿走了都返回 false，调用方照旧现复制 */
async function takeSpareDeps(dir: string, repo: string, stamp: DepsStamp | null) {
  if (!stamp) return false
  const spare = await spareDepsDir(repo).catch(() => '')
  if (!spare || !(await depsReady(spare, stamp))) return false
  const tmp = path.join(dir, `${DEPS_TMP_PREFIX}spare-${process.pid}-${Date.now()}`)
  // 两个独立目录同时来拿：改名是原子的，只有一个拿得到，另一个改名失败、退回现复制
  if (await renameDir(path.join(spare, DEPS_DIR), tmp)) return false
  if (!(await replaceDirDeps(dir, tmp))) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return false
  }
  await cleanLeftoverDeps(dir)
  log.info('worktree', '用备好的依赖副本，省掉这次复制', { dir: path.join(dir, DEPS_DIR) })
  return true
}

/** 在后台按项目现在的 lock 补一份备用副本（已有对得上的、正在补、项目没装依赖时不做）；调用方不用等，Promise 只给测试用 */
export function refillSpareDeps(repo: string): Promise<void> {
  const run = async () => {
    const root = await repoRoot(repo)
    const from = path.join(root, DEPS_DIR)
    if (!existsSync(from)) return
    const spare = await spareDepsDir(repo)
    const stamp = await depsStamp(root)
    if (!stamp || (await depsReady(spare, stamp))) return
    await mkdir(spare, { recursive: true })
    await copyDirDeps(spare, from, stamp) // 复用独立目录那一套：中途失败不留半份
  }
  const key = path.resolve(repo)
  const running = spareFilling.get(key)
  if (running) return running
  const p = run()
    .catch((e: Error) =>
      log.warn('worktree', '备用依赖副本没补成，下次开独立目录照旧现复制', { repo, error: e.message }),
    )
    .finally(() => spareFilling.delete(key))
  spareFilling.set(key, p)
  return p
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
 * package.json 里声明、但这个目录自己的 node_modules 里没装上的包。
 * 每个独立目录跑的是自己那份副本，缺了就在这里说清，不要留给后面每条命令各报「找不到模块」。
 */
export async function missingDeps(dir: string) {
  const pkg = await packageJson(dir)
  if (!pkg) return []
  const want = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  const nm = path.join(dir, DEPS_DIR)
  if (!existsSync(nm)) return want
  return want.filter((name) => !existsSync(path.join(nm, name, 'package.json')))
}

/** 依赖不完整时说清缺哪些、怎么补，别让后面每条命令各报一句「找不到模块」 */
function warnMissingDeps(dir: string, missing: string[]) {
  if (!missing.length) return
  log.error('worktree', '依赖不完整：这个目录里少装了声明的包，接下来会接连报「找不到模块」', {
    dir: path.join(dir, DEPS_DIR),
    missing: missing.slice(0, 20).join('、') + (missing.length > 20 ? ` 等 ${missing.length} 个` : ''),
    recover: '在这个独立目录里跑 npm ci --include=dev 重新装一份；每个 worktree 的依赖互不影响',
  })
}

/**
 * 2026-10 事故的旧布局：独立目录里的 node_modules 是指向项目那份的链接。
 * 准备目录时只把链接删掉（不删目标），随后 ensureWorktreeDeps 会复制一份真实文件进来。
 * 真实的目录副本不再删：每个 worktree 各一份正是现在的设计。
 */
async function dropLinkedDeps(dir: string) {
  const mine = path.join(dir, DEPS_DIR)
  if (!(await lstat(mine).catch(() => null))?.isSymbolicLink()) return
  await rm(mine, { force: true }).catch(() => {})
}

/**
 * 独立目录里不能共用的依赖目录（.venv / venv / vendor）各复制一份，并解开旧版的 node_modules 链接。
 * 返回复制过去的目录名（写进 git exclude 用）。复制失败不算错：Agent 自己在独立目录里也会看到缺什么。
 */
export async function isolateDeps(dir: string, repo: string) {
  await dropLinkedDeps(dir)
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

/** 这个路径还没被忽略时，把 pattern 写进该工作目录自己的 info/exclude（已有同一行时不重复写） */
async function excludeIfNeeded(dir: string, sample: string, pattern: string) {
  const ignored = await capture('git', ['check-ignore', '-q', sample], dir, process.env, 10_000)
  if (ignored.code === 0) return
  const exclude = await capture('git', ['rev-parse', '--git-path', 'info/exclude'], dir, process.env, 10_000)
  if (exclude.code !== 0) return
  const file = path.resolve(dir, exclude.stdout.trim())
  const text = await readFile(file, 'utf8').catch(() => '')
  if (text.split(/\r?\n/).includes(pattern)) return
  await appendFile(file, `${pattern}\n`).catch(() => {})
}

/** 独立目录的准备工作：复制一份自己的依赖（见 ensureWorktreeDeps），环境文件复制一份——含密钥的 .env.local 等不复制 */
async function prepare(dir: string, repo: string) {
  // 必须在复制之前写 exclude：复制要 12–20 秒，中途被杀留下的 node_modules.tmp-* 如果还没被忽略，
  // 恢复后这个任务目录会一直算「有未提交改动」，合并门禁和清扫都不敢动它
  await excludeIfNeeded(dir, DEPS_DIR, `/${DEPS_DIR}`)
  const sideDirs = [
    [`${DEPS_DIR}.tmp-probe`, `/${DEPS_DIR}.tmp-*`],
    [`${DEPS_DIR}.old-probe`, `/${DEPS_DIR}.old-*`],
  ] as const
  for (const [sample, pattern] of sideDirs) await excludeIfNeeded(dir, sample, pattern)
  // 每个独立目录复制自己的一份；项目没装依赖时跳过，不让开 worktree 因此失败
  const deps = await ensureWorktreeDeps(dir, repo)
  if (deps === 'missing') log.info('worktree', '项目里没有 node_modules，这个独立目录里要自己装', { repo })
  else if (deps === 'failed') log.warn('worktree', '依赖没复制到这个独立目录，它要自己装', { repo })
  const prepared = await isolateDeps(dir, repo)
  // 其他按自己的路径找依赖的目录（.venv / venv / vendor）也写进 exclude，免得 git add -A 带进提交
  for (const name of prepared) await excludeIfNeeded(dir, name, `/${name}`)
  const envs = await readdir(repo).catch(() => [] as string[])
  for (const name of envs) {
    if (!name.startsWith('.env') || SECRET_ENV.test(name)) continue
    const from = path.join(repo, name)
    await copyFile(from, path.join(dir, name)).catch(() => {})
  }
  // 副本在这个独立目录里，缺包就按它自己的目录核对
  warnMissingDeps(dir, await missingDeps(dir))
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
  if (existsSync(dir) && (await hasBranch(cwd, branch))) {
    // 继续一个已有的目录：旧 worktree 可能还没有自己那份依赖（用户也可能删过），准备时补一份；
    // 顺手清掉上次复制中断留下的临时目录。已经就绪时只读一次 marker，不会重新复制。
    const deps = await ensureWorktreeDeps(dir, cwd)
    if (deps === 'failed') log.warn('worktree', '依赖没复制到这个独立目录，它要自己装', { dir })
    return { worktree: wt, rebuilt: false }
  }
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
 * （本机 git 2.43 实测）。stash failed 不能再看锁文件在不在：占锁的进程往往在 git 报错之后、
 * 我们去查之前就放开了，查到「不在」就把一次撞锁当成冲突报出去（CI 上 worktree.test 的锁用例因此时好时坏）。
 * 锁以外的原因重试几次照样失败，最后照常报错，只是多等几秒
 */
function lockBusy(stderr: string) {
  return /index\.lock|Unable to write index|stash failed/.test(stderr)
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
  // 合并的那一下（连同冲突时的撤回）从正在这个目录里记改动的对话中切掉（见 server/turn-changes.ts）：
  // 总结下面的卡片不含子对话的改动
  const m = await aroundMerge(target, async () => {
    let r = await git(target, ...args)
    // 别的 git 进程（Agent 自己的 git add / commit、面板的状态查询）正好占着 index.lock：合并根本没开始，
    // 不是冲突，等一下重试；直接报「有冲突」会让父对话、子对话去处理一个不存在的冲突
    // 写索引那一步才撞上锁时 git 已经留下了 MERGE_HEAD：先撤掉这次没合成的，再重来（撤也撞锁就下一圈再撤）
    for (let i = 1; r.code !== 0 && i <= 5 && lockBusy(r.stderr); i++) {
      await new Promise((ok) => setTimeout(ok, 200 * i))
      const head = (await git(target, 'rev-parse', '--git-path', 'MERGE_HEAD')).stdout.trim()
      if (head && existsSync(path.resolve(target, head)) && (await git(target, 'merge', '--abort')).code !== 0) continue
      r = await git(target, ...args)
    }
    if (r.code !== 0) await git(target, 'merge', '--abort')
    return r
  })
  if (m.code !== 0) {
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

/**
 * 比对 git 注册表用的路径：先解析成真实路径再 normPath。git 记的是真实长路径（C:/Users/runneradmin/...），
 * 面板手里的可能是 8.3 短名（C:\Users\RUNNER~1\...）或经过符号链接（macOS 的 /var → /private/var）；
 * 不解析的话在用的工作区会被当成「注册表外的残留」整个删掉（Windows CI 上清扫用例就是这样挂的）。
 * 目录不在了 / 读不出来时退回原路径
 */
const realNorm = async (p: string) => normPath(await realpath(p).catch(() => p))

/** 目录所在主仓库的 .git 目录；不是 git 工作目录时返回空 */
async function commonGitDir(dir: string): Promise<string> {
  // --path-format=absolute 是 git 2.31 起的；旧版退回相对路径自己拼
  const abs = await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const out =
    (abs.code === 0 ? abs.stdout : '').trim() || (await git(dir, 'rev-parse', '--git-common-dir')).stdout.trim()
  return out ? path.resolve(dir, out) : ''
}

/**
 * 独立目录的 .git 是不是确实断了：返回残留原因，没断（或判断不了）返回空串。
 * 只认两种：.git 文件里的 gitdir 指向的目录已经不在了；.git 根本不是 gitdir 链接也不是目录
 */
async function brokenGitLink(dir: string): Promise<string> {
  const dotGit = path.join(dir, '.git')
  const st = await lstat(dotGit).catch(() => null)
  if (!st) return ''
  if (st.isDirectory()) return ''
  const text = await readFile(dotGit, 'utf8').catch(() => null)
  if (text === null) return ''
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (!m) return '.git 不是有效的 worktree 链接（测试或手动残留）'
  const target = path.resolve(dir, m[1].trim())
  const alive = await lstat(target).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : 'unknown'))
  return alive === null ? '.git 指向的注册目录已经不在了（主仓库挪走或注册被清）' : ''
}

/** git 登记的工作区：路径 → 分支名（分离 HEAD 时为空）；读不出来时返回 null */
async function worktreeRegistry(repo: string, common: string): Promise<Map<string, string> | null> {
  const r = await git(repo, 'worktree', 'list', '--porcelain')
  if (r.code === 0) return realKeys(parseRegistry(r.stdout))
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
  return map.size ? realKeys(map) : null
}

/** 注册表的键也换成真实路径，和 realNorm(dir) 同一口径 */
async function realKeys(map: Map<string, string>) {
  const out = new Map<string, string>()
  for (const [at, branch] of map) out.set(await realNorm(at), branch)
  return out
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
    // git 读不出来不等于残留：git 不在 PATH、超时、dubious ownership 时 rev-parse 也返回空。
    // 只有 .git 指向的注册目录确实不在了，才当残留清；其余一律按在用保留，免得连未提交的改动一起删掉
    if (!common) {
      const why = await brokenGitLink(dir)
      if (!why) {
        log.warn('worktree', '读不出独立目录的 git 信息，这次不清扫', { dir })
        result.kept.push({ dir, taskId, why: '读不出 git 信息（git 不可用或出错），按在用处理' })
        return
      }
      const info = opts.taskInfo ? await opts.taskInfo(taskId).catch(() => 'unreadable' as const) : undefined
      if (info === 'unreadable' || info?.working) {
        result.kept.push({ dir, taskId, why: info === 'unreadable' ? '读不到任务记录，按在用处理' : '任务还在执行' })
        return
      }
      await drop({ taskId, dir, branch: '', kind: 'orphan', reason: why }, '')
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
    const key = await realNorm(dir)
    if (!registry.has(key)) {
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
      const live = opts.taskInfo ? await opts.taskInfo(taskId).catch(() => 'unreadable' as const) : undefined
      if (live === 'unreadable' || live?.working) {
        result.kept.push({ dir, taskId, why: live === 'unreadable' ? '读不到任务记录，按在用处理' : '任务还在执行' })
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
    const branch = registry.get(key) || named
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
  /**
   * 旧版在项目分组目录下放过共用的 node_modules、复制锁和临时目录：它们不是任务目录，不能当残留清。
   * 新版本不再建共用份，但旧目录可能还有旧 worktree 靠祖先解析，这里也不主动删，等那些目录回收后自然消失。
   */
  const isDepsDir = (name: string) => name === DEPS_DIR || name.startsWith(`${DEPS_DIR}.`)
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
  // add 失败（index.lock、权限、非法路径）时暂存区是空的，后面会被当成「没有改动」，合并却报成功
  const add = await git(wt.path, 'add', '-A')
  if (add.code !== 0) throw fail(add, t('暂存改动失败'))
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
      // 挡路的具体文件：写给父对话时要点名（报错只留最后几行，文件一多就被截掉）
      blockers: dirty ? overwrittenFiles(m.stderr + m.stdout) : [],
      error:
        (conflicts ? `冲突的文件：\n${conflicts}\n\n` : '') +
        (m.stderr || m.stdout).trim().split('\n').slice(-6).join('\n'),
    }
  }
  const pending = (await git(target, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).code === 0
  const files = (await git(target, 'diff', '--cached', '--name-only')).stdout.trim()
  return { ok: true as const, nothing: !pending, files: files ? files.split('\n') : [] }
}

/** git merge 拒绝时列出的「会被覆盖」的文件：已跟踪的未提交改动、未跟踪文件两段都认（每段下面一行一个、带缩进） */
export function overwrittenFiles(out: string) {
  const files: string[] = []
  let on = false
  for (const line of out.split('\n')) {
    if (/would be overwritten by merge|会被合并覆盖/.test(line)) on = true
    else if (on && /^\s+\S/.test(line)) files.push(line.trim())
    else on = false
  }
  return [...new Set(files)]
}

/**
 * 合并前看一眼目标目录：有没做完的合并，或者暂存区里有别人的改动时不能合——
 * 合并提交会把暂存区一起带进去，撤回时也可能连带清掉。返回挡路的是什么，能合时返回 null；
 * 说法由调用方按收件人写（见 worktree-integrate.ts）
 */
export async function mergeBlocker(
  target: string,
): Promise<{ kind: 'merge-head' } | { kind: 'staged'; files: string[] } | null> {
  if ((await git(target, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).code === 0) return { kind: 'merge-head' }
  const staged = (await git(target, 'diff', '--cached', '--name-only')).stdout.trim()
  return staged ? { kind: 'staged', files: staged.split('\n') } : null
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
