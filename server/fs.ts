import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DirInfo, DirListing } from '../shared/schema.ts'

/** 支持 ~ 开头的路径 */
export function resolvePath(p: string) {
  const t = p.trim()
  if (!t) return os.homedir()
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) return path.join(os.homedir(), t.slice(1))
  return path.resolve(t)
}

async function gitBranch(dir: string): Promise<string | null> {
  try {
    const head = (await readFile(path.join(dir, '.git', 'HEAD'), 'utf8')).trim()
    return head.startsWith('ref: ') ? head.replace(/^ref: refs\/heads\//, '') : head.slice(0, 7)
  } catch {
    return null
  }
}

export async function inspectDir(p: string): Promise<DirInfo> {
  const full = resolvePath(p)
  try {
    const s = await stat(full)
    return { path: full, exists: true, isDir: s.isDirectory(), gitBranch: s.isDirectory() ? await gitBranch(full) : null }
  } catch {
    return { path: full, exists: false, isDir: false, gitBranch: null }
  }
}

/** 列出子目录（隐藏目录除外），供前端的目录浏览器使用 */
export async function listDir(p: string): Promise<DirListing> {
  const full = resolvePath(p)
  const entries = await readdir(full, { withFileTypes: true })
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(full, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const parent = path.dirname(full)
  return { path: full, parent: parent === full ? null : parent, dirs }
}
