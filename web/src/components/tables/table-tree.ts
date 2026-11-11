/** 表格页文件树的数据：把相对路径列表拼成目录树，名字搜索时只留命中的文件 */
import type { TableFile } from '@shared/tables'
import { pinyinInitials } from '@shared/pinyin'

export interface TableNode {
  name: string
  path: string
  /** 文件才有 */
  file?: TableFile
  children: TableNode[]
  /** 目录下（含子目录）的文件数 */
  count: number
}

/** 路径的拼音首字母：几千个文件每输一个字都要比一遍，算过的留着 */
const initials = new Map<string, string>()
function initialsOf(path: string) {
  let v = initials.get(path)
  if (v === undefined) {
    v = pinyinInitials(path)
    if (initials.size > 50_000) initials.clear()
    initials.set(path, v)
  }
  return v
}

/** 名字搜索：空格分开的几个词都要出现在路径里（不分大小写）；字母词也认拼音首字母（jsb 找「角色表」） */
export function nameHit(path: string, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const p = path.toLowerCase()
  return words.every((w) => p.includes(w) || (/^[a-z]+$/.test(w) && initialsOf(path).includes(w)))
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
  return root.children.map(compactAbs)
}

/**
 * 顶层开头一串只有一个子目录的目录并成一个节点（Project/Designer/Excel、F:/Game/Designer/Excel、/data/excel），
 * 不然树最上面要一层层点开
 */
function compactAbs(n: TableNode): TableNode {
  if (n.file) return n
  let at = n
  let name = n.name
  while (at.children.length === 1 && !at.children[0].file) {
    at = at.children[0]
    name = `${name}/${at.name}`
  }
  return { ...at, name: name || '/' }
}

/** 文件名太长时截中间：保留开头和扩展名（C_HomeDeco…Config.xlsx） */
export function middleEllipsis(name: string, max = 28) {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const stem = dot > 0 ? name.slice(0, dot) : name
  const keep = max - ext.length - 1
  const head = Math.ceil(keep * 0.6)
  return `${stem.slice(0, head)}…${stem.slice(stem.length - (keep - head))}${ext}`
}
