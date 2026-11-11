/**
 * 表格页一张表的结构：每列是什么（按表头和结构文件）、枚举 / 引用列能选的值（需要时去读枚举表、被引用的表）、
 * 哪些格子不合规。改一格就重算一遍（纯函数，一万行的表也在几十毫秒内）
 */
import { useEffect, useMemo, useState } from 'react'
import type { SheetData } from '@shared/files'
import type { SheetHeader } from '@shared/sheet-header'
import type { TableDoc, TableSchema } from '@shared/tables'
import { checkHeader, checkSheet, columnInfos, columnOptions, neededFiles, type Problem } from '@shared/table-struct'
import { colCount } from '@/lib/sheet'

export function useTableStruct({
  schema,
  doc,
  sheet,
  rows,
  header,
  from,
  loadDoc,
}: {
  schema: TableSchema
  doc: TableDoc
  sheet: SheetData | undefined
  rows: string[][] | null
  header: SheetHeader | undefined
  from: number
  /** 读别的表格文件（枚举表、被引用的表）；读不到给 undefined */
  loadDoc: (path: string) => Promise<TableDoc | undefined>
}) {
  const cols = useMemo(() => (rows ? colCount(rows) : 0), [rows])
  const infos = useMemo(
    () => (rows && header && sheet ? columnInfos(schema, rows, header, doc.path, sheet.name, cols) : []),
    [schema, rows, header, doc.path, sheet, cols],
  )
  const need = useMemo(() => neededFiles(schema, infos).filter((f) => f !== doc.path), [schema, infos, doc.path])
  const [ext, setExt] = useState<Record<string, SheetData[]>>({})
  const needKey = need.join('\n')
  useEffect(() => {
    let live = true
    for (const f of need)
      if (!ext[f])
        void loadDoc(f).then((d) => {
          if (live && d) setExt((m) => ({ ...m, [f]: d.sheets }))
        })
    return () => {
      live = false
    }
    // 按要读的文件列表变化重读；ext 变了不用再跑（读到的就在里面）
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, loadDoc])
  const opts = useMemo(
    () => columnOptions(schema, infos, (f) => (f === doc.path ? doc.sheets : ext[f])),
    [schema, infos, doc, ext],
  )
  const problems = useMemo<Problem[]>(
    () =>
      rows
        ? [
            ...(header ? checkHeader(rows, header, infos, schema, opts.ctx) : []),
            ...checkSheet(rows, from, infos, schema.style.key, opts.ctx),
          ]
        : [],
    [rows, from, infos, schema, header, opts.ctx],
  )
  const problemAt = useMemo(() => new Map(problems.map((p) => [`${p.r}:${p.c}`, p.msg])), [problems])
  return { infos, ...opts, problems, problemAt }
}
