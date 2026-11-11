import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@shared/i18n'
import { foldSame, type DiffRow, type SheetDiff } from '@shared/sheet-diff'
import { colName } from '@/lib/sheet'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { useRowH } from '@/components/files/SheetTable'
import '@/components/files/sheet-table.css'

/** 看得见的行上下再多画几行 */
const OVER = 20
/** 每列宽度（固定列宽：只画看得见的行，列宽不能跟着内容跳） */
const COL_W = 150

/**
 * 两版表格的格子级差异（版本差异、跨项目对比共用）：改过的格子旧值划掉、新值绿色，新增的行整行绿底、
 * 删掉的行整行红底划掉；「只看变化」时没变的连续几行折成一行，点开能看。
 * 列标题用新表的字段名；颜色、行高、字体跟着设置 → 组件 → 表格的微调。
 * 自己带滚动区，只画看得见的行（几千行也不卡）
 */
export function SheetDiffView({
  a,
  b,
  diff,
  names,
  onlyChanges,
  pick,
  rowAction,
}: {
  a: string[][]
  b: string[][]
  diff: SheetDiff
  /** 新表的字段名（没有就用列字母） */
  names: string[]
  onlyChanges: boolean
  /** 能勾选的行（跨项目对比「拷到另一边」）：i 是 diff.rows 的下标 */
  pick?: { can: (row: DiffRow) => boolean; picked: Set<number>; onToggle: (i: number, on: boolean) => void }
  /** 行尾的操作（版本差异里「还原」） */
  rowAction?: (row: DiffRow) => React.ReactNode
}) {
  const [opened, setOpened] = useState<Set<number>>(new Set())
  type Line = { row: DiffRow; i: number } | { fold: [number, number]; count: number; k: number }
  const lines = useMemo<Line[]>(() => {
    const index = new Map(diff.rows.map((r, i) => [r, i]))
    const list = onlyChanges ? foldSame(diff.rows) : diff.rows.map((row) => ({ row }))
    // 点开的折叠段换成里面的行
    return list.flatMap((l, k): Line[] =>
      'fold' in l && opened.has(k)
        ? diff.rows
            .filter((r) => r.kind === 'same' && (r.b ?? -1) >= l.fold[0] && (r.b ?? -1) <= l.fold[1])
            .map((row) => ({ row, i: index.get(row)! }))
        : 'fold' in l
          ? [{ ...l, k }]
          : [{ row: l.row, i: index.get(l.row)! }],
    )
  }, [diff, onlyChanges, opened])
  const cols = diff.colMap.length
  const box = useRef<HTMLDivElement>(null)
  const rowH = useRowH()
  const [win, setWin] = useState({ from: 0, to: 80 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    let frame = 0
    const read = () => {
      frame = 0
      const a = Math.max(0, Math.floor(el.scrollTop / rowH) - OVER)
      const b = Math.ceil((el.scrollTop + el.clientHeight) / rowH) + OVER
      setWin((w) => (w.from === a && w.to === b ? w : { from: a, to: b }))
    }
    const later = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    el.addEventListener('scroll', later, { passive: true })
    const ro = new ResizeObserver(later)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', later)
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [rowH])
  const shown = lines.slice(win.from, win.to)
  const old = (r: number, c: number) => (diff.colMap[c] < 0 ? '' : (a[r]?.[diff.colMap[c]] ?? ''))
  const span = cols + 1 + (pick ? 1 : 0) + (rowAction ? 1 : 0)
  return (
    <div ref={box} className="thin-scroll min-h-0 flex-1 overflow-auto">
      <table
        className="sheet-diff table-fixed text-footnote"
        style={{ width: (pick ? 32 : 0) + 56 + cols * COL_W + (rowAction ? 64 : 0) }}
      >
        <colgroup>
          {pick && <col style={{ width: 32 }} />}
          <col style={{ width: 56 }} />
          {Array.from({ length: cols }, (_, c) => (
            <col key={c} style={{ width: COL_W }} />
          ))}
          {rowAction && <col style={{ width: 64 }} />}
        </colgroup>
        <thead className="sticky top-0 z-[1] bg-panel">
          <tr>
            {pick && <th />}
            <th className="px-2 text-right font-normal text-subtle">#</th>
            {Array.from({ length: cols }, (_, c) => (
              <th
                key={c}
                className="truncate px-2 text-left font-[var(--c-grid-nameBold)]"
                title={names[c] || colName(c)}
              >
                {names[c] || colName(c)}
                {diff.colMap[c] < 0 && <span className="ml-1.5 text-caption text-(--c-grid-added)">{t('新列')}</span>}
              </th>
            ))}
            {rowAction && <th />}
          </tr>
        </thead>
        <tbody>
          {win.from > 0 && <tr aria-hidden style={{ height: win.from * rowH }} />}
          {shown.map((l) => {
            if ('fold' in l)
              return (
                <tr key={`f${l.k}`}>
                  <td colSpan={span} className="p-0">
                    <button
                      type="button"
                      onClick={() => setOpened((s) => new Set(s).add(l.k))}
                      className="w-full cursor-pointer px-3 text-center text-caption text-subtle hover:bg-hover hover:text-fg"
                    >
                      {t('… 第 {from}–{to} 行没变（{n} 行），点开看 …', {
                        from: l.fold[0] + 1,
                        to: l.fold[1] + 1,
                        n: l.count,
                      })}
                    </button>
                  </td>
                </tr>
              )
            const { row, i } = l
            const changed = new Set(row.cols ?? [])
            const src = row.kind === 'del' ? null : b[row.b!]
            return (
              <tr
                key={i}
                className={cn(row.kind === 'add' && 'sheet-diff-add', row.kind === 'del' && 'sheet-diff-del')}
              >
                {pick && (
                  <td className="px-2">
                    {pick.can(row) && (
                      <Checkbox
                        checked={pick.picked.has(i)}
                        onChange={(v) => pick.onToggle(i, v)}
                        ariaLabel={t('选中第 {n} 行', { n: (row.b ?? row.a ?? 0) + 1 })}
                      />
                    )}
                  </td>
                )}
                <td className="px-2 text-right text-caption text-subtle">{(row.b ?? row.a ?? 0) + 1}</td>
                {Array.from({ length: cols }, (_, c) => {
                  const v = src ? (src[c] ?? '') : old(row.a!, c)
                  if (!changed.has(c))
                    return (
                      <td key={c} className="truncate px-2" title={v}>
                        {v}
                      </td>
                    )
                  const was = old(row.a!, c)
                  return (
                    <td key={c} className="sheet-diff-cell truncate px-2" title={`${was} → ${v}`}>
                      {was && (
                        <Fragment>
                          <del className="sheet-diff-old">{was}</del>{' '}
                        </Fragment>
                      )}
                      <ins className="sheet-diff-new">{v || t('（清空）')}</ins>
                    </td>
                  )
                })}
                {rowAction && <td className="px-1 text-right">{rowAction(row)}</td>}
              </tr>
            )
          })}
          {lines.length > win.to && <tr aria-hidden style={{ height: (lines.length - win.to) * rowH }} />}
        </tbody>
      </table>
      {diff.rows.length === 0 && (
        <p className="px-3 py-6 text-center text-footnote text-subtle">{t('两边都没有数据行')}</p>
      )}
    </div>
  )
}

/** 差异摘要的几个小标签：按什么对齐、改了几格、加删几行、表头变化 */
export function DiffSummary({ diff }: { diff: SheetDiff }) {
  const s = diff.stats
  const chip = 'inline-flex h-6 items-center rounded-(--c-badge-radius) px-2 text-caption'
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className={cn(chip, 'bg-sel text-muted')}>
        {diff.key ? t('按主键 {key} 对齐', { key: diff.key }) : t('按行内容对齐')}
      </span>
      {s.cells > 0 && <span className={cn(chip, 'sheet-diff-cell text-fg')}>{t('改 {n} 格', { n: s.cells })}</span>}
      {s.add > 0 && (
        <span className={cn(chip, 'sheet-diff-new bg-(--c-grid-added)/12')}>+{t('{n} 行', { n: s.add })}</span>
      )}
      {s.del > 0 && (
        <span className={cn(chip, 'bg-(--c-grid-removed)/12 text-(--c-grid-removed)')}>
          −{t('{n} 行', { n: s.del })}
        </span>
      )}
      {!s.cells && !s.add && !s.del && <span className={cn(chip, 'bg-sel text-subtle')}>{t('数据没变')}</span>}
      {(diff.addedCols.length > 0 || diff.removedCols.length > 0 || diff.headerChanged.length > 0) && (
        <span
          className={cn(chip, 'bg-warning/12 text-warning')}
          title={[
            diff.addedCols.length && t('加了列：{c}', { c: diff.addedCols.join('、') }),
            diff.removedCols.length && t('删了列：{c}', { c: diff.removedCols.join('、') }),
            diff.headerChanged.length && t('表头改了：{c}', { c: diff.headerChanged.join('、') }),
          ]
            .filter(Boolean)
            .join('\n')}
        >
          {t('表头变了')}
        </span>
      )}
    </span>
  )
}
