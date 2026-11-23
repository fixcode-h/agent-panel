/**
 * 文件索引和版本管理打交道的部分：Git 的 .gitignore（按 git 自己的判断，不自己解析规则）、
 * 「只收版本管理里的」时的文件清单（git ls-files / p4 have）、P4 有没有 sync 过的探测
 */
import path from 'node:path'
import { gitRaw, gitRun } from '../exec/git.ts'
import { p4Runner } from '../p4-split.ts'

/**
 * Git 忽略的路径（相对 Git 仓库根）：目录结尾带 /。`--directory` 把整个被忽略的目录收成一项，
 * node_modules、Binaries 这种几万个文件的目录只回一行
 */
export async function gitIgnored(root: string): Promise<Set<string> | undefined> {
  const r = await gitRaw(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], {
    timeoutMs: 60_000,
  })
  if (r.code !== 0) return undefined
  const prefix = await gitPrefix(root)
  const out = new Set<string>()
  for (const p of r.stdout.toString('utf8').split('\0')) {
    if (!p) continue
    // ls-files 给的是相对当前目录（root）的路径
    out.add(prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p)
  }
  return out
}

/** root 在 Git 仓库里的前缀（root 是仓库的子目录时） */
async function gitPrefix(root: string) {
  const r = await gitRun(root, ['rev-parse', '--show-prefix']).catch(() => null)
  return r && r.code === 0 ? String(r.stdout).trim() : ''
}

/** 这几个新文件里哪些被 .gitignore 忽略（增量读到新文件时用） */
export async function gitCheckIgnore(root: string, rels: string[]): Promise<Set<string>> {
  if (!rels.length) return new Set()
  const r = await gitRaw(root, ['check-ignore', '-z', '--stdin'], {
    input: Buffer.from(rels.join('\0') + '\0'),
    timeoutMs: 30_000,
  })
  // 退出码 1 是「一个都没忽略」
  return new Set(r.stdout.toString('utf8').split('\0').filter(Boolean))
}

/** 「只收版本管理里的」：版本管理里的文件（相对 root）；拿不到返回 undefined */
export async function trackedFiles(root: string, vcs: string): Promise<string[] | undefined> {
  if (vcs === 'git') {
    const r = await gitRaw(root, ['ls-files', '-z', '--cached'], { timeoutMs: 120_000 })
    if (r.code !== 0) return undefined
    return r.stdout.toString('utf8').split('\0').filter(Boolean)
  }
  if (vcs === 'p4') {
    const r = await p4Runner(root)(['-F', '%path%', 'have', '...'])
    if (!r.ok) return undefined
    const base = path.resolve(root)
    return r.out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => path.relative(base, p).split(path.sep).join('/'))
      .filter((p) => p && !p.startsWith('..'))
  }
  return undefined
}

/** P4 这个工作区最近 sync 到的 changelist（只问一个数，毫秒级）：变了说明有人 sync 过，要整体核对一遍 */
export async function p4HaveChange(root: string): Promise<string | undefined> {
  const r = await p4Runner(root)(['-F', '%change%', 'changes', '-m1', '...#have'])
  return r.ok ? r.out.trim() || undefined : undefined
}
