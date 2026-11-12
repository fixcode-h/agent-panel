import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SheetEditing } from './SheetTable'
import { boolOf, pillHue, type GridLook, type SheetColKind } from './sheet-kinds'

export const CELL = 'sheet-cell shrink-0 truncate border-r border-b border-line px-2'

/**
 * 画一行格子要用的东西：SheetTable 每次渲染算好一份传进来（显式的上下文，不靠闭包）。
 * prevCol / nextCol 是左右相邻的「没隐藏」的列（-1 是没有），选区外框按它判断左右是不是还在选区里
 */
export interface CellCtx {
  rows: string[][]
  cols: number
  /** 数据从第几行开始（上面是表头）：数字右对齐、胶囊、空格占位只画在数据行 */
  from: number
  edit?: SheetEditing
  /** 搜索命中的格子（行号 × 列数 + 列号） */
  marked: Set<number>
  cur?: { row: number; col: number } | null
  kinds: (SheetColKind | undefined)[]
  look: GridLook
  lefts: number[]
  /** 冻结前几列 */
  fz: number
  prevCol: number[]
  nextCol: number[]
}

/** 冻结列的格子钉在行号列右边 */
export const pinned = (x: CellCtx, c: number, pin: boolean) =>
  pin ? { position: 'sticky' as const, left: x.lefts[c], zIndex: 1 } : {}
export const pinCls = (x: CellCtx, c: number, pin: boolean) =>
  pin && cn('sheet-frozen', c === x.fz - 1 && 'sheet-frozen-last')

/**
 * 格子里画什么：布尔画成小勾，枚举画成按值固定颜色的胶囊，数据行的空格子画一个淡淡的「—」。
 * 这三样在设置 → 组件 → 数据表格里各有开关；写错的布尔值（不是 0 / 1 / TRUE / FALSE）照原样显示，免得把错值藏起来
 */
function cellBody(x: CellCtx, r: number, c: number, text: string, bad: boolean) {
  const data = r >= x.from
  if (!text) return data && x.look.blank ? <span aria-hidden className="sheet-blank" /> : null
  const shown = x.edit?.display ? x.edit.display(r, c, text) : text
  const k = data ? x.kinds[c] : undefined
  if (k?.kind === 'bool' && x.look.bools) {
    const b = boolOf(text)
    if (b !== undefined)
      return (
        <span className="sheet-bool" data-on={b || undefined}>
          {b && <Check aria-hidden className="h-2.5 w-2.5" strokeWidth={3.5} />}
          <span className="sr-only">{text}</span>
        </span>
      )
  }
  // 不合规的值（不在枚举里）不画成胶囊：胶囊看着像「合法的取值」，错值照原样标红更醒目
  if (k?.kind === 'enum' && x.look.pills && !bad) {
    const parts = (k.sep ? shown.split(k.sep) : [shown]).map((p) => p.trim()).filter(Boolean)
    return parts.map((p, i) => (
      <span key={i} className="sheet-pill" style={{ '--pill-h': pillHue(p) } as React.CSSProperties}>
        {p}
      </span>
    ))
  }
  return shown
}

/**
 * 选中的一块外面画一圈框：选区在筛选排序后不一定是规整的矩形，所以每个选中的格子看上下左右的邻居，
 * 邻居不在选区里的那一边画线。只有选中的格子才多问这几次，没选的一格不多花
 */
function selEdges(x: CellCtx, r: number, c: number, up: number | undefined, down: number | undefined) {
  const picked = x.edit!.picked
  return cn(
    (up === undefined || !picked(up, c)) && 'sheet-sel-t',
    (down === undefined || !picked(down, c)) && 'sheet-sel-b',
    (x.prevCol[c] < 0 || !picked(r, x.prevCol[c])) && 'sheet-sel-l',
    (x.nextCol[c] < 0 || !picked(r, x.nextCol[c])) && 'sheet-sel-r',
  )
}

/** 一个格子。up / down 是显示顺序里上一行、下一行的行号（筛选排序后不一定相邻），没有就是 undefined */
export function SheetCell({
  x,
  r,
  c,
  w,
  pin,
  up,
  down,
}: {
  x: CellCtx
  r: number
  c: number
  w: number
  pin: boolean
  up?: number
  down?: number
}) {
  const { edit } = x
  const text = x.rows[r]?.[c] ?? ''
  const hit = x.marked.has(r * x.cols + c)
  const on = !edit && hit && x.cur?.row === r && x.cur.col === c
  if (edit?.editing && edit.editing.r === r && edit.editing.c === c)
    return (
      <span
        role="cell"
        className={cn(CELL, 'sheet-editing relative overflow-visible p-0', pinCls(x, c, pin))}
        style={{ width: w, ...pinned(x, c, pin), ...(pin ? { zIndex: 3 } : {}) }}
      >
        {edit.editing.node}
      </span>
    )
  const picked = !!edit?.picked(r, c)
  const focused = !!edit?.focus && edit.focus.row === r && edit.focus.col === c
  const kind = r >= x.from ? x.kinds[c]?.kind : undefined
  const mark = edit?.mark?.(r, c)
  return (
    <span
      role="cell"
      // 悬停说明不用原生 title：CellHint 按 data-r / data-c 找到这一格，截断了、不合规的才出面板自己的提示
      data-current={on || undefined}
      aria-selected={edit ? picked : undefined}
      data-r={r}
      data-c={c}
      onMouseDown={edit && ((e) => edit.onDown(r, c, e))}
      onMouseEnter={edit && ((e) => edit.onEnter(r, c, e))}
      onDoubleClick={edit && (() => edit.onDouble(r, c))}
      className={cn(
        CELL,
        kind === 'num' && 'sheet-num',
        kind === 'bool' && x.look.bools && 'sheet-boolcell',
        on ? 'sheet-hit-current' : hit && 'sheet-hit',
        mark,
        picked && 'sheet-sel',
        picked && selEdges(x, r, c, up, down),
        focused && 'sheet-focus',
        pinCls(x, c, pin),
      )}
      style={{ width: w, ...pinned(x, c, pin) }}
    >
      {cellBody(x, r, c, text, !!mark?.includes('sheet-bad'))}
    </span>
  )
}
