import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ListFilter } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SheetLook, SheetMerge } from '@shared/files'
import { dataStart, type SheetHeader } from '@shared/sheet-header'
import { colCount, colName, colWidths, type CellHit } from '@/lib/sheet'
import { filterActive, type ColFilter, type ColFilters, type SheetSort } from '@/lib/sheet-filter'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Popover,
  PopoverTrigger,
} from '@/components/ui/menu'
import { SheetColumnFilter } from './SheetColumnFilter'
import { roleShort } from './sheet-roles'
import { lookIndex, rowMark, spanCols, type ColDraw } from './sheet-look'
import { CELL, SheetCell, pinCls as pinClsOf, pinned as pinnedOf, type CellCtx } from './sheet-cell'
import { CellHint, cellTip, type SheetTip } from './sheet-hint'
import { inferColKinds, neighborCols, useGridLook, type SheetColKind } from './sheet-kinds'
// 表格插件经开放模块只拿得到这个文件：切表、表内链接要用的几个一起从这里给
export { firstShownSheet, parseLoc, sheetOrder } from './sheet-look'
import './sheet-table.css'

/** 行号列宽：有表头时左边还要写行的角色（修饰、类型…） */
const NUM_W = 52
const NUM_W_ROLE = 74
/** 屏幕外上下各多画几行，滚一点点不用等 */
const OVER = 12
/** 画哪些行按这么多行一档变：滚动时不是每一帧都重新渲染 */
const STEP = 8
const NO_HEADER: SheetHeader = { start: 0, roles: [] }

// 行号列、列名行钉在边上，底色用表格自己的底色（sheet-table.css 的 --sheet-bg）盖住滚过去的格子
const STICKY = 'sticky bg-(--sheet-bg) text-subtle select-none'
/** 看得见的列左右再多画几列；按这个步长取整，滚一点点不用重画 */
const COL_OVER = 3
const COL_STEP = 4
/** 枚举胶囊的左右内边距加起来大约这么宽 */
const PILL_PAD = 18
/** 铺满时空列的宽度 */
const PAD_W = 96
/** 拖列宽的范围 */
const MIN_COL_W = 36
const MAX_COL_W = 800

/** 表格页的列布局：冻结前几列、隐藏哪些列（按文件记在本机，表格文件不动） */
export interface ColLayout {
  freeze: number
  hidden: number[]
}

/** 拖过的列宽：按 key 记在本机，表格文件不动 */
function useColWidths(key: string | undefined) {
  const store = key ? `sheet-colw:${key}` : ''
  const read = () => {
    if (!store) return {}
    try {
      return JSON.parse(localStorage.getItem(store) ?? '{}') as Record<number, number>
    } catch {
      return {}
    }
  }
  const [state, setState] = useState<{ key: string; w: Record<number, number> }>(() => ({ key: store, w: read() }))
  const w = state.key === store ? state.w : read()
  const set = (c: number, v: number | undefined) => {
    const next = { ...w }
    if (v === undefined) delete next[c]
    else next[c] = Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, v)))
    setState({ key: store, w: next })
    try {
      localStorage.setItem(store, JSON.stringify(next))
    } catch {
      // 存不了（隐私模式）就只在这次打开里有效
    }
  }
  return [w, set] as const
}

/** 列名格右边线：按住左右拖改列宽，双击按内容自适应 */
function ResizeHandle({
  col,
  width,
  onResize,
}: {
  col: number
  width: number
  onResize: (w: number | undefined) => void
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={t('拖动调整 {col} 列宽度', { col: colName(col) })}
      title={t('拖动调整列宽，双击按内容自适应')}
      onDoubleClick={() => onResize(undefined)}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const x0 = e.clientX
        let frame = 0
        let last = width
        const move = (ev: MouseEvent) => {
          last = width + ev.clientX - x0
          if (!frame)
            frame = requestAnimationFrame(() => {
              frame = 0
              onResize(last)
            })
        }
        const up = () => {
          if (frame) cancelAnimationFrame(frame)
          onResize(last)
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          document.body.style.cursor = ''
        }
        document.body.style.cursor = 'col-resize'
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
      className="absolute top-0 right-0 z-1 h-full w-1.5 cursor-col-resize hover:bg-accent/50"
    />
  )
}

/** 行高读设置 → 组件 → 数据表格的 --c-grid-rowH（虚拟滚动要按它算位置）；版本差异这些自己画行的地方也用 */
export const useRowH = () => useGridLook().rowH

export type { SheetColKind } from './sheet-kinds'
export type { SheetTip } from './sheet-hint'
export { SheetTabs } from './sheet-tabs'

/** 两行列头的一个小标签：类型、枚举、引用、数组、必填，颜色跟着表头行的颜色（设置里调） */
export interface SheetColTag {
  text: string
  tone: 'type' | 'enum' | 'ref' | 'list' | 'req'
  /** 悬停说明（引用的完整目标、枚举名…） */
  title?: string
}
/** 两行列头：上面字段名，下面类型标签；字母 A、B、C 降成右上角的灰色小字 */
export interface SheetColHead {
  field: string
  tags: SheetColTag[]
}

/** 表格页编辑用：选中的一块、当前格、正在改的格子、格子的额外标记（改过、不合规） */
export interface SheetEditing {
  /** 这一格在不在选中的一块里（筛选排序后选中的行不一定连着，交给调用方判断） */
  picked: (r: number, c: number) => boolean
  focus: { row: number; col: number } | null
  /** 每次移动当前格加一：把它滚进视野 */
  focusSeq: number
  /** 正在改的格子和编辑框 */
  editing: { r: number; c: number; node: React.ReactNode } | null
  /** 格子的额外样式类（改过、不合规） */
  mark?: (r: number, c: number) => string | undefined
  /** 格子的悬停说明（不合规的原因）；不给就是格子的内容 */
  /** 格子的悬停说明（不合规的原因 / 规则 / 允许的值）；不给时截断了的格子悬停看完整内容 */
  tip?: (r: number, c: number) => string | SheetTip | undefined
  onDown: (r: number, c: number, e: React.MouseEvent) => void
  onEnter: (r: number, c: number, e: React.MouseEvent) => void
  onDouble: (r: number, c: number) => void
  /** 行号格的右键菜单（插入、删除行） */
  rowMenu?: (r: number, trigger: React.ReactElement) => React.ReactNode
  /** 格子里显示的字（引用列显示成「1001 · 小明」）；存的还是原值，不给就照原样显示 */
  display?: (r: number, c: number, text: string) => string
  /** 按下行号 / 列名：选整行、整列（按住拖动接着选，Shift 扩大） */
  onRowDown?: (r: number, e: React.MouseEvent) => void
  onColDown?: (c: number, e: React.MouseEvent) => void
  /** 填充柄：画在选区右下角那一格上，按住往外拖就填充 */
  handle?: { r: number; c: number; onDown: (e: React.MouseEvent) => void }
  /** 当前格的 id：外面能聚焦的表格容器用 aria-activedescendant 指过来（读屏跟着当前格走） */
  focusId?: string
}

/**
 * 数据表格：CSV / TSV 和 xlsx 的一张表（行 × 列的文字）。带 Excel 那样的列名（A、B、C）和行号，
 * 只画看得见的行（一万行的配置表打开也只有几百个格子）；每格一行、太长的截断，悬停看完整内容。
 * 有表头（header）时表头每行按角色一种底色、和列名行一起钉在顶上；order 是筛选排序后要显示的数据行。
 * 屏幕外的行不在页面里，搜索由外面做：命中的格子从 hits 传进来，当前那一格滚进视野。
 * 文件弹窗和设置 → 组件里的样例都用它，样式在设置里调。
 */
export function SheetTable({
  rows,
  scrollEl,
  hits,
  current,
  seq,
  header = NO_HEADER,
  order,
  filters,
  sort,
  onFilter,
  onSort,
  edit,
  fill,
  widthKey,
  layout,
  onLayout,
  colHead,
  headCollapsed,
  onHeadCollapse,
  rowHeight,
  look,
  onLocate,
  colKind,
}: {
  /** 每列的显示方式（数字右对齐、布尔小勾、枚举胶囊）：表格页按列结构给；不传按表头类型行或数据猜 */
  colKind?: (c: number) => SheetColKind | undefined
  /** xlsx 里读出的合并单元格、批注、超链接、整行底色（只读，见 sheet-look.tsx） */
  look?: SheetLook
  /** 点了表内位置的超链接（Sheet2!A1）：切表、选中那一格；不传就只显示 */
  onLocate?: (loc: string) => void
  /** 行高：表格页的密度（紧凑 / 宽松）；不传按设置 → 组件 → 数据表格 */
  rowHeight?: number
  /** 传了列头就是两行：字段名 + 类型标签（表格页用，按列结构算） */
  colHead?: (c: number) => SheetColHead | undefined
  /** 表头行折起来：只看两行列头和数据，省出表头那几行的高度 */
  headCollapsed?: boolean
  /** 传了左上角就有折叠表头的按钮 */
  onHeadCollapse?: (v: boolean) => void
  /** 冻结前几列、隐藏的列（表格页按文件记在本机） */
  layout?: ColLayout
  /** 传了才能在列名上右键冻结、隐藏 */
  onLayout?: (l: ColLayout) => void
  /** 表格页传：能选中、改格子 */
  edit?: SheetEditing
  /** 数据画不满滚动区时，右边和下面接着画空格子（像 Excel）；滚动区高度要固定，不能跟着内容长 */
  fill?: boolean
  /** 拖过的列宽记在本机（localStorage）用的键，一般是文件路径；不传就不能拖 */
  widthKey?: string
  rows: string[][]
  /** 外面的滚动容器 */
  scrollEl: React.RefObject<HTMLDivElement | null>
  /** 搜索命中的格子 */
  hits?: CellHit[]
  /** 当前是第几处命中 */
  current?: number
  /** 每按一次上一个 / 下一个加一：停在同一处也要重新滚过去 */
  seq?: number
  /** 表头：这几行钉在顶上、按角色上色 */
  header?: SheetHeader
  /** 要显示的数据行（行号）；不传就是表头以下全部 */
  order?: number[]
  filters?: ColFilters
  sort?: SheetSort | null
  /** 传了才在列名上画筛选按钮 */
  onFilter?: (col: number, f: ColFilter | undefined) => void
  onSort?: (s: SheetSort | null) => void
}) {
  const gridLook = useGridLook()
  const rowH = rowHeight ?? gridLook.rowH
  const gridRef = useRef<HTMLDivElement>(null)
  const from = dataStart(header)
  const numW = header.roles.length ? NUM_W_ROLE : NUM_W
  const cols = useMemo(() => colCount(rows), [rows])
  const lookIdx = useMemo(() => lookIndex(look), [look])
  const body = useMemo(() => order ?? rows.slice(from).map((_, i) => from + i), [order, rows, from])
  const guessed = useMemo(
    () => (colKind ? null : inferColKinds(rows, header, from, cols)),
    [colKind, rows, header, from, cols],
  )
  const kinds = guessed ?? Array.from({ length: cols }, (_, c) => colKind?.(c))
  // 列宽看数据行和除注释外的表头行：长长的中文注释不该把列撑宽，截断后悬停看全
  const widths = useMemo(() => {
    if (!header.roles.length) return colWidths(rows, cols)
    const head = header.roles.flatMap((r, i) => (r === 'comment' ? [] : [rows[header.start + i] ?? []]))
    return colWidths([...head, ...rows.slice(from)], cols)
  }, [rows, from, header, cols])
  const [dragged, setDragged] = useColWidths(widthKey)
  const hiddenSet = useMemo(() => new Set(layout?.hidden ?? []), [layout?.hidden])
  // 隐藏的列宽度当 0：位置照算，画的时候跳过
  // 枚举画成胶囊时左右多了内边距：按内容估的列宽给这几列加一点，免得「TabletopDecor」刚好被截断。
  // 用列号拼成的字符串当依赖：表格页每次渲染都给新的 colKind，列宽不能因此每次重算（会连带重算看得见哪些列）
  const pillCols = gridLook.pills ? kinds.flatMap((k, c) => (k?.kind === 'enum' ? [c] : [])).join(',') : ''
  const colW = useMemo(() => {
    const pill = new Set(pillCols ? pillCols.split(',').map(Number) : [])
    return widths.map((w, c) =>
      hiddenSet.has(c) ? 0 : (dragged[c] ?? (pill.has(c) ? Math.min(w + PILL_PAD, 360) : w)),
    )
  }, [widths, dragged, hiddenSet, pillCols])
  /** 冻结的前几列：一直画、钉在左边 */
  const fz = Math.min(layout?.freeze ?? 0, colW.length)
  const lefts = useMemo(() => {
    const out: number[] = []
    let x = numW
    for (const w of colW) {
      out.push(x)
      x += w
    }
    out.push(x)
    return out
  }, [colW, numW])
  const dataW = lefts[lefts.length - 1]
  // 左右相邻的「没隐藏」的列：选区外框要看左右邻居在不在选区里
  const [prevCol, nextCol] = useMemo(() => neighborCols(colW), [colW])
  /** 钉在顶上的行：列名行 + 表头（连同表头上面的标题行）；表头折起来时只剩列名行 */
  const frozen = headCollapsed && colHead ? 0 : from
  // 两行列头高一些：字段名一行、标签一行
  const headH = colHead ? Math.round(rowH * 1.75) : rowH
  const frozenH = headH + rowH * frozen
  const [win, setWin] = useState({ from: 0, to: 60 })
  /**
   * 双击列边线：按看得见的这一段（最多 200 行）加表头量这一列的宽度，不扫整列（几万行的表也不顿）。
   * 两行列头的字段名、类型标签也算进去
   */
  const fitWidth = (c: number) => {
    const sample: string[][] = []
    header.roles.forEach((r, i) => r !== 'comment' && sample.push([rows[header.start + i]?.[c] ?? '']))
    for (const r of body.slice(win.from, win.from + 200)) sample.push([rows[r]?.[c] ?? ''])
    const head = colHead?.(c)
    if (head) sample.push([head.field], [head.tags.map((g) => g.text).join('  ')])
    return colWidths(sample, 1)[0]
  }
  // 横向也只画看得见的列（宽表上百列时，每行只画屏幕上那十几列）
  const [cwin, setCwin] = useState({ from: 0, to: 40 })
  const leftsRef = useRef(lefts)
  leftsRef.current = lefts
  // 铺满：滚动区比数据大的部分接着画空列、空行
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 })
  const padCols = fill ? Math.max(0, Math.ceil((boxSize.w - dataW) / PAD_W)) : 0
  const padRows = fill ? Math.max(0, Math.ceil((boxSize.h - frozenH - rowH * body.length) / rowH)) : 0
  const total = dataW + padCols * PAD_W

  // 跟着外面的滚动容器算看得见哪些行（按显示的第几行算，不是表里的行号）
  useEffect(() => {
    const box = scrollEl.current
    if (!box) return
    let frame = 0
    const read = () => {
      frame = 0
      const a = Math.max(0, Math.floor((box.scrollTop / rowH - OVER) / STEP) * STEP)
      const b = Math.ceil(((box.scrollTop + box.clientHeight) / rowH + OVER) / STEP) * STEP
      setWin((w) => (w.from === a && w.to === b ? w : { from: a, to: b }))
      const size = { w: box.clientWidth, h: box.clientHeight }
      setBoxSize((o) => (o.w === size.w && o.h === size.h ? o : size))
      const ls = leftsRef.current
      const n = ls.length - 1
      const x0 = box.scrollLeft
      const x1 = box.scrollLeft + box.clientWidth
      // 二分找第一列右边线过了 x0 的、第一列左边线过了 x1 的；左右各多画几列，按 COL_STEP 取整少重画
      const find = (x: number) => {
        let lo = 0
        let hi = n
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (ls[mid + 1] <= x) lo = mid + 1
          else hi = mid
        }
        return lo
      }
      const ca = Math.max(0, Math.floor((find(x0) - COL_OVER) / COL_STEP) * COL_STEP)
      const cb = Math.min(n, Math.ceil((find(x1) + 1 + COL_OVER) / COL_STEP) * COL_STEP)
      setCwin((w) => (w.from === ca && w.to === cb ? w : { from: ca, to: cb }))
    }
    const later = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    box.addEventListener('scroll', later, { passive: true })
    const ro = new ResizeObserver(later)
    ro.observe(box)
    return () => {
      box.removeEventListener('scroll', later)
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
    // 列宽变了（拖列宽、换表）要重算看得见的列
  }, [scrollEl, rowH, lefts])

  // 换了一张表：回到左上角
  useLayoutEffect(() => {
    scrollEl.current?.scrollTo(0, 0)
  }, [rows, scrollEl])

  const marked = useMemo(() => {
    const set = new Set<number>()
    // 行号 × 列数 + 列号：一格一个数，比拼字符串省
    for (const h of hits ?? []) set.add(h.row * cols + h.col)
    return set
  }, [hits, cols])
  const cur = edit?.focus ?? hits?.[current ?? 0]
  const at = useMemo(() => new Map(body.map((r, i) => [r, i])), [body])

  // 搜索换到下一处：把那一格滚进视野（被钉住的表头、行号列挡住的也算没看见；表头里的格子本来就看得见）
  useLayoutEffect(() => {
    const box = scrollEl.current
    if (!box || !cur) return
    const i = at.get(cur.row)
    if (i !== undefined) {
      const y = frozenH + i * rowH
      if (y < box.scrollTop + frozenH || y + rowH > box.scrollTop + box.clientHeight)
        box.scrollTop = Math.max(0, y - box.clientHeight / 2)
    }
    const x = lefts[cur.col]
    const w = colW[cur.col]
    // 冻结的列本来就看得见；其它列被冻结区挡住也算没看见
    const pinW = lefts[fz] - numW
    if (cur.col >= fz && (x < box.scrollLeft + numW + pinW || x + w > box.scrollLeft + box.clientWidth))
      box.scrollLeft = Math.max(0, x - numW - pinW - 24)
    // lefts、widths、at 跟着 rows 变，换了当前命中才滚
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.row, cur?.col, seq, edit?.focusSeq, scrollEl])

  if (!rows.length) return <p className="p-6 text-body text-subtle">{t('这张表是空的。')}</p>

  const lineH = { height: rowH, lineHeight: `${rowH - 1}px` }
  const c0 = Math.max(fz, Math.min(cwin.from, colW.length))
  const c1 = Math.min(Math.max(cwin.to, c0), colW.length)
  const gapL = lefts[c0] - lefts[fz]
  const gapR = dataW - lefts[c1]
  /** 没画的列用一块空白占住宽度 */
  const gap = (key: string, w: number) =>
    w > 0 ? <span key={key} aria-hidden className="shrink-0" style={{ width: w }} /> : null
  /**
   * 要画的列：冻结的前几列 + 看得见的那段；隐藏的跳过。给了这一行的合并区时，合并的几列并成一格画（宽度相加），
   * f 收到的 m 是这一格所在的合并区
   */
  const span = (f: ColDraw, merges?: SheetMerge[]) =>
    spanCols({ colW, lefts, fz, c0, c1, gapL: gap('gl', gapL) }, f, merges)
  const x: CellCtx = {
    rows,
    cols,
    from,
    edit,
    marked,
    cur,
    kinds,
    look: gridLook,
    lefts,
    fz,
    prevCol,
    nextCol,
    lookIdx,
    onLocate,
  }
  const pinned = (c: number, pin: boolean) => pinnedOf(x, c, pin)
  const pinCls = (c: number, pin: boolean) => pinClsOf(x, c, pin)
  const pad = (key: string) =>
    Array.from({ length: padCols }, (_, k) => (
      <span key={`${key}${k}`} aria-hidden className={cn(CELL, 'sheet-pad')} style={{ width: PAD_W }} />
    ))
  /**
   * 一行格子。up / next 是显示顺序里的上一行、下一行（筛选排序后不一定相邻）：选区外框看上下邻居，
   * 竖着合并的格子只在下一行接着是表里的下一行时去掉下边线
   */
  const cells = (r: number, up?: number, next?: number) => [
    ...span(
      (w, c, pin, m) => <SheetCell key={c} x={x} r={r} c={c} w={w} pin={pin} m={m} up={up} down={next} />,
      lookIdx?.merges(r),
    ),
    gap('gr', gapR),
    ...pad('p'),
  ]
  /** 当前格所在的行、列（和选中的一块覆盖到的行、列）：行号和列名换成强调色浅底，大表里一眼看出在哪 */
  const fo = edit?.focus
  const rowOn = (r: number) => !!fo && (fo.row === r || !!edit?.picked(r, fo.col))
  const colOn = (c: number) => !!fo && (fo.col === c || !!edit?.picked(fo.row, c))
  const tipOf = (el: HTMLElement) => cellTip(el, rows, edit?.tip, lookIdx)
  /** 行号格：表格页里右键能插删行 */
  const rowNum = (r: number, node: React.ReactElement) => (edit?.rowMenu ? edit.rowMenu(r, node) : node)
  const shown: number[] = []
  for (let i = win.from; i < Math.min(win.to, body.length); i++) shown.push(i)
  const headRows: number[] = []
  for (let r = 0; r < frozen; r++) headRows.push(r)

  return (
    <div
      // 能编辑时 role=grid 和行列总数在外面能聚焦的容器上（读屏的当前格跟着那里的焦点走），这里只是一组行
      ref={gridRef}
      role={edit ? 'rowgroup' : 'table'}
      aria-rowcount={edit ? undefined : rows.length}
      aria-colcount={edit ? undefined : cols}
      className="sheet-grid relative text-footnote"
      style={{ width: total, height: frozenH + rowH * (body.length + padRows) }}
    >
      <CellHint grid={gridRef} tipOf={tipOf} />
      <div data-sheet-head className="sticky top-0 z-2" style={{ width: total }}>
        <div role="row" className={cn(STICKY, 'flex')} style={{ height: headH }}>
          <HeadCorner width={numW} height={headH} rows={from} collapsed={headCollapsed} onCollapse={onHeadCollapse} />
          {span((w, c, pin) => (
            <ColumnHead
              key={c}
              col={c}
              width={w}
              height={headH}
              info={colHead?.(c)}
              twoLine={!!colHead}
              pin={pin ? { style: pinned(c, pin), cls: pinCls(c, pin) || '' } : undefined}
              layout={layout}
              onLayout={onLayout}
              onResize={widthKey ? (v) => setDragged(c, v ?? fitWidth(c)) : undefined}
              lineH={lineH}
              rows={rows}
              header={header}
              filter={filters?.[c]}
              sort={sort?.col === c ? sort : null}
              onFilter={onFilter}
              onSort={onSort}
              onDown={edit?.onColDown}
              on={colOn(c)}
            />
          ))}
          {gap('gr', gapR)}
          {Array.from({ length: padCols }, (_, k) => (
            <span
              key={`h${k}`}
              aria-hidden
              className={cn(CELL, 'text-center font-mono text-caption text-subtle')}
              style={{ width: PAD_W, height: headH, lineHeight: `${headH - 1}px` }}
            >
              {colName(colW.length + k)}
            </span>
          ))}
        </div>
        {headRows.map((r) => {
          const role = r >= header.start ? header.roles[r - header.start] : 'other'
          return (
            <div
              key={r}
              role="row"
              aria-rowindex={r + 1}
              className={cn('flex', `sheet-role sheet-role-${role}`, r === frozen - 1 && 'sheet-head-last')}
              style={{ width: total, ...lineH }}
            >
              <span
                className={cn(
                  STICKY,
                  CELL,
                  `sheet-role sheet-role-${role}`,
                  'left-0 z-1 flex justify-between font-mono text-caption font-normal',
                  edit?.onRowDown && 'sheet-rownum',
                  rowOn(r) && 'sheet-head-on',
                )}
                role="rowheader"
                onMouseDown={edit?.onRowDown && ((e) => edit.onRowDown!(r, e))}
                style={{ width: numW, ...lineH }}
              >
                <span className="truncate font-sans">
                  {(r >= header.start && header.labels?.[r - header.start]) || roleShort(role)}
                </span>
                <span>{r + 1}</span>
              </span>
              {cells(r, r > 0 ? r - 1 : undefined, r + 1 < frozen ? r + 1 : body[0])}
            </div>
          )
        })}
      </div>
      {shown.map((i) => {
        const r = body[i]
        const mark = rowMark(lookIdx, r)
        return (
          <div
            key={r}
            role="row"
            aria-rowindex={r + 1}
            className={cn('absolute left-0 flex hover:bg-fg/4', i % 2 === 1 && 'sheet-stripe')}
            style={{ top: frozenH + rowH * i, height: rowH, width: total, lineHeight: `${rowH - 1}px` }}
          >
            {rowNum(
              r,
              <span
                role="rowheader"
                onMouseDown={edit?.onRowDown && ((e) => edit.onRowDown!(r, e))}
                className={cn(
                  STICKY,
                  CELL,
                  'left-0 z-1 text-right font-mono text-caption',
                  edit?.onRowDown && 'sheet-rownum',
                  mark?.cls,
                  rowOn(r) && 'sheet-head-on',
                )}
                style={{ width: numW, ...lineH, ...mark?.style }}
                title={mark?.tip}
              >
                {r + 1}
              </span>,
            )}
            {cells(r, i > 0 ? body[i - 1] : frozen > 0 ? frozen - 1 : undefined, body[i + 1])}
          </div>
        )
      })}
      {Array.from({ length: padRows }, (_, k) => (
        <div
          key={`pad${k}`}
          aria-hidden
          className={cn('absolute left-0 flex', (body.length + k) % 2 === 1 && 'sheet-stripe')}
          style={{ top: frozenH + rowH * (body.length + k), height: rowH, width: total }}
        >
          <span
            className={cn(STICKY, CELL, 'left-0 z-1 text-right font-mono text-caption text-subtle')}
            style={{ width: numW, ...lineH }}
          >
            {rows.length + k + 1}
          </span>
          {span((w, c, pin) => (
            <span key={c} className={cn(CELL, 'sheet-pad', pinCls(c, pin))} style={{ width: w, ...pinned(c, pin) }} />
          ))}
          {gap('gr', gapR)}
          {pad('q')}
        </div>
      ))}
      {!body.length && (
        <p className="sticky left-0 px-4 py-6 text-body text-subtle">
          {from >= rows.length ? t('只有表头，没有数据行。') : t('没有符合筛选条件的行。')}
        </p>
      )}
    </div>
  )
}

/** 左上角：表头有几行时放「折起 / 展开表头」的按钮 */
function HeadCorner({
  width,
  height,
  rows,
  collapsed,
  onCollapse,
}: {
  width: number
  height: number
  /** 表头几行 */
  rows: number
  collapsed?: boolean
  onCollapse?: (v: boolean) => void
}) {
  const label = collapsed ? t('展开表头 {n} 行', { n: rows }) : t('折起表头 {n} 行', { n: rows })
  return (
    <span
      data-sheet-corner
      className={cn(STICKY, CELL, 'left-0 z-2 flex items-center justify-center')}
      style={{ width, height }}
    >
      {onCollapse && rows > 0 && (
        <button
          type="button"
          aria-pressed={!collapsed}
          aria-label={label}
          title={label}
          onClick={() => onCollapse(!collapsed)}
          className="flex h-5 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-caption text-subtle hover:bg-hover hover:text-fg"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {t('表头')}
        </button>
      )}
    </span>
  )
}

/** 列名格：列名居中，右边是筛选按钮（悬停才出现；在筛选或排序时一直显示并高亮） */
function ColumnHead({
  col,
  width,
  height,
  info,
  twoLine,
  lineH,
  rows,
  header,
  filter,
  sort,
  onFilter,
  onSort,
  onResize,
  pin,
  layout,
  onLayout,
  onDown,
  on: current,
}: {
  /** 当前格在这一列（或选区覆盖这一列）：列名换强调色浅底 */
  on?: boolean
  /** 按下列名：选整列（筛选按钮、拖列宽的边线不算） */
  onDown?: (c: number, e: React.MouseEvent) => void
  col: number
  width: number
  height: number
  info?: SheetColHead
  /** 两行列头（表格页）：没有字段名的列也是这个高度，只写字母 */
  twoLine: boolean
  /** 冻结的列：钉在左边 */
  pin?: { style: React.CSSProperties; cls: string }
  layout?: ColLayout
  onLayout?: (l: ColLayout) => void
  /** 拖右边线改列宽；双击右边线按内容自适应（传 undefined） */
  onResize?: (w: number | undefined) => void
  lineH: React.CSSProperties
  rows: string[][]
  header: SheetHeader
  filter?: ColFilter
  sort: SheetSort | null
  onFilter?: (col: number, f: ColFilter | undefined) => void
  onSort?: (s: SheetSort | null) => void
}) {
  const [open, setOpen] = useState(false)
  const on = filterActive(filter) || !!sort
  const SortIcon = sort ? (sort.desc ? ArrowDown : ArrowUp) : null
  const head = (
    <span
      role="columnheader"
      aria-colindex={col + 1}
      onMouseDown={
        onDown &&
        ((e) => {
          if ((e.target as HTMLElement).closest('button, [role="separator"]')) return
          onDown(col, e)
        })
      }
      aria-label={info?.field ? `${colName(col)} ${info.field}` : undefined}
      className={cn(
        CELL,
        'group relative font-mono text-caption',
        onDown && 'sheet-colpick',
        twoLine ? 'sheet-colhead flex flex-col justify-center gap-0.5' : 'text-center',
        current && 'sheet-head-on',
        pin?.cls,
      )}
      style={twoLine ? { width, height, ...pin?.style } : { width, ...lineH, ...pin?.style }}
    >
      {twoLine ? (
        <>
          <span className="flex min-w-0 items-baseline gap-1 leading-tight">
            <span className={cn('min-w-0 flex-1 truncate', info?.field ? 'font-semibold text-fg' : 'text-center')}>
              {info?.field || colName(col)}
            </span>
            {info?.field && <span className="shrink-0 text-subtle">{colName(col)}</span>}
          </span>
          {!!info?.tags.length && (
            <span className="flex min-w-0 gap-1 overflow-hidden leading-tight">
              {info.tags.map((g, i) => (
                <span key={i} title={g.title ?? g.text} className={cn('sheet-tag', `sheet-tag-${g.tone}`)}>
                  {g.text}
                </span>
              ))}
            </span>
          )}
        </>
      ) : (
        colName(col)
      )}
      {onResize && <ResizeHandle col={col} width={width} onResize={onResize} />}
      {onFilter && onSort && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('筛选和排序 {col} 列', { col: colName(col) })}
              title={t('筛选和排序')}
              className={cn(
                'absolute right-0.5 flex h-5 cursor-pointer items-center gap-0.5 rounded-sm bg-(--sheet-bg) px-1',
                twoLine ? 'bottom-1' : 'top-1/2 -translate-y-1/2',
                'transition-opacity duration-(--dur-fast) hover:bg-hover',
                on ? 'text-accent' : 'text-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                open && 'bg-active opacity-100',
              )}
            >
              {SortIcon && <SortIcon className="h-3 w-3" />}
              <ListFilter className="h-3 w-3" />
            </button>
          </PopoverTrigger>
          <SheetColumnFilter
            col={col}
            rows={rows}
            header={header}
            filter={filter}
            sort={sort}
            onApply={(f) => {
              onFilter(col, f)
              setOpen(false)
            }}
            onSort={(s) => {
              onSort(s)
              setOpen(false)
            }}
          />
        </Popover>
      )}
    </span>
  )
  if (!onLayout) return head
  const l = layout ?? { freeze: 0, hidden: [] }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{head}</ContextMenuTrigger>
      <ContextMenuContent>
        {l.freeze === col + 1 ? (
          <ContextMenuItem onSelect={() => onLayout({ ...l, freeze: 0 })}>{t('取消冻结')}</ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onLayout({ ...l, freeze: col + 1 })}>
            {t('冻结到 {col} 列（滚动时钉在左边）', { col: colName(col) })}
          </ContextMenuItem>
        )}
        {l.freeze > 0 && l.freeze !== col + 1 && (
          <ContextMenuItem onSelect={() => onLayout({ ...l, freeze: 0 })}>{t('取消冻结')}</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onLayout({ ...l, hidden: [...l.hidden, col] })}>
          {t('隐藏 {col} 列', { col: colName(col) })}
        </ContextMenuItem>
        {l.hidden.length > 0 && (
          <ContextMenuItem onSelect={() => onLayout({ ...l, hidden: [] })}>
            {t('显示全部隐藏的列（{n} 列）', { n: l.hidden.length })}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
