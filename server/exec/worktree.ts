import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, symlink, appendFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import type { TaskWorktree } from '../../shared/schema.ts'
import { t } from '../../shared/i18n.ts'
import { DATA_DIR } from '../store.ts'
import { capture } from './process.ts'

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

/**
 * 把项目目录里 git 不管、但跑起来需要的东西接到独立目录：
 * - node_modules（以及 .venv 之类的虚拟环境）建目录链接，不复制，装一次两边共用；
 * - .env 这类环境文件复制一份，子对话的测试才能起得来。含密钥的文件（.env.local 等）不复制。
 * 失败不算错：Agent 自己在独立目录里也会看到缺什么。
 */
async function prepare(dir: string, repo: string) {
  const linked: string[] = []
  const linkDir = async (name: string) => {
    const from = path.join(repo, name)
    const to = path.join(dir, name)
    if (!existsSync(from) || existsSync(to)) return
    // Windows 上用 junction，不需要管理员权限；其他平台用普通目录符号链接
    const ok = await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir').then(
      () => true,
      () => false,
    )
    if (ok) linked.push(name)
  }
  await Promise.all(['node_modules', '.venv', 'venv', 'vendor'].map(linkDir))
  // 项目没忽略这些目录时，合并前的 git add -A 会把整个依赖装进提交：写进这个工作目录自己的 exclude
  for (const name of linked) {
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
  /** 改动都已经在原分支里了（没有改动也算） */
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
  let ahead = 0
  if (has) {
    // 不知道从哪开的（分离 HEAD）时和项目目录现在的提交比
    const base = wt.baseBranch || 'HEAD'
    const r = await git(repo, 'rev-list', '--count', `${base}..refs/heads/${wt.branch}`)
    ahead = r.code === 0 ? Number(r.stdout.trim()) || 0 : 0
  }
  return { exists, branch: has, ahead, dirty, merged: has ? ahead === 0 && dirty === 0 : wt.state === 'merged' }
}

/** 删掉独立目录；force 时连分支一起删（丢弃），否则分支已经合并，用 -d 删 */
export async function removeWorktree(repo: string, wt: TaskWorktree, force: boolean) {
  await git(repo, 'worktree', 'remove', '--force', wt.path)
  if (existsSync(wt.path)) {
    // 里面可能有指向项目依赖的链接：先解开，免得递归删除顺着链接把项目的 node_modules 删掉
    for (const name of await readdir(wt.path).catch(() => [] as string[])) {
      const full = path.join(wt.path, name)
      if ((await lstat(full).catch(() => null))?.isSymbolicLink()) await rm(full, { force: true }).catch(() => {})
    }
    await rm(wt.path, { recursive: true, force: true }).catch(() => {})
  }
  await git(repo, 'worktree', 'prune')
  await git(repo, 'branch', force ? '-D' : '-d', wt.branch)
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
