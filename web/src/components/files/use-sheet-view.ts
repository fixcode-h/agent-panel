/**
 * 表格的查看状态：表头（自动识别或手动设置）、列筛选、排序，算出要显示的数据行。
 * 手动设置的表头：文件弹窗里记在本机浏览器（按文件路径 + 工作表名）；表格页传 store，记进项目的表格结构文件。
 * 两种都不碰表格文件本身（见 designs/表格管理与在线编辑-设计稿.md）。
 */
import { useEffect, useMemo, useState } from 'react'
import { dataStart, detectSheetHeader, validHeader, type SheetHeader } from '@shared/sheet-header'
import { visibleRows, type ColFilter, type ColFilters, type SheetSort } from '@/lib/sheet-filter'

const KEY = 'sheet-header:'

function readSaved(key: string, rowCount: number): SheetHeader | null {
  try {
    const raw = localStorage.getItem(KEY + key)
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return validHeader(v, rowCount) ? v : null
  } catch {
    return null
  }
}

function writeSaved(key: string, h: SheetHeader | null) {
  try {
    if (h) localStorage.setItem(KEY + key, JSON.stringify({ start: h.start, roles: h.roles }))
    else localStorage.removeItem(KEY + key)
  } catch {
    // 隐私模式等存不了：这次照样生效，只是下次打开回到自动识别
  }
}

/** 表格页的表头来源：这张表自己设过的（own）、项目风格里统一的（style），改了写回结构文件 */
export interface SheetHeaderStore {
  own?: SheetHeader
  style?: SheetHeader
  save: (h: SheetHeader | null) => void
}

export interface SheetView {
  header: SheetHeader
  /** 是自动识别的（不是手动设置的） */
  auto: boolean
  /** 用的是项目风格里统一的表头 */
  fromStyle: boolean
  /** 自动识别有没有把握 */
  sure: boolean
  /** 数据从第几行开始（从 0 数） */
  from: number
  /** 要显示的数据行（筛选、排序之后） */
  order: number[]
  shown: Set<number>
  filters: ColFilters
  sort: SheetSort | null
  setHeader: (h: SheetHeader | null) => void
  setFilter: (col: number, f: ColFilter | undefined) => void
  setSort: (s: SheetSort | null) => void
  clearFilters: () => void
  /** 一次换成一整套筛选和排序（套用存下的视图） */
  setAll: (filters: ColFilters, sort: SheetSort | null) => void
}

/** key：文件路径 + 工作表名，换了表就是另一份设置 */
export function useSheetView(key: string, rows: string[][] | null, store?: SheetHeaderStore): SheetView | null {
  const detected = useMemo(() => (rows ? detectSheetHeader(rows) : null), [rows])
  const [saved, setSaved] = useState<SheetHeader | null>(null)
  const [filters, setFilters] = useState<ColFilters>({})
  const [sort, setSort] = useState<SheetSort | null>(null)
  const count = rows?.length ?? 0

  // 换了文件或工作表：读这张表手动设过的表头，筛选和排序清空
  useEffect(() => {
    setSaved(readSaved(key, count))
    setFilters({})
    setSort(null)
  }, [key, count])

  const own = store ? (validHeader(store.own, count) ? store.own : null) : saved
  const style = store && !own && validHeader(store.style, count) ? store.style : null
  const header = own ?? style ?? detected ?? { start: 0, roles: [] }
  const from = dataStart(header)
  const order = useMemo(() => (rows ? visibleRows(rows, from, filters, sort) : []), [rows, from, filters, sort])
  const shown = useMemo(() => new Set(order), [order])
  if (!rows) return null
  return {
    header,
    auto: !own && !style,
    fromStyle: !!style,
    sure: !!own || !!style || !!detected?.sure,
    from,
    order,
    shown,
    filters,
    sort,
    setHeader: (h) => {
      if (store) store.save(h)
      else {
        writeSaved(key, h)
        setSaved(h)
      }
      // 表头变了，数据行跟着变：原来的筛选可能筛的是表头行，清掉
      setFilters({})
      setSort(null)
    },
    setFilter: (col, f) =>
      setFilters((all) => {
        const next = { ...all }
        if (f) next[col] = f
        else delete next[col]
        return next
      }),
    setSort,
    clearFilters: () => {
      setFilters({})
      setSort(null)
    },
    setAll: (f, s) => {
      setFilters(f)
      setSort(s)
    },
  }
}
