/**
 * 提炼出的分项：需求和 Bug 分两组，每条后面一个「采纳」按钮。
 * 只是挑选，不在这里生成报告：确认按钮在页面底部的确认栏（ConfirmBar），报告只包含采纳的分项。
 */
import { Bug, Check, ListChecks, Plus, Sparkle } from 'lucide-react'
import type { SummaryEntry, SummaryKind } from '@shared/summary'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 两类分项的展示：组标题、图标、颜色；以后加一类只改这里 */
export const KIND_VIEW: Record<SummaryKind, { label: () => string; icon: typeof Bug; tone: string; soft: string }> = {
  need: { label: () => t('需求'), icon: Sparkle, tone: 'text-accent-text', soft: 'bg-accent-soft' },
  bug: { label: () => t('Bug'), icon: Bug, tone: 'text-danger', soft: 'bg-danger/10' },
}

/** 分项的一行说明：需求写「内容」，Bug 写「原因 / 修复」；没写的那一栏不占位 */
function EntryBody({ entry }: { entry: SummaryEntry }) {
  if (entry.kind === 'need')
    return entry.content ? <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">{entry.content}</p> : null
  const rows = [
    { label: t('原因'), text: entry.cause },
    { label: t('修复'), text: entry.fix },
  ].filter((r) => r.text)
  if (!rows.length) return null
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 text-[0.8125rem] leading-relaxed">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-subtle">{r.label}</dt>
          <dd className="text-muted">{r.text}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 一条分项：整张卡可点（和右边的按钮效果一样），采纳后描边和底色变成强调色 */
export function EntryCard({
  entry,
  adopted,
  onToggle,
  disabled,
}: {
  entry: SummaryEntry
  adopted: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <li
      data-summary-entry
      data-adopted={adopted ? '' : undefined}
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors',
        adopted ? 'border-accent/45 bg-accent-soft/45' : 'border-line bg-card hover:border-line-strong',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 text-[0.875rem] leading-snug font-medium">{entry.title}</p>
        </div>
        <EntryBody entry={entry} />
      </div>
      <Button
        size="sm"
        variant={adopted ? 'secondary' : 'ghost'}
        aria-pressed={adopted}
        aria-label={
          adopted ? t('取消采纳「{title}」', { title: entry.title }) : t('采纳「{title}」', { title: entry.title })
        }
        disabled={disabled}
        onClick={onToggle}
        className={cn('shrink-0 border', adopted ? 'border-transparent text-accent-text' : 'border-line-strong')}
      >
        {adopted ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        {adopted ? t('已采纳') : t('采纳')}
      </Button>
    </li>
  )
}

/** 一类分项（需求 / Bug）：组头写条数和已采纳数，组头右边可以一键采纳这一组 */
function EntryGroup({
  kind,
  entries,
  adopted,
  onToggle,
  onAdoptAll,
}: {
  kind: SummaryKind
  entries: SummaryEntry[]
  adopted: Set<string>
  onToggle: (id: string) => void
  onAdoptAll: (ids: string[], on: boolean) => void
}) {
  const view = KIND_VIEW[kind]
  const Icon = view.icon
  const picked = entries.filter((x) => adopted.has(x.id)).length
  const all = picked === entries.length
  return (
    <section aria-label={view.label()} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className={cn('grid h-6 w-6 place-items-center rounded-lg', view.soft, view.tone)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <h3 className="text-[0.8125rem] font-medium">{view.label()}</h3>
        <span className="text-xs text-subtle tabular-nums">
          {t('已采纳 {n}/{total}', { n: picked, total: entries.length })}
        </span>
        <Button
          variant="link"
          tone="muted"
          className="ml-auto text-xs"
          onClick={() =>
            onAdoptAll(
              entries.map((x) => x.id),
              !all,
            )
          }
        >
          {all ? t('全部取消') : t('全部采纳')}
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {entries.map((x) => (
          <EntryCard key={x.id} entry={x} adopted={adopted.has(x.id)} onToggle={() => onToggle(x.id)} />
        ))}
      </ul>
    </section>
  )
}

/** 全部分项：需求在前、Bug 在后（和报告里的顺序一致）；一类都没有时不画那一组 */
export function EntryList({
  entries,
  adopted,
  onToggle,
  onAdoptAll,
}: {
  entries: SummaryEntry[]
  adopted: Set<string>
  onToggle: (id: string) => void
  onAdoptAll: (ids: string[], on: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      {(['need', 'bug'] as const).map((kind) => {
        const list = entries.filter((x) => x.kind === kind)
        return list.length ? (
          <EntryGroup
            key={kind}
            kind={kind}
            entries={list}
            adopted={adopted}
            onToggle={onToggle}
            onAdoptAll={onAdoptAll}
          />
        ) : null
      })}
    </div>
  )
}

/** 底部确认栏：已采纳几条（需求 / Bug 各几条），点确认才生成报告；一条没采纳时按钮不可点 */
export function ConfirmBar({
  entries,
  adopted,
  busy,
  onConfirm,
}: {
  entries: SummaryEntry[]
  adopted: Set<string>
  busy: boolean
  onConfirm: () => void
}) {
  const picked = entries.filter((x) => adopted.has(x.id))
  const need = picked.filter((x) => x.kind === 'need').length
  const bug = picked.length - need
  return (
    <div className="sticky bottom-4 z-10 -mx-1 flex flex-wrap items-center gap-3 rounded-xl border border-line frost-card px-4 py-2.5 shadow-card">
      <ListChecks className="h-4 w-4 text-accent-text" />
      <span className="text-[0.8125rem]">
        {picked.length
          ? t('已采纳 {n} 项 · 需求 {need} · Bug {bug}', { n: picked.length, need, bug })
          : t('还没有采纳分项')}
      </span>
      <Button size="sm" className="ml-auto" disabled={!picked.length || busy} onClick={onConfirm}>
        <Check className="h-3.5 w-3.5" />
        {t('确认生成报告')}
      </Button>
    </div>
  )
}
