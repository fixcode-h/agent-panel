/**
 * 表格页的选中和编辑：像表格软件一样点格子选中、拖动选一块、方向键移动（跳过筛掉的行）、
 * 直接打字或双击 / F2 改、Enter / Tab 确认并移动、Esc 取消、Delete 清空、
 * Ctrl+C / X / V 复制剪切粘贴（和 Excel / WPS 互通的 TSV）、Ctrl+Z / Y 撤销重做、Ctrl+S 保存。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseClip, toClip, type CellSet } from '@shared/table-edit'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import type { SheetEditing } from '@/components/files/SheetTable'

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
  editor: (
    p: Pos,
    init: string,
    done: (v: string | null, move?: 'down' | 'right' | 'left' | 'up') => void,
  ) => React.ReactNode
  mark?: SheetEditing['mark']
  tip?: SheetEditing['tip']
  rowMenu?: SheetEditing['rowMenu']
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
    go({ row, col: Math.min(Math.max(0, focus.col + dc), Math.max(0, o.cols - 1)) }, extend)
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
  const done = (v: string | null, dir?: 'down' | 'right' | 'left' | 'up') => {
    const cur = editing
    setEditing(null)
    if (cur && v !== null) o.onCells([{ r: cur.p.row, c: cur.p.col, v }])
    if (dir) {
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    if (mod && k.toLowerCase() === 'z') return void (e.preventDefault(), e.shiftKey ? o.onRedo() : o.onUndo())
    if (mod && k.toLowerCase() === 'y') return void (e.preventDefault(), o.onRedo())
    if (mod && k.toLowerCase() === 's') return void (e.preventDefault(), o.onSave())
    if (mod && k.toLowerCase() === 'c') return void (e.preventDefault(), copy(false))
    if (mod && k.toLowerCase() === 'x') return void (e.preventDefault(), copy(true))
    if (mod && k.toLowerCase() === 'a') {
      e.preventDefault()
      setAnchor({ row: line[0], col: 0 })
      setFocus({ row: line[line.length - 1], col: o.cols - 1 })
      return
    }
    if (!focus) return
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    if (arrows[k]) {
      e.preventDefault()
      const [dr, dc] = arrows[k]
      const far = mod ? 1e9 : 1
      return move(dr * far, dc * far, e.shiftKey)
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
    editing: !!editing,
    onKeyDown,
    onPaste: (e: React.ClipboardEvent) => {
      if (editing) return
      e.preventDefault()
      paste(e.clipboardData.getData('text/plain'))
    },
  }
}
