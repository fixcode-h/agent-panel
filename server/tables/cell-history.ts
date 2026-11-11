/**
 * 一格的历史：沿着这个文件的版本记录往回取每一版，在服务端找出这一格的值，
 * 不把几十个版本的整张表传给页面。一次取 3 版并行，版本控制命令不会被同时打满
 */
import type { TableSchema } from '../../shared/tables.ts'
import { cellChanges, cellIn, type CellAt, type CellChange } from '../../shared/table-blame.ts'
import { tableAt, tableHistory, type TableRev } from './history.ts'

export interface CellHistory {
  vcs: string
  changes: CellChange<TableRev>[]
  /** 往回看了几个版本（版本记录本身最多取 50 条） */
  scanned: number
  error?: string
}

const PARALLEL = 3

export async function cellHistory(
  cwd: string,
  rel: string,
  schema: TableSchema,
  file: string,
  at: CellAt,
  signal?: AbortSignal,
): Promise<CellHistory> {
  const hist = await tableHistory(cwd, rel)
  if (hist.vcs === 'none' || hist.error) return { vcs: hist.vcs, changes: [], scanned: 0, error: hist.error }
  const values: (string | null)[] = Array.from({ length: hist.revs.length }, () => null)
  let next = 0
  const worker = async () => {
    while (next < hist.revs.length && !signal?.aborted) {
      const i = next++
      // 某一版取不到（文件那时不在、被改名）就当那一版没有这一格
      values[i] = await tableAt(cwd, rel, hist.revs[i].id).then(
        (sheets) => cellIn(schema, file, sheets, at),
        () => null,
      )
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  return { vcs: hist.vcs, changes: cellChanges(hist.revs, values), scanned: values.length }
}
