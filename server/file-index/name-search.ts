/**
 * 文件面板「按名字搜」走项目文件索引（以前 Git 项目每次 ls-files、别的项目遍历到 2 万个文件就截断）。
 * dir 是对话的执行目录：在项目目录里（或就是它）才用索引，独立分支目录、项目外的目录返回 undefined 让调用方走老路。
 * 索引 3 秒内还没建好也走老路，不让面板干等
 */
import path from 'node:path'
import { projectIndex, projectOfDir } from './registry.ts'

const READY_MS = 3_000

export async function indexedNames(dir: string, q: string, cap: number): Promise<string[] | undefined> {
  const id = await projectOfDir(dir)
  if (!id) return undefined
  const idx = await projectIndex(id)
  if (!idx || !(await idx.ready(READY_MS))) return undefined
  const rel = path.relative(idx.projectPath, dir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const prefix = rel ? `${rel.split(path.sep).join('/')}/` : ''
  const search = () =>
    idx
      .find(q, { under: prefix ? [prefix] : undefined, cap, roots: 'project' })
      .map((h) => h.path)
      .filter((p) => !path.isAbsolute(p) && p.startsWith(prefix) && !p.endsWith('/'))
      .map((p) => p.slice(prefix.length))
  const hits = search()
  if (hits.length) return hits
  // 没找到：先按目录核对这棵子树再查（面板外刚建的文件、没有系统通知的 Linux）；核对太久就照老路扫
  const verified = await Promise.race([
    idx.refresh(prefix.replace(/\/$/, '')).then(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), READY_MS).unref?.()),
  ])
  return verified ? search() : undefined
}

/**
 * 项目里符合 re 的全部文件（相对项目根）：项目没开索引返回 undefined（调用方走老路）；多于 max 个返回 null
 */
export async function indexedFiles(projectPath: string, re: RegExp, max: number): Promise<string[] | null | undefined> {
  const id = await projectOfDir(projectPath)
  const idx = id ? await projectIndex(id) : undefined
  if (!idx || path.resolve(idx.projectPath) !== path.resolve(projectPath) || !(await idx.ready(READY_MS)))
    return undefined
  const all = (await idx.list('', { recursive: true }))?.files ?? []
  const out: string[] = []
  for (const f of all) {
    if (!re.test(f)) continue
    out.push(f)
    if (out.length > max) return null
  }
  return out
}
