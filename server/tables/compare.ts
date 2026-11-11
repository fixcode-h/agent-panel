/**
 * 跨项目对比（典型是同一个游戏的 Trunk 和 Release 两个工作区）：按相对路径配对两边的表格文件，
 * 标出相同 / 有差异 / 只在一边。比的是解析出来的格子（同样的内容另存一次字节会变，不能比文件字节）。只读。
 */
import path from 'node:path'
import type { TableFile, TablesConfig } from '../../shared/tables.ts'
import { absPath, listTables, parseTable, tableFull } from './files.ts'

export type PairStatus = 'same' | 'diff' | 'left' | 'right' | 'error'

export interface TablePair {
  /** 配对用的路径：项目目录里的表格是相对项目目录的路径；项目目录外的是「表格目录名/目录里的路径」 */
  path: string
  /** 和 path 不一样时，两边各自的真实路径（项目目录外的表格目录） */
  left?: string
  right?: string
  status: PairStatus
  error?: string
}

/** 一次最多比这么多个文件：再多的只按「在不在」列出 */
const MAX_PARSE = 3000

/**
 * 配对用的路径：项目目录外的表格目录（绝对路径，比如 F:/Trunk/Designer/Excel 和 F:/Release/Designer/Excel）
 * 换成「目录名/里面的路径」，两个工作区的同一张表才能配上
 */
function pairKey(file: string, roots: string[]) {
  const root = roots.find((d) => absPath(d) && file.startsWith(`${d}/`))
  return root ? `${path.posix.basename(root)}/${file.slice(root.length + 1)}` : file
}

export async function compareProjects(
  left: { dir: string; cfg: TablesConfig },
  right: { dir: string; cfg: TablesConfig },
): Promise<{ pairs: TablePair[]; truncated?: boolean }> {
  const [l, r] = await Promise.all([listTables(left.dir, left.cfg), listTables(right.dir, right.cfg)])
  const rmap = new Map<string, TableFile>(r.files.map((f) => [pairKey(f.path, r.dirs), f]))
  const pairs: TablePair[] = []
  const named = (key: string, lp?: string, rp?: string): Omit<TablePair, 'status'> => ({
    path: key,
    ...(lp && lp !== key ? { left: lp } : {}),
    ...(rp && rp !== key ? { right: rp } : {}),
  })
  let parsed = 0
  for (const f of l.files) {
    const key = pairKey(f.path, l.dirs)
    const other = rmap.get(key)
    if (!other) {
      pairs.push({ ...named(key, f.path), status: 'left' })
      continue
    }
    rmap.delete(key)
    const base = named(key, f.path, other.path)
    if (f.kind === 'xls' || parsed >= MAX_PARSE) {
      pairs.push({ ...base, status: 'diff' })
      continue
    }
    parsed++
    try {
      const [a, b] = await Promise.all([
        parseTable(tableFull(left.dir, f.path)),
        parseTable(tableFull(right.dir, other.path)),
      ])
      pairs.push({ ...base, status: JSON.stringify(a.sheets) === JSON.stringify(b.sheets) ? 'same' : 'diff' })
    } catch (e) {
      pairs.push({ ...base, status: 'error', error: (e as Error).message })
    }
  }
  for (const [key, f] of rmap) pairs.push({ ...named(key, undefined, f.path), status: 'right' })
  pairs.sort((a, b) => a.path.localeCompare(b.path))
  return { pairs, ...(l.truncated || r.truncated || parsed >= MAX_PARSE ? { truncated: true } : {}) }
}
