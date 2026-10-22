import type { FileChange } from '@shared/schema'

export interface ChangeNode {
  name: string
  /** 相对路径：目录是前缀，文件是完整路径 */
  path: string
  dir: boolean
  add: number
  del: number
  children: ChangeNode[]
}

/** 按 / 拆路径建树；目录的增删行数是它下面所有文件的合计 */
export function buildChangeTree(changes: FileChange[]): ChangeNode[] {
  const root: ChangeNode = { name: '', path: '', dir: true, add: 0, del: 0, children: [] }
  const dirs = new Map<string, ChangeNode>([['', root]])
  for (const c of changes) {
    const parts = c.path
      .replace(/\\/g, '/')
      .split('/')
      .filter((p) => p && p !== '.')
    if (!parts.length) continue
    let parent = root
    let acc = ''
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part
      if (i === parts.length - 1) {
        parent.children.push({ name: part, path: c.path, dir: false, add: c.add, del: c.del, children: [] })
        return
      }
      let dir = dirs.get(acc)
      if (!dir) {
        dir = { name: part, path: acc, dir: true, add: 0, del: 0, children: [] }
        dirs.set(acc, dir)
        parent.children.push(dir)
      }
      parent = dir
    })
  }
  const sum = (n: ChangeNode) => {
    for (const child of n.children) {
      if (child.dir) sum(child)
      n.add += child.add
      n.del += child.del
    }
    // 目录在前、文件在后，同类按名字排，和文件树一致
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  }
  sum(root)
  return root.children
}

/**
 * 摊平成可见的行：收起的目录下面不产出。
 * 行数只和展开状态有关，几十上百个文件时也只渲染看得到的那部分。
 */
export function visibleChangeRows(tree: ChangeNode[], collapsed: Set<string>) {
  const out: { node: ChangeNode; depth: number }[] = []
  const walk = (nodes: ChangeNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ node, depth })
      if (node.dir && !collapsed.has(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}
