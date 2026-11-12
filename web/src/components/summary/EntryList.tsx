/**
 * 提炼出的分项：需求和 Bug 分两组，每条后面一个「采纳」按钮。
 * 只是挑选，不在这里生成报告：确认按钮在页面底部的确认栏（ConfirmBar），报告只包含采纳的分项。
 */
import { useState } from 'react'
import { Bug, Check, Link2, ListChecks, Pencil, Plus, Sparkle, X } from 'lucide-react'
import type { SummaryEntry, SummaryKind } from '@shared/summary'
import type { SummaryCode } from '@shared/summary-code'
import { splitPoints } from '@shared/summary-code'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'

/** 两类分项的展示：组标题、图标、颜色；以后加一类只改这里 */
export const KIND_VIEW: Record<SummaryKind, { label: () => string; icon: typeof Bug; tone: string; soft: string }> = {
  need: { label: () => t('需求'), icon: Sparkle, tone: 'text-accent-text', soft: 'bg-accent-soft' },
  bug: { label: () => t('Bug'), icon: Bug, tone: 'text-danger', soft: 'bg-danger/10' },
}

/** 一组分点：按序号一行一点（老报告的分项是一段话，就是一点） */
function Points({ text }: { text: string }) {
  const list = splitPoints(text)
  if (!list.length) return null
  return (
    <ol className="list-decimal space-y-0.5 pl-5 text-muted marker:text-subtle">
      {list.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ol>
  )
}

/** Bug 附的关键代码：文件路径 + 代码，太长时在框里滚动，不把列表撑得很长 */
function CodePreview({ code }: { code: SummaryCode }) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-lg border border-line bg-panel" data-summary-code>
      {code.file && (
        <figcaption className="truncate border-b border-line px-2.5 py-1 font-mono text-xs text-subtle">
          {code.file}
        </figcaption>
      )}
      <pre className="max-h-56 overflow-auto px-2.5 py-2 font-mono text-xs leading-relaxed text-fg">{code.text}</pre>
    </figure>
  )
}

/**
 * 分项的说明：需求是怎么做的几点；Bug 分「原因 / 修复 / 关键代码」三块（ADR 0056），
 * 没解决的没有修复和代码。没写的那一块不占位
 */
function EntryBody({ entry }: { entry: SummaryEntry }) {
  if (entry.kind === 'need')
    return entry.content ? (
      <div className="mt-1 text-body leading-relaxed">
        <Points text={entry.content} />
      </div>
    ) : null
  const code = entry.fix ? (entry.code ?? []) : []
  const rows = [
    { label: t('原因'), node: entry.cause ? <Points text={entry.cause} /> : null },
    { label: t('修复'), node: entry.fix ? <Points text={entry.fix} /> : null },
    {
      label: t('关键代码'),
      node: code.length ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          {code.map((c, i) => (
            <CodePreview key={i} code={c} />
          ))}
        </div>
      ) : null,
    },
  ].filter((r) => r.node)
  if (!rows.length) return null
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-body leading-relaxed">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-subtle">{r.label}</dt>
          <dd className="min-w-0">{r.node}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 单子链接是网址时可以点开看；单号（BUG-123）照原样显示 */
const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())

/**
 * 分项附的单子（Bug 单 / 需求单的网址或单号，ADR 0043）：没填时是一个「附加单子」的小按钮，点开就地填；
 * 填过的显示链接，可以改或去掉。回车、失焦都算填完；Esc 放弃这次修改
 */
function EntryLink({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const done = () => {
    setEditing(false)
    if (draft.trim() !== value) onChange(draft.trim())
  }
  if (editing)
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done()
          if (e.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        maxLength={300}
        aria-label={t('单子链接')}
        placeholder={t('Bug 单或需求单的链接、单号')}
        className="mt-2 h-8 text-body"
      />
    )
  if (!value)
    return (
      <Button
        variant="link"
        tone="muted"
        className="mt-1.5 text-xs"
        onClick={() => {
          setDraft('')
          setEditing(true)
        }}
      >
        <Link2 className="h-3.5 w-3.5" />
        {t('附加单子')}
      </Button>
    )
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted" data-summary-link>
      <Link2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
      {isUrl(value) ? (
        <a href={value} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent-text hover:underline">
          {value}
        </a>
      ) : (
        <span className="min-w-0 truncate">{value}</span>
      )}
      <IconButton
        icon={Pencil}
        size="2xs"
        label={t('改单子链接')}
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
      />
      <IconButton icon={X} size="2xs" label={t('去掉单子链接')} onClick={() => onChange('')} />
    </div>
  )
}

/** 一条分项：整张卡可点（和右边的按钮效果一样），采纳后描边和底色变成强调色 */
export function EntryCard({
  entry,
  adopted,
  onToggle,
  disabled,
  link,
  onLink,
}: {
  entry: SummaryEntry
  adopted: boolean
  onToggle: () => void
  disabled?: boolean
  /** 待确认时附的单子；不传 onLink 时不显示（只读的地方） */
  link?: string
  onLink?: (v: string) => void
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
          <p className="min-w-0 text-prose leading-snug font-medium">{entry.title}</p>
          {entry.kind === 'bug' && !entry.fix && (
            <span className="shrink-0 rounded-md bg-warning/10 px-1.5 py-0.5 text-xs text-warning">{t('未解决')}</span>
          )}
        </div>
        <EntryBody entry={entry} />
        {onLink && <EntryLink value={link ?? ''} onChange={onLink} />}
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
  links,
  onLink,
}: {
  kind: SummaryKind
  entries: SummaryEntry[]
  adopted: Set<string>
  onToggle: (id: string) => void
  onAdoptAll: (ids: string[], on: boolean) => void
  links: Record<string, string>
  onLink: (id: string, v: string) => void
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
        <h3 className="text-body font-medium">{view.label()}</h3>
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
          <EntryCard
            key={x.id}
            entry={x}
            adopted={adopted.has(x.id)}
            onToggle={() => onToggle(x.id)}
            link={links[x.id] ?? x.link}
            onLink={(v) => onLink(x.id, v)}
          />
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
  links,
  onLink,
}: {
  entries: SummaryEntry[]
  adopted: Set<string>
  onToggle: (id: string) => void
  onAdoptAll: (ids: string[], on: boolean) => void
  /** 待确认时附的单子链接（分项 id → 链接） */
  links: Record<string, string>
  onLink: (id: string, v: string) => void
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
            links={links}
            onLink={onLink}
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
      <span className="text-body">
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
