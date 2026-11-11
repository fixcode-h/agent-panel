/**
 * 表格页一张表的结构：每列是什么（按表头和结构文件）、枚举 / 引用列能选的值（需要时去读枚举表、被引用的表）、
 * 哪些格子不合规。改一格就重算一遍（纯函数，一万行的表也在几十毫秒内）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SheetData } from '@shared/files'
import type { SheetHeader } from '@shared/sheet-header'
import type { TableDoc, TableSchema } from '@shared/tables'
import {
  checkHeader,
  checkSheet,
  columnInfos,
  columnOptions,
  neededFiles,
  type Problem,
  type RowProblems,
} from '@shared/table-struct'
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
  // 列的结构只看表头那几行：改数据格子时表头行还是同一批数组，列结构不重算（下面按行的检查缓存也就不作废）
  const headRows = useStable(rows ? rows.slice(0, from) : [])
  const infos = useMemo(
    () => (header && sheet ? columnInfos(schema, headRows, header, doc.path, sheet.name, cols) : []),
    [schema, headRows, header, doc.path, sheet, cols],
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
  // 每行的检查结果按行数组缓存：改一格只重查那一行；列结构、枚举、引用变了就换新的
  // 依赖是故意的：函数体不用它们，但它们变了缓存就作废
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const rowCache = useMemo(() => new WeakMap<string[], RowProblems>(), [infos, opts.ctx])
  const problems = useMemo<Problem[]>(
    () =>
      rows
        ? [
            ...(header ? checkHeader(rows, header, infos, schema, opts.ctx) : []),
            ...checkSheet(rows, from, infos, schema.style.key, opts.ctx, 2000, rowCache),
          ]
        : [],
    [rows, from, infos, schema, header, opts.ctx, rowCache],
  )
  const problemAt = useMemo(() => new Map(problems.map((p) => [`${p.r}:${p.c}`, p.msg])), [problems])
  return { infos, ...opts, problems, problemAt }
}

/** 数组里每一项都和上次是同一个对象时，返回上次那个数组（给 useMemo 当依赖） */
function useStable<T>(list: T[]): T[] {
  const ref = useRef(list)
  const prev = ref.current
  if (prev !== list && (prev.length !== list.length || list.some((x, i) => x !== prev[i]))) ref.current = list
  return ref.current
}
