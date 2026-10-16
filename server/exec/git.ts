import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FileChange } from '../../shared/schema.ts'
import { capture } from './process.ts'
import { lines } from './parsers.ts'

const git = (cwd: string, ...args: string[]) => capture('git', ['-c', 'core.quotepath=off', ...args], cwd)

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
