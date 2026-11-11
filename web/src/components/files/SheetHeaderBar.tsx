import { useState } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { detectSheetHeader, type SheetHeader } from '@shared/sheet-header'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import type { SheetView } from './use-sheet-view'
import { roleLabel } from './sheet-roles'
import { HeaderRuleEditor } from './HeaderRuleEditor'
import './sheet-table.css'

/** 表头说明：标签（自动识别 / 项目风格 / 手动设置）和一句话，表头栏和表格页的状态栏共用 */
export function headerSummary(view: SheetView) {
  const { header, auto, sure, from } = view
  const n = header.roles.length
  return {
    badge: auto ? t('自动识别') : view.fromStyle ? t('项目风格') : t('手动设置'),
    tone: auto ? (sure ? ('accent' as const) : ('warning' as const)) : undefined,
    text: n
      ? t('表头 {n} 行（第 {a}–{b} 行），数据从第 {c} 行开始', {
          n,
          a: header.start + 1,
          b: header.start + n,
          c: from + 1,
        })
      : t('没认出表头，全部按数据显示'),
  }
}

/**
 * 表格上方的一行：认出的表头（第几行到第几行、每行什么颜色）、筛选了多少行，右边「调整表头」。
 * 自动识别没把握时用警告色提示，让用户去改
 */
export function SheetHeaderBar({
  view,
  rows,
  where,
  presets,
  compact,
  children,
}: {
  /** 表格页：表头说明挪到底部状态栏，这一行只留工具栏 */
  compact?: boolean
  view: SheetView
  rows: string[][]
  /** 项目里设好的几套表头：「调整表头」里点一下就套用 */
  presets?: SheetHeader[]
  /** 手动设置的表头记在哪（弹层底下的一句话）；不传就是本机浏览器 */
  where?: string
  /** 「调整表头」左边的额外按钮（表格页的保存、撤销……） */
  children?: React.ReactNode
}) {
  const { header, from, order } = view
  const n = header.roles.length
  const dataCount = Math.max(0, rows.length - from)
  const filtered = order.length !== dataCount || !!view.sort
  const sum = headerSummary(view)
  return (
    <div className="sheet-bar flex h-9 shrink-0 items-center gap-2 border-b px-3 text-body">
      {!compact && <Badge tone={sum.tone}>{sum.badge}</Badge>}
      {!compact && <span className="min-w-0 truncate text-muted">{sum.text}</span>}
      {!compact && n > 0 && (
        <span className="flex shrink-0 gap-1" aria-hidden>
          {header.roles.map((r, i) => (
            <span key={i} title={roleLabel(r)} className={cn('h-3 w-3 rounded-[3px] sheet-role', `sheet-role-${r}`)} />
          ))}
        </span>
      )}
      <span className="flex-1" />
      {filtered && (
        <span className="flex shrink-0 items-center gap-1 text-caption text-accent-text">
          <span className="tabular-nums">{t('显示 {n} / {total} 行', { n: order.length, total: dataCount })}</span>
          <button
            type="button"
            aria-label={t('清除筛选和排序')}
            title={t('清除筛选和排序')}
            onClick={view.clearFilters}
            className="grid h-5 w-5 cursor-pointer place-items-center rounded-sm hover:bg-hover"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      {children}
      <HeaderSetup view={view} rows={rows} where={where} presets={presets} />
    </div>
  )
}

/** 调整表头：从第几行开始、共几行、每行是什么；只记在本机，表格文件不动 */
function HeaderSetup({
  view,
  rows,
  where,
  presets,
}: {
  view: SheetView
  rows: string[][]
  where?: string
  presets?: SheetHeader[]
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<SheetHeader>(view.header)
  const last = Math.max(1, rows.length)
  // 每行预览前几格的字，认得出是哪一行
  const preview = (r: number) =>
    (rows[r] ?? [])
      .filter((c) => c)
      .slice(0, 3)
      .join(' · ')

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft(view.header)
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="sheet-tool h-7" title={t('调整表头')}>
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('调整表头')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-3" align="end">
        <div className="mb-3 text-body font-medium text-fg">{t('表头设置')}</div>
        {presets && presets.length > 1 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-caption text-subtle">
            {t('套用项目的表头：')}
            {presets.map((h, i) => (
              <Button
                key={i}
                size="sm"
                variant={
                  JSON.stringify(h.roles) === JSON.stringify(draft.roles) && h.start === draft.start
                    ? 'secondary'
                    : 'ghost'
                }
                title={h.roles.map((r, j) => h.labels?.[j] || roleLabel(r)).join(' / ')}
                onClick={() => setDraft({ start: h.start, roles: h.roles, ...(h.labels ? { labels: h.labels } : {}) })}
              >
                {t('第 {n} 套（{rows} 行）', { n: i + 1, rows: h.roles.length })}
              </Button>
            ))}
          </div>
        )}
        <HeaderRuleEditor value={draft} onChange={setDraft} last={last} preview={preview} />
        <p className="mt-3 rounded-lg bg-sel px-2.5 py-2 text-caption leading-relaxed text-subtle">
          {where ?? t('只记在这台电脑上，表格文件一个字节都不改。')}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              view.setHeader(null)
              setDraft(detectSheetHeader(rows))
              setOpen(false)
            }}
          >
            {t('恢复自动识别')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              view.setHeader(draft)
              setOpen(false)
            }}
          >
            {t('确定')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
