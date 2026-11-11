import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ListFilter } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SheetData } from '@shared/files'
import { dataStart, type SheetHeader } from '@shared/sheet-header'
import { colCount, colName, colWidths, type CellHit } from '@/lib/sheet'
import { filterActive, type ColFilter, type ColFilters, type SheetSort } from '@/lib/sheet-filter'
import { cn } from '@/lib/utils'
import { Popover, PopoverTrigger } from '@/components/ui/menu'
import { SheetColumnFilter } from './SheetColumnFilter'
import { roleShort } from './sheet-roles'
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
const CELL = 'sheet-cell shrink-0 truncate border-r border-b border-line px-2'
/** 看得见的列左右再多画几列；按这个步长取整，滚一点点不用重画 */
const COL_OVER = 3
const COL_STEP = 4
/** 铺满时空列的宽度 */
const PAD_W = 96
/** 拖列宽的范围 */
const MIN_COL_W = 36
const MAX_COL_W = 800

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

/** 列名格右边线：按住左右拖改列宽，双击恢复自动宽度 */
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
      title={t('拖动调整列宽，双击恢复')}
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

/**
 * 行高读设置 → 组件 → 数据表格的 --c-grid-rowH：虚拟滚动要按它算位置，不能只交给 CSS。
 * 每次渲染后看一眼，设置里拖了滑块下一次渲染就跟上
 */
export function useRowH() {
  const [h, setH] = useState(26)
  // 故意不写依赖：设置改的是 CSS 变量，React 不知道它变了，每次渲染后都看一眼；值没变不 setState，不会循环
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--c-grid-rowH'))
    if (v > 0 && v !== h) setH(v)
  })
  return h
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
  tip?: (r: number, c: number) => string | undefined
  onDown: (r: number, c: number, e: React.MouseEvent) => void
  onEnter: (r: number, c: number, e: React.MouseEvent) => void
  onDouble: (r: number, c: number) => void
  /** 行号格的右键菜单（插入、删除行） */
  rowMenu?: (r: number, trigger: React.ReactElement) => React.ReactNode
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
}: {
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
  const rowH = useRowH()
  const from = dataStart(header)
  const numW = header.roles.length ? NUM_W_ROLE : NUM_W
  const cols = useMemo(() => colCount(rows), [rows])
  const body = useMemo(() => order ?? rows.slice(from).map((_, i) => from + i), [order, rows, from])
  // 列宽看数据行和除注释外的表头行：长长的中文注释不该把列撑宽，截断后悬停看全
  const widths = useMemo(() => {
    if (!header.roles.length) return colWidths(rows, cols)
    const head = header.roles.flatMap((r, i) => (r === 'comment' ? [] : [rows[header.start + i] ?? []]))
    return colWidths([...head, ...rows.slice(from)], cols)
  }, [rows, from, header, cols])
  const [dragged, setDragged] = useColWidths(widthKey)
  const colW = useMemo(() => widths.map((w, c) => dragged[c] ?? w), [widths, dragged])
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
  /** 钉在顶上的行：列名行 + 表头（连同表头上面的标题行） */
  const frozen = from
  const frozenH = rowH * (frozen + 1)
  const [win, setWin] = useState({ from: 0, to: 60 })
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
    if (x < box.scrollLeft + numW || x + w > box.scrollLeft + box.clientWidth)
      box.scrollLeft = Math.max(0, x - numW - 24)
    // lefts、widths、at 跟着 rows 变，换了当前命中才滚
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.row, cur?.col, seq, edit?.focusSeq, scrollEl])

  if (!rows.length) return <p className="p-6 text-body text-subtle">{t('这张表是空的。')}</p>

  const lineH = { height: rowH, lineHeight: `${rowH - 1}px` }
  const c0 = Math.min(cwin.from, colW.length)
  const c1 = Math.min(Math.max(cwin.to, c0), colW.length)
  const gapL = lefts[c0] - numW
  const gapR = dataW - lefts[c1]
  /** 没画的列用一块空白占住宽度 */
  const gap = (key: string, w: number) =>
    w > 0 ? <span key={key} aria-hidden className="shrink-0" style={{ width: w }} /> : null
  const span = <T,>(f: (w: number, c: number) => T) => colW.slice(c0, c1).map((w, i) => f(w, c0 + i))
  const pad = (key: string) =>
    Array.from({ length: padCols }, (_, k) => (
      <span key={`${key}${k}`} aria-hidden className={cn(CELL, 'sheet-pad')} style={{ width: PAD_W }} />
    ))
  const cells = (r: number) => [
    gap('gl', gapL),
    ...span((w, c) => {
      const text = rows[r]?.[c] ?? ''
      const hit = marked.has(r * cols + c)
      const on = !edit && hit && cur?.row === r && cur.col === c
      if (edit?.editing && edit.editing.r === r && edit.editing.c === c)
        return (
          <span
            key={c}
            role="cell"
            className={cn(CELL, 'sheet-editing relative overflow-visible p-0')}
            style={{ width: w }}
          >
            {edit.editing.node}
          </span>
        )
      const picked = !!edit?.picked(r, c)
      const focused = !!edit?.focus && edit.focus.row === r && edit.focus.col === c
      return (
        <span
          key={c}
          role="cell"
          // 截断了或者有换行的格子，悬停看完整内容；不合规的格子悬停看原因
          title={edit?.tip?.(r, c) ?? (text.length > 12 ? text : undefined)}
          data-current={on || undefined}
          aria-selected={edit ? picked : undefined}
          data-r={edit ? r : undefined}
          data-c={edit ? c : undefined}
          onMouseDown={edit && ((e) => edit.onDown(r, c, e))}
          onMouseEnter={edit && ((e) => edit.onEnter(r, c, e))}
          onDoubleClick={edit && (() => edit.onDouble(r, c))}
          className={cn(
            CELL,
            on ? 'sheet-hit-current' : hit && 'sheet-hit',
            edit?.mark?.(r, c),
            picked && 'sheet-sel',
            focused && 'sheet-focus',
          )}
          style={{ width: w }}
        >
          {text}
        </span>
      )
    }),
    gap('gr', gapR),
    ...pad('p'),
  ]
  /** 行号格：表格页里右键能插删行 */
  const rowNum = (r: number, node: React.ReactElement) => (edit?.rowMenu ? edit.rowMenu(r, node) : node)
  const shown: number[] = []
  for (let i = win.from; i < Math.min(win.to, body.length); i++) shown.push(i)
  const headRows: number[] = []
  for (let r = 0; r < frozen; r++) headRows.push(r)

  return (
    <div
      role="table"
      aria-rowcount={rows.length}
      aria-colcount={cols}
      className="sheet-grid relative text-footnote"
      style={{ width: total, height: frozenH + rowH * (body.length + padRows) }}
    >
      <div className="sticky top-0 z-2" style={{ width: total }}>
        <div role="row" className={cn(STICKY, 'flex')} style={{ height: rowH }}>
          <span className={cn(STICKY, CELL, 'left-0 z-1')} style={{ width: numW, ...lineH }} />
          {gap('gl', gapL)}
          {span((w, c) => (
            <ColumnHead
              key={c}
              col={c}
              width={w}
              onResize={widthKey ? (v) => setDragged(c, v) : undefined}
              lineH={lineH}
              rows={rows}
              header={header}
              filter={filters?.[c]}
              sort={sort?.col === c ? sort : null}
              onFilter={onFilter}
              onSort={onSort}
            />
          ))}
          {gap('gr', gapR)}
          {Array.from({ length: padCols }, (_, k) => (
            <span
              key={`h${k}`}
              aria-hidden
              className={cn(CELL, 'text-center font-mono text-caption text-subtle')}
              style={{ width: PAD_W, ...lineH }}
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
                )}
                style={{ width: numW, ...lineH }}
              >
                <span className="truncate font-sans">
                  {(r >= header.start && header.labels?.[r - header.start]) || roleShort(role)}
                </span>
                <span>{r + 1}</span>
              </span>
              {cells(r)}
            </div>
          )
        })}
      </div>
      {shown.map((i) => {
        const r = body[i]
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
                className={cn(STICKY, CELL, 'left-0 z-1 text-right font-mono text-caption')}
                style={{ width: numW, ...lineH }}
              >
                {r + 1}
              </span>,
            )}
            {cells(r)}
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
          {gap('gl', gapL)}
          {span((w, c) => (
            <span key={c} className={cn(CELL, 'sheet-pad')} style={{ width: w }} />
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

/** 列名格：列名居中，右边是筛选按钮（悬停才出现；在筛选或排序时一直显示并高亮） */
function ColumnHead({
  col,
  width,
  lineH,
  rows,
  header,
  filter,
  sort,
  onFilter,
  onSort,
  onResize,
}: {
  col: number
  width: number
  /** 拖右边线改列宽；双击右边线恢复自动宽度（传 undefined） */
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
  return (
    <span
      role="columnheader"
      className={cn(CELL, 'group relative text-center font-mono text-caption')}
      style={{ width, ...lineH }}
    >
      {colName(col)}
      {onResize && <ResizeHandle col={col} width={width} onResize={onResize} />}
      {onFilter && onSort && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('筛选和排序 {col} 列', { col: colName(col) })}
              title={t('筛选和排序')}
              className={cn(
                'absolute top-1/2 right-0.5 flex h-5 -translate-y-1/2 cursor-pointer items-center gap-0.5 rounded-sm px-1',
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
}

/** 多张表时的切换条（标题栏下面一行）：表多了横向滚 */
export function SheetTabs({
  sheets,
  index,
  onChange,
}: {
  sheets: SheetData[]
  index: number
  onChange: (index: number) => void
}) {
  return (
    <div
      role="tablist"
      aria-label={t('工作表')}
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3"
    >
      {sheets.map((s, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={i === index}
          onClick={() => onChange(i)}
          className={cn(
            'h-6 shrink-0 cursor-pointer rounded-md px-2 text-body whitespace-nowrap transition-colors',
            i === index ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
          )}
        >
          {s.name}
          <span className="ml-1.5 text-caption text-subtle tabular-nums">{s.rows.length}</span>
        </button>
      ))}
    </div>
  )
}
