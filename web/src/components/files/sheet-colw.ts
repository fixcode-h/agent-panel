import { useMemo } from 'react'
import { dataStart, type SheetHeader } from '@shared/sheet-header'
import { colName, colWidths } from '@/lib/sheet'
import type { SheetColHead } from './SheetTable'
import type { GridLook, SheetColKind } from './sheet-kinds'

/**
 * 数据表格的自动列宽：按数据行和表头行估（colWidths），两行列头时再量字段名、类型标签，取大的，
 * 「uint32 [ ]」这类标签不被截断。表格是虚拟滚动的，屏幕外的格子不在页面里，只能自己量：
 * 列头用 canvas 按真实字体量（结果按字体 + 文字缓存），数据只看前几百行（colWidths 里采样）。
 */

/** 枚举胶囊的左右内边距加起来大约这么宽 */
const PILL_PAD = 18
/** 格子左右内边距（px-2）+ 右边线 */
const CELL_PAD = 17
/** 字段名和右上角列字母之间、两个标签之间的空隙（gap-1） */
const GAP = 4
/** 标签左右内边距（0.25rem × 2，按 rem 算） */
const TAG_PAD_REM = 0.5
/** 能筛选时标签行右下角压着筛选按钮，给它留出位置 */
const FILTER_W = 22

let ctx: CanvasRenderingContext2D | null | undefined
const cache = new Map<string, number>()
/** 量一段文字的像素宽：同一个字体 + 文字只量一次（几百列的表换页、重渲染不重复量） */
function textW(font: string, text: string): number {
  const key = `${font}\u0000${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  if (ctx === undefined)
    ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  // 量不了（测试环境没有 canvas）按等宽字体估：每个字半个字号，中日韩文字一个字号
  let w: number
  if (ctx) {
    ctx.font = font
    w = ctx.measureText(text).width
  } else {
    const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '12')
    w = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? px : px * 0.6), 0)
  }
  if (cache.size > 5000) cache.clear()
  cache.set(key, w)
  return w
}

/** 两行列头这一列要多宽才不截断：字段名 + 列字母一行、标签一行（加筛选按钮），取宽的那行 */
export function headWidth(head: SheetColHead, col: number, look: GridLook, filter: boolean): number {
  const cap = look.rem * 0.6875
  const tag = look.rem * look.tagRem
  const top = head.field
    ? textW(`600 ${cap}px ${look.font}`, head.field) + GAP + textW(`400 ${cap}px ${look.font}`, colName(col))
    : 0
  let bottom = 0
  head.tags.forEach((g, i) => {
    bottom += textW(`400 ${tag}px ${look.font}`, g.text) + TAG_PAD_REM * look.rem + (i ? GAP : 0)
  })
  if (bottom && filter) bottom += FILTER_W
  return Math.ceil(Math.max(top, bottom) + CELL_PAD)
}

/** 列头算成一串字：表格页每次渲染都给新的 colHead 函数，列宽只在列头真的变了时重算 */
const headSig = (heads: (SheetColHead | undefined)[]) =>
  heads.map((h) => (h ? `${h.field}\u0001${h.tags.map((g) => g.text).join('\u0002')}` : '')).join('\u0003')

/**
 * 每列宽度（px）：拖过的用拖的；没拖过的按内容和列头自动算，最宽到设置里的上限。隐藏的列宽度当 0（位置照算，画的时候跳过）。
 * 列宽改了会连带重算看得见哪些列，所以依赖都换成稳定的值（字符串、数字），不跟着每次渲染变
 */
export function useColW({
  rows,
  header,
  cols,
  kinds,
  colHead,
  look,
  dragged,
  hidden,
  filter,
}: {
  rows: string[][]
  header: SheetHeader
  cols: number
  kinds: (SheetColKind | undefined)[]
  colHead?: (c: number) => SheetColHead | undefined
  look: GridLook
  dragged: Record<number, number>
  hidden: Set<number>
  filter: boolean
}) {
  const max = look.colMax
  const from = dataStart(header)
  // 列宽看数据行和除注释外的表头行：长长的中文注释不该把列撑宽，截断后悬停看全
  const widths = useMemo(() => {
    if (!header.roles.length) return colWidths(rows, cols, max)
    const head = header.roles.flatMap((r, i) => (r === 'comment' ? [] : [rows[header.start + i] ?? []]))
    return colWidths([...head, ...rows.slice(from)], cols, max)
  }, [rows, from, header, cols, max])
  const heads = colHead && look.fitHead ? Array.from({ length: cols }, (_, c) => colHead(c)) : []
  const sig = headSig(heads)
  const { font, rem, tagRem } = look
  const headW = useMemo(
    () => heads.map((h, c) => (h ? headWidth(h, c, look, filter) : 0)),
    // heads、look 每次渲染都是新的：只按算出来的字符串和量字用到的字体、字号重算
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [sig, font, rem, tagRem, filter],
  )
  // 枚举画成胶囊时左右多了内边距：按内容估的列宽给这几列加一点，免得「TabletopDecor」刚好被截断
  const pillCols = look.pills ? kinds.flatMap((k, c) => (k?.kind === 'enum' ? [c] : [])).join(',') : ''
  return useMemo(() => {
    const pill = new Set(pillCols ? pillCols.split(',').map(Number) : [])
    return widths.map((w, c) => {
      if (hidden.has(c)) return 0
      if (dragged[c] !== undefined) return dragged[c]
      const auto = pill.has(c) ? Math.min(w + PILL_PAD, max) : w
      return Math.max(auto, Math.min(headW[c] ?? 0, max))
    })
  }, [widths, dragged, hidden, pillCols, headW, max])
}

/**
 * 双击列边线：按看得见的这一段（最多 200 行）加表头量这一列的宽度，不扫整列（几万行的表也不顿）。
 * 两行列头的字段名、类型标签也量进去
 */
export function fitColWidth(
  c: number,
  {
    rows,
    header,
    body,
    winFrom,
    head,
    look,
    filter,
  }: {
    rows: string[][]
    header: SheetHeader
    body: number[]
    winFrom: number
    head?: SheetColHead
    look: GridLook
    filter: boolean
  },
) {
  const sample: string[][] = []
  header.roles.forEach((r, i) => r !== 'comment' && sample.push([rows[header.start + i]?.[c] ?? '']))
  for (const r of body.slice(winFrom, winFrom + 200)) sample.push([rows[r]?.[c] ?? ''])
  const data = colWidths(sample, 1, look.colMax)[0]
  return head ? Math.max(data, Math.min(headWidth(head, c, look, filter), look.colMax)) : data
}
