import { readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FileChange } from '../../shared/schema.ts'
import { capture } from './process.ts'
import { t } from '../../shared/i18n.ts'
import { lines } from './parsers.ts'

const git = (cwd: string, ...args: string[]) => capture('git', ['-c', 'core.quotepath=off', ...args], cwd)

/**
 * 面板自己往任务目录里放的东西不算 Agent 的改动：附件拷进 attachments/ 后
 * git 会把它当未跟踪文件列出来，看起来像是 Agent 新加的文件。
 */
const PANEL_DIR = /^attachments\//

/**
 * 当前未提交的改动：path → "增加/删除" 行数。不是 git 仓库时返回 null。
 * 包含未跟踪的新文件（按行数算新增）。
 */
export async function gitNumstat(cwd: string, ref = ''): Promise<Record<string, string> | null> {
  const inside = await git(cwd, 'rev-parse', '--is-inside-work-tree')
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  // 和任务开始时的提交比：Agent 自己提交了的改动也算在内，不会因为提交就从「更改」里消失
  const base = ref && (await git(cwd, 'cat-file', '-e', `${ref}^{commit}`)).code === 0 ? ref : 'HEAD'
  const hasBase = (await git(cwd, 'rev-parse', '--verify', base)).code === 0
  const diff = await git(cwd, 'diff', '--numstat', ...(hasBase ? [base] : ['--cached']))
  const out: Record<string, string> = {}
  for (const line of diff.stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (m) out[m[3]] = `${m[1] === '-' ? 0 : m[1]}/${m[2] === '-' ? 0 : m[2]}`
  }
  const untracked = await git(cwd, 'ls-files', '--others', '--exclude-standard')
  for (const p of untracked.stdout.split('\n').filter(Boolean).slice(0, 300)) {
    if (PANEL_DIR.test(p)) continue
    try {
      const full = path.join(cwd, p)
      const s = await stat(full)
      const n = s.size > 2_000_000 ? 0 : lines(await readFile(full, 'utf8'))
      out[p] = `${n}/0`
    } catch {}
  }
  return out
}

/** 当前提交；不是 git 仓库或还没有提交时为空 */
export async function gitHead(cwd: string) {
  const r = await git(cwd, 'rev-parse', '--verify', 'HEAD')
  return r.code === 0 ? r.stdout.trim() : ''
}

/** 和任务开始时相比有变化的文件；ref 是任务开始时的提交 */
export async function gitChanges(
  cwd: string,
  baseline: Record<string, string>,
  ref = '',
): Promise<FileChange[] | null> {
  const now = await gitNumstat(cwd, ref)
  if (!now) return null
  return Object.entries(now)
    .filter(([p, v]) => baseline[p] !== v)
    .map(([p, v]) => {
      const [add, del] = v.split('/').map(Number)
      return { path: p, add, del }
    })
}

/** 本地分支，最近提交的排在前面；current 是当前所在的分支（分离 HEAD 时为空） */
export async function gitBranches(cwd: string): Promise<{ current: string | null; branches: string[] }> {
  const list = await git(cwd, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads')
  if (list.code !== 0) throw new Error(t('这个目录不是 git 仓库'))
  const head = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  const current = head.code === 0 && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : null
  return {
    current,
    branches: list.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

/**
 * 切换到已有分支。只接受本地分支，分支名不从界面上随便传；
 * 有未提交的改动挡住时把 git 的说明原样交给用户。
 */
export async function gitCheckout(cwd: string, branch: string) {
  const { branches } = await gitBranches(cwd)
  if (!branches.includes(branch)) throw new Error(t('没有这个分支：{branch}', { branch }))
  const r = await capture('git', ['-c', 'core.quotepath=off', 'checkout', branch], cwd, process.env, 60_000)
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || t('切换分支失败'))
}

const MAX_DIFF = 400_000

/** 起点：任务开始时的提交还在就用它，否则用当前提交 */
async function baseOf(cwd: string, ref: string) {
  if (ref && (await git(cwd, 'cat-file', '-e', `${ref}^{commit}`)).code === 0) return ref
  return (await git(cwd, 'rev-parse', '--verify', 'HEAD')).code === 0 ? 'HEAD' : ''
}

/** 一个文件和任务开始时相比的差异（unified diff）；新文件和整个文件都是新增 */
export async function gitFileDiff(cwd: string, ref: string, file: string) {
  const base = await baseOf(cwd, ref)
  let out = base ? (await git(cwd, 'diff', '--no-color', base, '--', file)).stdout : ''
  if (!out.trim()) {
    // 没跟踪的新文件：和空文件比
    const tracked = (await git(cwd, 'ls-files', '--error-unmatch', '--', file)).code === 0
    if (!tracked) out = (await git(cwd, 'diff', '--no-color', '--no-index', '--', '/dev/null', file)).stdout
  }
  return out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n${t('…（差异太长，只显示前面一部分）')}` : out
}

/**
 * 把一个文件恢复成任务开始时的样子：开始时就有的文件取回那时的内容，任务里新建的直接删掉。
 * 任务开始前就有未提交改动的文件不能恢复（那些改动没有保存过，恢复会一起丢掉），由调用方拦住。
 */
export async function gitRevertFile(cwd: string, ref: string, file: string) {
  const base = await baseOf(cwd, ref)
  const full = path.resolve(cwd, file)
  if (!full.startsWith(path.resolve(cwd) + path.sep)) throw new Error(t('文件不在项目目录里'))
  const existed = base && (await git(cwd, 'cat-file', '-e', `${base}:${file}`)).code === 0
  if (existed) {
    const r = await git(cwd, 'checkout', base, '--', file)
    if (r.code !== 0) throw new Error(r.stderr.trim() || t('恢复失败'))
    // checkout 会把文件放进暂存区，和开始时一样不留暂存
    await git(cwd, 'reset', '-q', '--', file)
  } else {
    await git(cwd, 'rm', '-q', '--cached', '--ignore-unmatch', '--', file)
    await unlink(full).catch((e) => {
      if (e?.code !== 'ENOENT') throw e
    })
  }
}

/** ref 之后这个分支上的提交（一行一个「短哈希 标题」），给交接摘要用；读不出来返回空 */
export async function branchCommits(cwd: string, ref: string, max = 20): Promise<string[]> {
  if (!ref) return []
  const r = await git(cwd, 'log', '--oneline', '--no-decorate', `-${max}`, `${ref}..HEAD`)
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
}
