import type { SheetLink, SheetLook, SheetMerge, SheetNote } from '@shared/files'
import { t } from '@shared/i18n'

/**
 * 数据表格（SheetTable）还原 xlsx 的显示：合并单元格画成一格、批注右上角一个角标（悬停看内容）、
 * 超链接画成链接、整行底色在行号左边画一条色条（宽度和开关在设置 → 组件 → 数据表格）。都只读：
 * 服务端从 xlsx 里读出来（server/sheets/xlsx-look.ts），保存只改格子的值，这些原样留在文件里。
 * 按行建索引，画一行时只查这一行，几万行的表也不用每格去扫整张清单。
 */
export interface LookIndex {
  /** 盖住第 r 行的合并区（只有这一行用得上的那几块） */
  merges: (r: number) => SheetMerge[] | undefined
  note: (r: number, c: number) => SheetNote | undefined
  link: (r: number, c: number) => SheetLink | undefined
  fill: (r: number) => string | undefined
}

/** 一行最多记这么多块合并区：再多的表按普通格子画，免得一行查半天 */
const MAX_PER_ROW = 64
/** 合并区按行展开的总条数上限：竖着合并几万行的表只还原前面一部分 */
const MAX_ROW_ENTRIES = 200_000

export function lookIndex(look: SheetLook | undefined): LookIndex | undefined {
  if (!look) return undefined
  const byRow = new Map<number, SheetMerge[]>()
  let entries = 0
  for (const m of look.merges ?? []) {
    for (let r = m.r; r < m.r + m.rows && entries < MAX_ROW_ENTRIES; r++) {
      let list = byRow.get(r)
      if (!list) byRow.set(r, (list = []))
      if (list.length >= MAX_PER_ROW) continue
      list.push(m)
      entries++
    }
  }
  const cellKey = (r: number, c: number) => r * 16_384 + c
  const notes = new Map((look.notes ?? []).map((n) => [cellKey(n.r, n.c), n]))
  const links = new Map((look.links ?? []).map((l) => [cellKey(l.r, l.c), l]))
  const fills = new Map((look.fills ?? []).map((f) => [f.r, f.color]))
  return {
    merges: (r) => byRow.get(r),
    note: (r, c) => (notes.size ? notes.get(cellKey(r, c)) : undefined),
    link: (r, c) => (links.size ? links.get(cellKey(r, c)) : undefined),
    fill: (r) => (fills.size ? fills.get(r) : undefined),
  }
}

/** 第 c 列落在哪块合并区里 */
export const mergeAt = (list: SheetMerge[] | undefined, c: number) => list?.find((m) => c >= m.c && c < m.c + m.cols)

/**
 * 一段要画的列（from 到 to，不含 to）里，按合并区把相邻几列并成一格：返回每一格从哪列开始、并了几列、属于哪块合并区。
 * 合并区跨出这一段时只并这一段里的（冻结列和滚动区各画各的；屏幕外的列本来就没画）
 */
export function mergedRuns(
  list: SheetMerge[] | undefined,
  from: number,
  to: number,
  visible: (c: number) => boolean,
): { c: number; end: number; m?: SheetMerge }[] {
  const out: { c: number; end: number; m?: SheetMerge }[] = []
  for (let c = from; c < to; c++) {
    if (!visible(c)) continue
    const m = list ? mergeAt(list, c) : undefined
    if (!m) {
      out.push({ c, end: c + 1 })
      continue
    }
    const end = Math.min(m.c + m.cols, to)
    out.push({ c, end, m })
    c = end - 1
  }
  return out
}

/** 一格还原出来的样式和悬停说明 */
export function lookCell(idx: LookIndex | undefined, r: number, c: number) {
  if (!idx) return undefined
  const note = idx.note(r, c)
  const link = idx.link(r, c)
  if (!note && !link) return undefined
  const tips: string[] = []
  if (note) tips.push(note.author ? `${note.author}：${note.text}` : note.text)
  if (link) {
    const where = link.url ?? t('本表位置 {loc}', { loc: link.loc ?? '' })
    tips.push(link.tip ? `${link.tip}\n${where}` : where)
  }
  return {
    note,
    link,
    cls: [note && 'sheet-note', link && 'sheet-link'].filter(Boolean).join(' '),
    tip: tips.join('\n\n'),
  }
}

/**
 * 点了超链接：外部地址在新标签页打开；表内位置（Sheet2!A1）交给表格（切表、选中那一格），没有处理的就算了。
 * 能编辑的表格单击是选格子，所以那里要按住 Ctrl / ⌘ 点（和引用列跳转一样）
 */
export function openLink(link: SheetLink, onLocate?: (loc: string) => void) {
  if (link.url) {
    window.open(link.url, '_blank', 'noopener,noreferrer')
    return
  }
  if (link.loc && onLocate) onLocate(link.loc)
}

/** 「Sheet2!B3」「'物品 表'!A1」「B3」→ 表名和行列（行列从 0 数）；认不出返回 undefined */
export function parseLoc(loc: string): { sheet?: string; r: number; c: number } | undefined {
  const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::.*)?$/.exec(loc.trim())
  if (!m) return undefined
  let c = 0
  for (const ch of m[3].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64)
  const sheet = m[1] ? m[1].replace(/''/g, "'") : m[2]
  return { ...(sheet ? { sheet } : {}), r: Number(m[4]) - 1, c: c - 1 }
}

/** 行号格上的整行底色色条：颜色走 CSS 变量，宽度读设置（--c-grid-rowMark，关掉是 0） */
export function rowMark(idx: LookIndex | undefined, r: number) {
  const color = idx?.fill(r)
  if (!color) return undefined
  return {
    cls: 'sheet-rowmark',
    style: { '--row-mark': color } as React.CSSProperties,
    tip: t('这一行在表格里标了底色 {color}', { color }),
  }
}

/** 工作表切换条的顺序：看得见的表照原顺序，隐藏的（Excel 里 state="hidden"）排在最后；返回原数组里的下标 */
export function sheetOrder(sheets: { hidden?: boolean }[]): number[] {
  const idx = sheets.map((_, i) => i)
  return [...idx.filter((i) => !sheets[i].hidden), ...idx.filter((i) => sheets[i].hidden)]
}

/** 打开一个文件时默认停在哪张表：第一张没隐藏的（全都隐藏就第一张） */
export const firstShownSheet = (sheets: { hidden?: boolean }[]) =>
  Math.max(
    0,
    sheets.findIndex((s) => !s.hidden),
  )

/** 画一列（或并成一格的几列）：宽度、第几列、是不是冻结列、属于哪块合并区 */
export type ColDraw = (w: number, c: number, pin: boolean, m?: SheetMerge) => React.ReactNode

/**
 * 一行要画的格子：冻结的前几列 + 看得见的那段（c0 到 c1），隐藏的列（宽 0）跳过，中间用 gapL 占住左边没画的列。
 * 给了这一行的合并区时，合并的几列并成一格画（宽度相加）
 */
export function spanCols(
  g: { colW: number[]; lefts: number[]; fz: number; c0: number; c1: number; gapL: React.ReactNode },
  f: ColDraw,
  merges?: SheetMerge[],
) {
  const out: React.ReactNode[] = []
  const shown = (c: number) => g.colW[c] > 0
  const runs = (a: number, b: number, pin: boolean) => {
    if (!merges) {
      for (let c = a; c < b; c++) if (shown(c)) out.push(f(g.colW[c], c, pin))
      return
    }
    for (const run of mergedRuns(merges, a, b, shown)) out.push(f(g.lefts[run.end] - g.lefts[run.c], run.c, pin, run.m))
  }
  runs(0, g.fz, true)
  out.push(g.gapL)
  runs(g.c0, g.c1, false)
  return out
}

/** 格子里的字：有超链接时画成链接（能编辑的表格单击是选格子，按住 Ctrl / ⌘ 点才打开；只看的表格单击就开） */
export function CellText({
  text,
  link,
  editable,
  onLocate,
}: {
  text: React.ReactNode
  link?: SheetLink
  editable: boolean
  onLocate?: (loc: string) => void
}) {
  if (!link || !text) return text
  return (
    <a
      href={link.url ?? '#'}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault()
        if (!editable || e.ctrlKey || e.metaKey) openLink(link, onLocate)
      }}
      className="sheet-link-text"
    >
      {text}
    </a>
  )
}
