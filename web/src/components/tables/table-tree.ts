/** 表格页文件树的数据：把相对路径列表拼成目录树，名字搜索时只留命中的文件 */
import type { TableFile } from '@shared/tables'

export interface TableNode {
  name: string
  path: string
  /** 文件才有 */
  file?: TableFile
  children: TableNode[]
  /** 目录下（含子目录）的文件数 */
  count: number
}

/** 名字搜索：空格分开的几个词都要出现在路径里（不分大小写） */
export function nameHit(path: string, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const p = path.toLowerCase()
  return words.every((w) => p.includes(w))
}

export function buildTableTree(files: TableFile[], query = ''): TableNode[] {
  const root: TableNode = { name: '', path: '', children: [], count: 0 }
  for (const f of files) {
    if (query.trim() && !nameHit(f.path, query)) continue
    const parts = f.path.split('/')
    let at = root
    at.count++
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join('/')
      const last = i === parts.length - 1
      let next = at.children.find((c) => c.name === name && !c.file === !last)
      if (!next) {
        next = { name, path, children: [], count: 0, ...(last ? { file: f } : {}) }
        at.children.push(next)
      }
      if (!last) next.count++
      at = next
    })
  }
  const sort = (n: TableNode) => {
    // 目录在前，再按名字（数字按大小）
    n.children.sort((a, b) =>
      !a.file !== !b.file ? (a.file ? 1 : -1) : a.name.localeCompare(b.name, undefined, { numeric: true }),
    )
    n.children.forEach(sort)
  }
  sort(root)
  return root.children
}
