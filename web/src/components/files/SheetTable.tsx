import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { t } from '@shared/i18n'
import type { SheetData } from '@shared/files'
import { colCount, colName, colWidths, type CellHit } from '@/lib/sheet'
import { cn } from '@/lib/utils'

/** 行高、表头高（px）：写死而不是量出来的，每行自己带这个高度，滚到几万行位置也不会差 */
const ROW_H = 26
/** 行号列宽 */
const NUM_W = 52
/** 屏幕外上下各多画几行，滚一点点不用等 */
const OVER = 12
/** 画哪些行按这么多行一档变：滚动时不是每一帧都重新渲染 */
const STEP = 8

// 行号列、列名行钉在边上，底色用弹窗自己的底色盖住滚过去的格子
const STICKY = 'sticky bg-(--c-modal-bg) text-subtle select-none'
// 行高 = 格子高 - 下边线：字竖直居中
const CELL = 'shrink-0 truncate border-r border-b border-line px-2 leading-[25px]'

/**
 * 文件弹窗里的表格：CSV / TSV 和 xlsx 的一张表（行 × 列的文字）。带 Excel 那样的列名（A、B、C）和行号，
 * 只画看得见的行（一万行的配置表打开也只有几百个格子）；每格一行、太长的截断，悬停看完整内容。
 * 屏幕外的行不在页面里，搜索由弹窗自己做：命中的格子从 hits 传进来，当前那一格滚进视野。
 */
export function SheetTable({
  rows,
  scrollEl,
  hits,
  current,
  seq,
}: {
  rows: string[][]
  /** 外面的滚动容器 */
  scrollEl: React.RefObject<HTMLDivElement | null>
  /** 搜索命中的格子 */
  hits?: CellHit[]
  /** 当前是第几处命中 */
  current?: number
  /** 每按一次上一个 / 下一个加一：停在同一处也要重新滚过去 */
  seq?: number
}) {
  const cols = useMemo(() => colCount(rows), [rows])
  const widths = useMemo(() => colWidths(rows, cols), [rows, cols])
  const lefts = useMemo(() => {
    const out: number[] = []
    let x = NUM_W
    for (const w of widths) {
      out.push(x)
      x += w
    }
    out.push(x)
    return out
  }, [widths])
  const total = lefts[lefts.length - 1]
  const [win, setWin] = useState({ from: 0, to: 60 })

  // 跟着外面的滚动容器算看得见哪些行
  useEffect(() => {
    const box = scrollEl.current
    if (!box) return
    let frame = 0
    const read = () => {
      frame = 0
      const from = Math.max(0, Math.floor((box.scrollTop / ROW_H - OVER) / STEP) * STEP)
      const to = Math.ceil(((box.scrollTop + box.clientHeight) / ROW_H + OVER) / STEP) * STEP
      setWin((w) => (w.from === from && w.to === to ? w : { from, to }))
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
  }, [scrollEl])

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
  const cur = hits?.[current ?? 0]

  // 搜索换到下一处：把那一格滚进视野（被钉住的列名行、行号列挡住的也算没看见）
  useLayoutEffect(() => {
    const box = scrollEl.current
    if (!box || !cur) return
    const y = ROW_H + cur.row * ROW_H
    if (y < box.scrollTop + ROW_H || y + ROW_H > box.scrollTop + box.clientHeight)
      box.scrollTop = Math.max(0, y - box.clientHeight / 2)
    const x = lefts[cur.col]
    const w = widths[cur.col]
    if (x < box.scrollLeft + NUM_W || x + w > box.scrollLeft + box.clientWidth)
      box.scrollLeft = Math.max(0, x - NUM_W - 24)
    // lefts、widths 跟着 rows 变，换了当前命中才滚
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.row, cur?.col, seq, scrollEl])

  if (!rows.length) return <p className="p-6 text-body text-subtle">{t('这张表是空的。')}</p>

  const shown: number[] = []
  for (let r = win.from; r < Math.min(win.to, rows.length); r++) shown.push(r)
  return (
    <div
      role="table"
      aria-rowcount={rows.length}
      aria-colcount={cols}
      className="relative text-footnote"
      style={{ width: total, height: ROW_H * (rows.length + 1) }}
    >
      <div role="row" className={cn(STICKY, 'top-0 z-2 flex')} style={{ height: ROW_H }}>
        <span className={cn(STICKY, CELL, 'left-0 z-1')} style={{ width: NUM_W }} />
        {widths.map((w, c) => (
          <span
            key={c}
            role="columnheader"
            className={cn(CELL, 'text-center font-mono text-caption leading-[25px]')}
            style={{ width: w }}
          >
            {colName(c)}
          </span>
        ))}
      </div>
      {shown.map((r) => {
        const row = rows[r]
        return (
          <div
            key={r}
            role="row"
            aria-rowindex={r + 1}
            className="absolute left-0 flex hover:bg-fg/4"
            style={{ top: ROW_H * (r + 1), height: ROW_H, width: total }}
          >
            <span
              className={cn(STICKY, CELL, 'left-0 z-1 text-right font-mono text-caption leading-[25px]')}
              style={{ width: NUM_W }}
            >
              {r + 1}
            </span>
            {widths.map((w, c) => {
              const text = row[c] ?? ''
              const hit = marked.has(r * cols + c)
              const on = hit && cur?.row === r && cur.col === c
              return (
                <span
                  key={c}
                  role="cell"
                  // 截断了或者有换行的格子，悬停看完整内容
                  title={text.length > 12 ? text : undefined}
                  data-current={on || undefined}
                  className={cn(CELL, on ? 'sheet-hit-current' : hit && 'sheet-hit')}
                  style={{ width: w }}
                >
                  {text}
                </span>
              )
            })}
          </div>
        )
      })}
    </div>
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
