import { useState } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { SHEET_ROLES, detectSheetHeader, type SheetHeader, type SheetRole } from '@shared/sheet-header'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import type { SheetView } from './use-sheet-view'
import { roleLabel } from './sheet-roles'
import './sheet-table.css'

/** 表头最多设这么多行 */
const MAX_ROWS = 12

/**
 * 表格上方的一行：认出的表头（第几行到第几行、每行什么颜色）、筛选了多少行，右边「调整表头」。
 * 自动识别没把握时用警告色提示，让用户去改
 */
export function SheetHeaderBar({ view, rows }: { view: SheetView; rows: string[][] }) {
  const { header, auto, sure, from, order } = view
  const n = header.roles.length
  const dataCount = Math.max(0, rows.length - from)
  const filtered = order.length !== dataCount || !!view.sort
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-body">
      <Badge tone={auto ? (sure ? 'accent' : 'warning') : undefined}>{auto ? t('自动识别') : t('手动设置')}</Badge>
      <span className="min-w-0 truncate text-muted">
        {n
          ? t('表头 {n} 行（第 {a}–{b} 行），数据从第 {c} 行开始', {
              n,
              a: header.start + 1,
              b: header.start + n,
              c: from + 1,
            })
          : t('没认出表头，全部按数据显示')}
      </span>
      {n > 0 && (
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
      <HeaderSetup view={view} rows={rows} />
    </div>
  )
}

/** 调整表头：从第几行开始、共几行、每行是什么；只记在本机，表格文件不动 */
function HeaderSetup({ view, rows }: { view: SheetView; rows: string[][] }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<SheetHeader>(view.header)
  const last = Math.max(1, rows.length)
  const setStart = (v: number) => setDraft((d) => ({ ...d, start: Math.min(Math.max(1, v), last) - 1 }))
  const setCount = (v: number) =>
    setDraft((d) => {
      const n = Math.min(Math.max(0, v), MAX_ROWS)
      const roles = d.roles.slice(0, n)
      while (roles.length < n) roles.push('other')
      return { ...d, roles }
    })
  const setRole = (i: number, r: SheetRole) =>
    setDraft((d) => ({ ...d, roles: d.roles.map((x, j) => (j === i ? r : x)) }))
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
        <Button size="sm" variant="ghost" className="h-7">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('调整表头')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-3" align="end">
        <div className="mb-3 text-body font-medium text-fg">{t('表头设置')}</div>
        <div className="flex flex-wrap items-center gap-2 text-body text-muted">
          {t('从第')}
          <Input
            size="sm"
            type="number"
            min={1}
            max={last}
            aria-label={t('表头从第几行开始')}
            value={draft.start + 1}
            onChange={(e) => setStart(Number(e.target.value))}
            className="w-16 font-mono"
          />
          {t('行开始，共')}
          <Input
            size="sm"
            type="number"
            min={0}
            max={MAX_ROWS}
            aria-label={t('表头共几行')}
            value={draft.roles.length}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-16 font-mono"
          />
          {t('行')}
        </div>
        {draft.roles.length > 0 && (
          <>
            <div className="mt-3 mb-1.5 text-caption text-subtle">{t('每行是什么（决定底色）')}</div>
            <div className="flex flex-col gap-1.5">
              {draft.roles.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-right font-mono text-caption text-subtle">
                    {draft.start + i + 1}
                  </span>
                  <span className={cn('h-4 w-4 shrink-0 rounded-sm sheet-role', `sheet-role-${r}`)} />
                  <div className="min-w-0 flex-1">
                    <Select
                      size="sm"
                      aria-label={t('第 {n} 行', { n: draft.start + i + 1 })}
                      title={preview(draft.start + i)}
                      value={r}
                      onChange={(e) => setRole(i, e.target.value as SheetRole)}
                      options={SHEET_ROLES.map((x) => ({ value: x, label: roleLabel(x) }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="mt-3 rounded-lg bg-sel px-2.5 py-2 text-caption leading-relaxed text-subtle">
          {t('只记在这台电脑上，表格文件一个字节都不改。')}
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
