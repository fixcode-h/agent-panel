import { useMemo } from 'react'
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'

/** 选中超过这么多格就只数格子、不求和：几十万格一格格 parseFloat 会掉帧 */
const STAT_MAX = 200_000

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 })

/** 选中的一片里的数字：个数、求和、平均、最小、最大 */
export function selectionStats(rows: string[][], sel: { rows: number[]; cols: number[] } | null) {
  if (!sel) return null
  const cells = sel.rows.length * sel.cols.length
  if (cells <= 1) return null
  if (cells > STAT_MAX) return { cells, nums: 0, sum: 0, min: 0, max: 0, skipped: true }
  let nums = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const r of sel.rows) {
    const row = rows[r]
    if (!row) continue
    for (const c of sel.cols) {
      const v = row[c]
      if (!v) continue
      const n = Number(v)
      if (!Number.isFinite(n) || !v.trim()) continue
      nums++
      sum += n
      if (n < min) min = n
      if (n > max) max = n
    }
  }
  return { cells, nums, sum, min, max, skipped: false }
}

/**
 * 表格页底部的状态栏：当前格和字段、表头说明 | 选中区域的统计、筛选后几行 | 检查状态、没保存的改动、文件格式。
 * 统计只在选中两格以上时算，超过 STAT_MAX 格只数格子
 */
export function TableStatusBar({
  cell,
  header,
  stats,
  shown,
  total,
  problems,
  onProblems,
  pending,
  kind,
  readOnly,
}: {
  /** 当前格：「E6 · DisplayName」 */
  cell: string
  header: { badge: string; tone?: 'accent' | 'warning'; text: string }
  stats: ReturnType<typeof selectionStats>
  /** 筛选后显示几行、一共几行数据 */
  shown: number
  total: number
  problems: number
  onProblems: () => void
  /** 没保存的改动（格子 + 行操作） */
  pending: number
  kind: string
  readOnly: boolean
}) {
  const statText = useMemo(() => {
    if (!stats) return ''
    if (stats.skipped) return t('选中 {n} 格', { n: fmt(stats.cells) })
    if (!stats.nums) return t('选中 {n} 格', { n: fmt(stats.cells) })
    return t('选中 {n} 格 · 数字 {k} 个 · 求和 {sum} · 平均 {avg} · 最小 {min} · 最大 {max}', {
      n: fmt(stats.cells),
      k: fmt(stats.nums),
      sum: fmt(stats.sum),
      avg: fmt(stats.sum / stats.nums),
      min: fmt(stats.min),
      max: fmt(stats.max),
    })
  }, [stats])
  return (
    <div
      role="status"
      aria-label={t('表格状态')}
      className="flex h-6 shrink-0 items-center gap-3 border-t bg-panel px-3 text-caption text-muted"
    >
      <span className="shrink-0 font-mono text-fg">{cell || '—'}</span>
      <span className="flex min-w-0 shrink items-center gap-1.5">
        <Badge tone={header.tone} className="h-4 px-1.5">
          {header.badge}
        </Badge>
        <span className="truncate">{header.text}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-center tabular-nums" title={statText}>
        {statText}
      </span>
      {shown !== total && (
        <span className="shrink-0 text-accent-text tabular-nums">
          {t('显示 {n} / {total} 行', { n: fmt(shown), total: fmt(total) })}
        </span>
      )}
      <button
        type="button"
        onClick={onProblems}
        className={cn(
          'flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1 hover:bg-hover',
          problems ? 'text-danger' : 'text-success',
        )}
      >
        {problems ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
        {problems ? t('{n} 处不合规', { n: problems }) : t('全部合规')}
      </button>
      {pending > 0 && <span className="shrink-0 text-accent-text">{t('{n} 处没保存', { n: pending })}</span>}
      <span className="flex shrink-0 items-center gap-1 font-mono uppercase">
        {readOnly && <Lock className="h-3 w-3" aria-label={t('只读')} />}
        {kind}
      </span>
    </div>
  )
}
