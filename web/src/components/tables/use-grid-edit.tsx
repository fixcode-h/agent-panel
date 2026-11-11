/**
 * 表格页的选中和编辑：像表格软件一样点格子选中、拖动选一块、方向键移动（跳过筛掉的行）、
 * 直接打字或双击 / F2 改、Enter / Tab 确认并移动、Esc 取消、Delete 清空、
 * Ctrl+C / X / V 复制剪切粘贴（和 Excel / WPS 互通的 TSV）、Ctrl+Z / Y 撤销重做、Ctrl+S 保存、
 * Ctrl+D 向下填充（Ctrl+Shift+D 按序列递增）、改格子时 Ctrl+Enter 把值填进选中的每一格。
 * 还有：Ctrl+方向键跳到这一段数据的边缘、Ctrl+Home / End、Shift+空格选整行、Ctrl+空格选整列、
 * Ctrl+Shift+= 在上方插行、Ctrl+- 删选中的行、Ctrl+F 表内查找、Ctrl+G 跳到行或主键、F1 / Ctrl+/ 快捷键表。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseClip, toClip, type CellSet } from '@shared/table-edit'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import type { SheetEditing } from '@/components/files/SheetTable'
import { fillDown } from '@shared/table-tools'
import type { CellMove } from './CellEditor'

export interface Pos {
  row: number
  col: number
}

export interface GridEditOpts {
  rows: string[][]
  cols: number
  /** 数据从第几行开始（上面是表头） */
  from: number
  /** 筛选排序后显示的数据行 */
  order: number[]
  readOnly: boolean
  onCells: (cells: CellSet[]) => void
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  /** 正在改的格子用什么编辑框：枚举列是下拉，其余是文字框 */
  editor: (p: Pos, init: string, done: (v: string | null, move?: CellMove) => void) => React.ReactNode
  mark?: SheetEditing['mark']
  tip?: SheetEditing['tip']
  rowMenu?: SheetEditing['rowMenu']
  /** Ctrl+H：打开查找替换 */
  onFind?: () => void
  /** 隐藏的列：左右移动时跳过 */
  hiddenCol?: (c: number) => boolean
  /** Ctrl+F：表格顶部的查找条 */
  onFindBar?: () => void
  /** Ctrl+G：跳到某行或某个主键 */
  onGoto?: () => void
  /** Ctrl+Shift+=：在这一行上方插一行 */
  onInsertAbove?: (row: number) => void
  /** Ctrl+-：删掉这些行（行号从大到小） */
  onDeleteRows?: (rows: number[]) => void
  /** F1 / Ctrl+/：快捷键表 */
  onHelp?: () => void
  /** 格子里显示的字（引用列「ID · 名称」） */
  display?: (r: number, c: number, text: string) => string
}

export function useGridEdit(o: GridEditOpts) {
  const [anchor, setAnchor] = useState<Pos | null>(null)
  const [focus, setFocus] = useState<Pos | null>(null)
  const [seq, setSeq] = useState(0)
  const [editing, setEditing] = useState<{ p: Pos; init: string } | null>(null)
  const dragging = useRef(false)
  const box = useRef<HTMLDivElement>(null)

  // 显示顺序：表头行 + 筛选排序后的数据行；方向键按它走
  const line = useMemo(() => [...Array.from({ length: o.from }, (_, i) => i), ...o.order], [o.from, o.order])
  const posOf = useMemo(() => new Map(line.map((r, i) => [r, i])), [line])

  useEffect(() => {
    const up = () => (dragging.current = false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const go = useCallback((p: Pos, extend = false) => {
    setFocus(p)
    if (!extend) setAnchor(p)
    setSeq((n) => n + 1)
  }, [])
  const move = (dr: number, dc: number, extend = false) => {
    if (!focus) return
    const i = posOf.get(focus.row) ?? 0
    const row = line[Math.min(Math.max(0, i + dr), line.length - 1)] ?? focus.row
    const last = Math.max(0, o.cols - 1)
    let col = Math.min(Math.max(0, focus.col + dc), last)
    // 落在隐藏的列上：接着往同一个方向走；走到头还是隐藏的就往回找
    if (dc && o.hiddenCol) {
      const dir = Math.sign(dc)
      while (o.hiddenCol(col) && col + dir >= 0 && col + dir <= last) col += dir
      while (o.hiddenCol(col) && col - dir >= 0 && col - dir <= last) col -= dir
    }
    go({ row, col }, extend)
  }

  /**
   * Ctrl+方向键：像 Excel 一样跳到这一段数据的边缘——当前格和下一格都有字就走到连续一段的最后一格，
   * 否则跳过空格子停在下一个有字的格子（没有就到头）
   */
  const edge = (dr: number, dc: number, extend: boolean) => {
    if (!focus) return
    const filled = (i: number, c: number) => !!(o.rows[line[i]]?.[c] ?? '').trim()
    let i = posOf.get(focus.row) ?? 0
    let c = focus.col
    const last = Math.max(0, o.cols - 1)
    const step = () => {
      let ni = i + dr
      let nc = c + dc
      while (dc && o.hiddenCol?.(nc) && nc + dc >= 0 && nc + dc <= last) nc += dc
      if (ni < 0 || ni >= line.length || nc < 0 || nc > last) return false
      i = ni
      c = nc
      return true
    }
    const next = () => {
      const ni = i + dr
      const nc = c + dc
      return ni >= 0 && ni < line.length && nc >= 0 && nc <= last && filled(ni, nc)
    }
    if (filled(i, c) && next()) {
      while (next() && step());
    } else {
      while (step() && !filled(i, c));
    }
    go({ row: line[i], col: c }, extend)
  }

  const range = useMemo(() => {
    if (!focus) return null
    const a = anchor ?? focus
    const ia = posOf.get(a.row) ?? 0
    const ib = posOf.get(focus.row) ?? 0
    return {
      i0: Math.min(ia, ib),
      i1: Math.max(ia, ib),
      c0: Math.min(a.col, focus.col),
      c1: Math.max(a.col, focus.col),
    }
  }, [anchor, focus, posOf])
  /** 选中的格子（按显示顺序，筛掉的行不算） */
  const picked = () => {
    if (!range) return []
    const out: Pos[] = []
    for (let i = range.i0; i <= range.i1; i++)
      for (let c = range.c0; c <= range.c1; c++) out.push({ row: line[i], col: c })
    return out
  }

  const startEdit = (init?: string) => {
    if (!focus) return
    if (o.readOnly) return toast.error(t('这张表现在不能改'))
    setEditing({ p: focus, init: init ?? o.rows[focus.row]?.[focus.col] ?? '' })
  }
  const done = (v: string | null, dir?: CellMove) => {
    const cur = editing
    setEditing(null)
    // Ctrl+Enter：选中的每一格都改成这个值（批量设值，一次撤销）
    if (cur && v !== null && dir === 'all') {
      const all = picked().filter((p) => !o.hiddenCol?.(p.col))
      o.onCells(all.length ? all.map((p) => ({ r: p.row, c: p.col, v })) : [{ r: cur.p.row, c: cur.p.col, v }])
      box.current?.focus({ preventScroll: true })
      return
    }
    if (cur && v !== null) o.onCells([{ r: cur.p.row, c: cur.p.col, v }])
    if (dir && dir !== 'all') {
      const [dr, dc] = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1] }[dir]
      move(dr, dc)
    }
    box.current?.focus({ preventScroll: true })
  }

  const copy = async (cut: boolean) => {
    if (!range) return
    const block: string[][] = []
    for (let i = range.i0; i <= range.i1; i++) {
      const r = line[i]
      const row: string[] = []
      for (let c = range.c0; c <= range.c1; c++) row.push(o.rows[r]?.[c] ?? '')
      block.push(row)
    }
    await navigator.clipboard.writeText(toClip(block)).catch(() => toast.error(t('浏览器不让写剪贴板')))
    if (cut && !o.readOnly) o.onCells(picked().map((p) => ({ r: p.row, c: p.col, v: '' })))
  }
  const paste = (text: string) => {
    if (!focus || o.readOnly) return
    const block = parseClip(text)
    if (!block.length) return
    // 选中一块、剪贴板只有一格：填满选中的那块（和表格软件一样）
    const one = block.length === 1 && block[0].length === 1
    const cells: CellSet[] =
      one && range && (range.i1 > range.i0 || range.c1 > range.c0)
        ? picked().map((p) => ({ r: p.row, c: p.col, v: block[0][0] }))
        : block.flatMap((row, i) => {
            // 往下贴按显示顺序走（筛选后贴进看得见的行）；超出最后一行就接着往下加行
            const at = (posOf.get(focus.row) ?? 0) + i
            const r = line[at] ?? Math.max(o.rows.length, line[line.length - 1] + 1) + (at - line.length)
            return row.map((v, j) => ({ r, c: focus.col + j, v }))
          })
    o.onCells(cells)
    if (!one) go({ row: cells[cells.length - 1].r, col: cells[cells.length - 1].c }, true)
  }

  /** 向下填充选中的一块：series 时数字按步长递增 */
  const fill = (series: boolean) => {
    if (o.readOnly || !range) return
    const rowsSel = line.slice(range.i0, range.i1 + 1).filter((r) => r >= o.from)
    const colsSel: number[] = []
    for (let c = range.c0; c <= range.c1; c++) if (!o.hiddenCol?.(c)) colsSel.push(c)
    const cells = fillDown(o.rows, rowsSel, colsSel, series)
    if (cells.length) o.onCells(cells)
    else toast.info(t('先选中要填充的几行（第一行是要往下填的值）'))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    if (mod && k.toLowerCase() === 'z') return void (e.preventDefault(), e.shiftKey ? o.onRedo() : o.onUndo())
    if (mod && k.toLowerCase() === 'y') return void (e.preventDefault(), o.onRedo())
    if (mod && k.toLowerCase() === 's') return void (e.preventDefault(), o.onSave())
    if (mod && k.toLowerCase() === 'c') return void (e.preventDefault(), copy(false))
    if (mod && k.toLowerCase() === 'x') return void (e.preventDefault(), copy(true))
    if (mod && k.toLowerCase() === 'h' && o.onFind) return void (e.preventDefault(), o.onFind())
    // Ctrl+D 向下填充（复制选中区第一行）；Ctrl+Shift+D 按序列递增
    if (mod && k.toLowerCase() === 'd') return void (e.preventDefault(), fill(e.shiftKey))
    if (mod && k.toLowerCase() === 'f' && o.onFindBar) return void (e.preventDefault(), o.onFindBar())
    if (mod && k.toLowerCase() === 'g' && o.onGoto) return void (e.preventDefault(), o.onGoto())
    if ((k === 'F1' || (mod && k === '/')) && o.onHelp) return void (e.preventDefault(), o.onHelp())
    if (mod && k.toLowerCase() === 'a') {
      e.preventDefault()
      setAnchor({ row: line[0], col: 0 })
      setFocus({ row: line[line.length - 1], col: o.cols - 1 })
      return
    }
    if (!focus) return
    if (mod && k === 'Home') return void (e.preventDefault(), go({ row: line[0], col: 0 }, e.shiftKey))
    if (mod && k === 'End')
      return void (e.preventDefault(), go({ row: line[line.length - 1], col: Math.max(0, o.cols - 1) }, e.shiftKey))
    // Shift+空格选整行、Ctrl+空格选整列
    if (k === ' ' && e.shiftKey && !mod) {
      e.preventDefault()
      setAnchor({ row: focus.row, col: 0 })
      setFocus({ row: focus.row, col: Math.max(0, o.cols - 1) })
      return
    }
    if (k === ' ' && mod) {
      e.preventDefault()
      setAnchor({ row: line[0], col: focus.col })
      setFocus({ row: line[line.length - 1], col: focus.col })
      return
    }
    if (mod && e.shiftKey && (k === '+' || k === '=') && !o.readOnly && o.onInsertAbove)
      return void (e.preventDefault(), o.onInsertAbove(focus.row))
    if (mod && k === '-' && !o.readOnly && o.onDeleteRows) {
      e.preventDefault()
      const rows = range ? [...new Set(line.slice(range.i0, range.i1 + 1))] : [focus.row]
      // 表头行不删
      o.onDeleteRows(rows.filter((r) => r >= o.from).sort((a, b) => b - a))
      return
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    if (arrows[k]) {
      e.preventDefault()
      const [dr, dc] = arrows[k]
      return mod ? edge(dr, dc, e.shiftKey) : move(dr, dc, e.shiftKey)
    }
    if (k === 'Tab') return void (e.preventDefault(), move(0, e.shiftKey ? -1 : 1))
    if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault()
      const page = Math.max(1, Math.floor((box.current?.clientHeight ?? 400) / 26) - 2)
      return move(k === 'PageDown' ? page : -page, 0, e.shiftKey)
    }
    if (k === 'Enter' || k === 'F2') return void (e.preventDefault(), startEdit())
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault()
      if (!o.readOnly) o.onCells(picked().map((p) => ({ r: p.row, c: p.col, v: '' })))
      return
    }
    // 直接打字：从这个字开始改（输入法的组字交给编辑框）
    if (k.length === 1 && !mod && !e.altKey) {
      e.preventDefault()
      startEdit(k)
    }
  }

  // 选中的行：按显示顺序取一段（筛选排序后行号不一定连着）
  const selRows = useMemo(() => (range ? new Set(line.slice(range.i0, range.i1 + 1)) : null), [range, line])
  const edit: SheetEditing = {
    picked: (r, c) => !!range && !!selRows?.has(r) && c >= range.c0 && c <= range.c1,
    focus,
    focusSeq: seq,
    editing: editing ? { r: editing.p.row, c: editing.p.col, node: o.editor(editing.p, editing.init, done) } : null,
    mark: o.mark,
    tip: o.tip,
    rowMenu: o.rowMenu,
    display: o.display,
    onDown: (r, c, e) => {
      if (e.button !== 0) return
      e.preventDefault()
      box.current?.focus({ preventScroll: true })
      dragging.current = true
      go({ row: r, col: c }, e.shiftKey)
    },
    onEnter: (r, c) => {
      if (dragging.current) {
        setFocus({ row: r, col: c })
      }
    },
    onDouble: (r, c) => {
      go({ row: r, col: c })
      if (!o.readOnly) setEditing({ p: { row: r, col: c }, init: o.rows[r]?.[c] ?? '' })
    },
  }
  return {
    edit,
    box,
    focus,
    go,
    picked,
    fill,
    /** 选中的一块：按显示顺序的行、列（只有一格时也算） */
    selection: () =>
      range
        ? {
            rows: line.slice(range.i0, range.i1 + 1),
            cols: Array.from({ length: range.c1 - range.c0 + 1 }, (_, i) => range.c0 + i),
          }
        : null,
    editing: !!editing,
    onKeyDown,
    onPaste: (e: React.ClipboardEvent) => {
      if (editing) return
      e.preventDefault()
      paste(e.clipboardData.getData('text/plain'))
    },
  }
}
