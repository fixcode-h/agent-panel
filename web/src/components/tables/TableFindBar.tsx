import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, CornerDownLeft, Search, X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CellHit } from '@/lib/sheet'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'

/** 命中最多记这么多处：再多也看不过来，一万行的表也不会卡 */
const MAX_HITS = 5000

export type FindMode = 'find' | 'goto'

/** 在显示着的行（筛选排序后）、没隐藏的列里找包含 q 的格子；只查一列时 col 传列号 */
export function findHits(
  rows: string[][],
  order: number[],
  cols: number,
  hidden: Set<number>,
  q: string,
  col?: number,
) {
  const needle = q.trim().toLowerCase()
  const out: CellHit[] = []
  if (!needle) return out
  for (const r of order) {
    const row = rows[r]
    if (!row) continue
    for (let c = col ?? 0; c < (col === undefined ? cols : col + 1); c++) {
      if (hidden.has(c)) continue
      const v = row[c]
      if (v && v.toLowerCase().includes(needle)) {
        out.push({ row: r, col: c })
        if (out.length >= MAX_HITS) return out
      }
    }
  }
  return out
}

/**
 * 表格顶上的查找条（Ctrl+F）和跳转条（Ctrl+G）：不开弹窗，打字就高亮。
 * 查找：Enter 下一个、Shift+Enter 上一个，可以只查当前列；跳转：填行号或主键，Enter 跳过去。
 * Esc 关掉，焦点回表格
 */
export function TableFindBar({
  mode,
  onMode,
  rows,
  from,
  order,
  cols,
  hidden,
  focusCol,
  colName,
  keyName,
  findKey,
  onGo,
  onHits,
  onClose,
}: {
  mode: FindMode
  onMode: (m: FindMode) => void
  rows: string[][]
  /** 数据从第几行开始（上面是表头，一直显示着） */
  from: number
  /** 显示着的数据行 */
  order: number[]
  cols: number
  hidden: Set<number>
  focusCol?: number
  colName: (c: number) => string
  /** 主键字段名（没设主键时只能按行号跳） */
  keyName?: string
  /** 按主键找行：找不到给 -1 */
  findKey: (key: string) => number
  onGo: (row: number, col: number) => void
  onHits: (hits: CellHit[]) => void
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [goto, setGoto] = useState('')
  const [err, setErr] = useState('')
  const [colOnly, setColOnly] = useState(false)
  const [cur, setCur] = useState(0)
  // 打字时稍等一下再找：一万行 × 几十列每个字都扫一遍会顿
  const [term, setTerm] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setTerm(q), 120)
    return () => clearTimeout(id)
  }, [q])
  const col = colOnly && focusCol !== undefined ? focusCol : undefined
  const hits = useMemo(
    () => (mode === 'find' ? findHits(rows, order, cols, hidden, term, col) : []),
    [mode, rows, order, cols, hidden, term, col],
  )
  useEffect(() => {
    onHits(hits)
    setCur(0)
    // 只在命中变了时通知（onHits 每次渲染都是新函数）
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [hits])
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [mode])
  // 关掉时把高亮清掉
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onHits([]), [])

  const step = (d: number) => {
    if (!hits.length) return
    const i = (cur + d + hits.length) % hits.length
    setCur(i)
    onGo(hits[i].row, hits[i].col)
  }
  const jump = () => {
    const s = goto.trim()
    if (!s) return
    let r = keyName ? findKey(s) : -1
    if (r < 0 && /^\d+$/.test(s)) r = Number(s) - 1
    if (r < 0 || r >= rows.length) return setErr(keyName ? t('没有这一行，也没有这个主键') : t('没有这一行'))
    if (r >= from && !order.includes(r)) return setErr(t('这一行被筛选藏起来了'))
    setErr('')
    onGo(r, focusCol ?? 0)
    onClose()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return void (e.preventDefault(), onClose())
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') return void (e.preventDefault(), onMode('goto'))
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') return void (e.preventDefault(), onMode('find'))
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (mode === 'goto') return jump()
    // 还没等到防抖就按了回车：先按当前的字找
    if (term !== q) return setTerm(q)
    step(e.shiftKey ? -1 : 1)
  }
  const box =
    'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-(--c-input-radius) border border-line-strong bg-(--c-input-bg) px-2 focus-within:border-focus'
  return (
    <div
      role="search"
      aria-label={mode === 'find' ? t('在表格里查找') : t('跳到行')}
      className="flex h-9 shrink-0 items-center gap-2 border-b bg-panel px-3 text-footnote"
    >
      {mode === 'find' ? (
        <>
          <label className={cn(box, 'max-w-[420px]')}>
            <Search className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder={t('查找（Enter 下一个，Shift+Enter 上一个）')}
              aria-label={t('查找')}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-subtle"
            />
            <span className="shrink-0 text-subtle tabular-nums">
              {term.trim()
                ? hits.length
                  ? `${cur + 1} / ${hits.length >= MAX_HITS ? `${MAX_HITS}+` : hits.length}`
                  : t('没有找到')
                : ''}
            </span>
          </label>
          <IconButton icon={ChevronUp} size="xs" label={t('上一个')} disabled={!hits.length} onClick={() => step(-1)} />
          <IconButton
            icon={ChevronDown}
            size="xs"
            label={t('下一个')}
            disabled={!hits.length}
            onClick={() => step(1)}
          />
          <button
            type="button"
            aria-pressed={colOnly}
            disabled={focusCol === undefined}
            onClick={() => setColOnly((v) => !v)}
            className={cn(
              'h-6 cursor-pointer rounded-md px-2 whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40',
              colOnly ? 'bg-accent-soft font-medium text-accent-text' : 'chip-idle text-muted hover:text-fg',
            )}
          >
            {focusCol !== undefined ? t('只查 {col} 列', { col: colName(focusCol) }) : t('只查当前列')}
          </button>
        </>
      ) : (
        <>
          <label className={cn(box, 'max-w-[320px]')}>
            <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <input
              ref={input}
              value={goto}
              onChange={(e) => {
                setGoto(e.target.value)
                setErr('')
              }}
              onKeyDown={onKey}
              placeholder={keyName ? t('行号或 {key}', { key: keyName }) : t('行号')}
              aria-label={t('跳到行')}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-subtle"
            />
          </label>
          <span className={cn('min-w-0 truncate', err ? 'text-danger' : 'text-subtle')}>
            {err || (keyName ? t('先按 {key} 找，找不到再当行号', { key: keyName }) : t('填表格左边的行号'))}
          </span>
        </>
      )}
      <IconButton icon={X} size="xs" label={t('关闭（Esc）')} className="ml-auto" onClick={onClose} />
    </div>
  )
}
