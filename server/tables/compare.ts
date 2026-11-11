/**
 * 跨项目对比（典型是同一个游戏的 Trunk 和 Release 两个工作区）：按相对路径配对两边的表格文件，
 * 标出相同 / 有差异 / 只在一边。比的是解析出来的格子（同样的内容另存一次字节会变，不能比文件字节）。只读。
 */
import path from 'node:path'
import type { TableFile, TablesConfig } from '../../shared/tables.ts'
import { listTables, parseTable } from './files.ts'

export type PairStatus = 'same' | 'diff' | 'left' | 'right' | 'error'

export interface TablePair {
  path: string
  status: PairStatus
  error?: string
}

/** 一次最多比这么多个文件：再多的只按「在不在」列出 */
const MAX_PARSE = 3000

export async function compareProjects(
  left: { dir: string; cfg: TablesConfig },
  right: { dir: string; cfg: TablesConfig },
): Promise<{ pairs: TablePair[]; truncated?: boolean }> {
  const [l, r] = await Promise.all([listTables(left.dir, left.cfg), listTables(right.dir, right.cfg)])
  const rmap = new Map<string, TableFile>(r.files.map((f) => [f.path, f]))
  const pairs: TablePair[] = []
  let parsed = 0
  for (const f of l.files) {
    if (!rmap.has(f.path)) {
      pairs.push({ path: f.path, status: 'left' })
      continue
    }
    rmap.delete(f.path)
    if (f.kind === 'xls' || parsed >= MAX_PARSE) {
      pairs.push({ path: f.path, status: 'diff' })
      continue
    }
    parsed++
    try {
      const [a, b] = await Promise.all([
        parseTable(path.join(left.dir, f.path)),
        parseTable(path.join(right.dir, f.path)),
      ])
      pairs.push({ path: f.path, status: JSON.stringify(a.sheets) === JSON.stringify(b.sheets) ? 'same' : 'diff' })
    } catch (e) {
      pairs.push({ path: f.path, status: 'error', error: (e as Error).message })
    }
  }
  for (const p of rmap.keys()) pairs.push({ path: p, status: 'right' })
  pairs.sort((a, b) => a.path.localeCompare(b.path))
  return { pairs, ...(l.truncated || r.truncated || parsed >= MAX_PARSE ? { truncated: true } : {}) }
}
