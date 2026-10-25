/**
 * 技能文件夹的文件树：后端给的是「扁平条目 + 完整 path」（见 shared/library.ts 的 LibraryFileEntry），
 * 目录在前、同级按名字排好序，这里只还原层级，不再排序（重复排序会把后端的目录优先规则弄乱）。
 */
import type { LibraryFileEntry } from '@shared/library'

/** 一层文件树：目录带子项，文件没有 children */
export interface TreeRow extends LibraryFileEntry {
  /** 从顶层到这里的层级，用来做缩进；顶层是 0 */
  depth: number
  children?: TreeRow[]
}

/** 扁平条目 → 层级；父目录没单列时（后端不该出现）按目录补出来，路径不丢 */
export function toTree(items: LibraryFileEntry[]): TreeRow[] {
  const rows: TreeRow[] = []
  const dirs = new Map<string, TreeRow>()
  const ensureDir = (path: string): TreeRow => {
    const hit = dirs.get(path)
    if (hit) return hit
    const row: TreeRow = { path, type: 'dir', depth: 0, children: [] }
    dirs.set(path, row)
    const slash = path.lastIndexOf('/')
    if (slash < 0) rows.push(row)
    else ensureDir(path.slice(0, slash)).children!.push(row)
    return row
  }
  for (const entry of items) {
    const row: TreeRow = { ...entry, depth: 0, ...(entry.type === 'dir' ? { children: [] } : {}) }
    if (entry.type === 'dir') dirs.set(entry.path, row)
    const slash = entry.path.lastIndexOf('/')
    if (slash < 0) rows.push(row)
    else ensureDir(entry.path.slice(0, slash)).children!.push(row)
  }
  // 深度按层级算一次，渲染时只读这一份
  const walk = (list: TreeRow[], depth: number) => {
    for (const r of list) {
      r.depth = depth
      if (r.children) walk(r.children, depth + 1)
    }
  }
  walk(rows, 0)
  return rows
}

/** 树里的显示名：路径最后一段 */
export const entryName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * 收起的目录集合：切换技能时重来一份，默认全展开（技能文件夹通常只有几个文件）。
 * 只按 path 记，不用整棵树做 key。
 */
export function visibleRows(rows: TreeRow[], folded: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (list: TreeRow[]) => {
    for (const r of list) {
      out.push(r)
      if (r.children && !folded.has(r.path)) walk(r.children)
    }
  }
  walk(rows)
  return out
}

/** 文件数（不含目录），用于「另有 N 个文件」这类摘要 */
export function countFiles(rows: TreeRow[]): number {
  let n = 0
  const walk = (list: TreeRow[]) => {
    for (const r of list) {
      if (r.type === 'dir') walk(r.children ?? [])
      else n++
    }
  }
  walk(rows)
  return n
}
