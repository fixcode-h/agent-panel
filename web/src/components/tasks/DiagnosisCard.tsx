import { useMemo, useState } from 'react'
import { BadgeCheck, ChevronRight, CircleAlert, TriangleAlert, UserRound } from 'lucide-react'
import type { DiagnosisCard as Card } from '@shared/bug/diagnosis-card'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Collapse } from '@/components/ui/collapse'
import { Markdown } from './Markdown'

/** 卡片里的一行 Markdown（行内代码、文件标记照常）：去掉段落的上下边距，跟着外层的字号 */
const INLINE = '[&_p]:my-0 [&_p]:text-[length:inherit] [&_p]:leading-[inherit]'

/**
 * 诊断报告最上面的决策卡（用户 2026-11-07 确认的设计稿）：状态和标签胶囊、一句话结论、要你做的、要注意。
 * 内容由 shared/bug/diagnosis-card.ts 算，这里只管样式：和请求卡一样的卡片底，左边一道主题色竖线
 */
export function DiagnosisCard({ card, teamNames }: { card: Card; teamNames: Set<string> }) {
  return (
    <section
      aria-label={t('结论')}
      data-diagnosis-card
      className="mb-5 rounded-xl border border-l-[3px] border-l-accent bg-card px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={card.status.tone}>{card.status.text}</Badge>
        {card.tags.map((x) => (
          <Badge key={x.text} tone={x.tone}>
            {x.text}
          </Badge>
        ))}
      </div>
      {card.quote && (
        <div className="mt-2 flex gap-1 text-footnote text-subtle">
          <span className="shrink-0">{t('根因：')}</span>
          <Markdown text={card.quote} teamNames={teamNames} className={cn(INLINE, 'min-w-0 text-subtle')} />
        </div>
      )}
      <Markdown
        text={card.headline}
        teamNames={teamNames}
        className={cn(INLINE, 'mt-2 text-heading font-semibold text-fg [&_p+p]:mt-1')}
      />
      <CauseStrip card={card} teamNames={teamNames} />
      <p className="mt-1.5 text-body text-muted">
        <span className="font-medium text-fg">{t('要你做的：')}</span>
        {card.todo}
      </p>
      {card.attention.length > 0 && (
        <ul
          aria-label={t('要注意')}
          className="mt-2.5 space-y-1 rounded-lg border border-warning/25 bg-warning/8 px-3 py-2 text-body"
        >
          {card.attention.map((a) => {
            const Icon = a.tone === 'danger' ? CircleAlert : TriangleAlert
            return (
              <li
                key={a.text}
                className={cn('flex items-start gap-1.5', a.tone === 'danger' ? 'text-danger' : 'text-warning')}
              >
                <Icon className="mt-[0.2em] h-3.5 w-3.5 shrink-0" />
                <span>{a.text}</span>
              </li>
            )
          })}
        </ul>
      )}
      {card.changed && (
        <div className="mt-2.5 flex gap-1 border-l-2 border-line-strong pl-3 text-footnote text-subtle">
          <span className="shrink-0">{t('相比上一份：')}</span>
          <Markdown text={card.changed} teamNames={teamNames} className={cn(INLINE, 'min-w-0 text-subtle')} />
        </div>
      )}
    </section>
  )
}

/** 等级的颜色：低级是最不该出的错，用红；中级琥珀；高级是难题，用主题色 */
const TIER_TONE = {
  low: { chip: 'bg-danger/12 text-danger', bar: 'bg-danger' },
  mid: { chip: 'bg-warning/15 text-warning', bar: 'bg-warning' },
  high: { chip: 'bg-accent/12 text-accent', bar: 'bg-accent' },
} as const

/**
 * 根因等级、把握百分比和引入的人（用户 2026-11-10 定：要醒目）：紧跟在一句话结论下面，
 * 左边是等级和把握（大字的百分比加一条进度），右边是提交人和那次提交。两块都没有时不画
 */
function CauseStrip({ card, teamNames }: { card: Card; teamNames: Set<string> }) {
  const { rating, origin } = card
  if (!rating && !origin) return null
  const tone = rating && TIER_TONE[rating.tier]
  return (
    <div
      data-cause-strip
      className="mt-2.5 grid gap-x-5 gap-y-2.5 rounded-lg border border-line bg-bg px-3.5 py-2.5 sm:grid-cols-2"
    >
      {rating && tone && (
        <div className="min-w-0">
          <div className="text-caption text-subtle">{t('根因等级')}</div>
          <div className="mt-1 flex items-center gap-2.5">
            <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-heading font-semibold', tone.chip)}>
              {rating.label}
            </span>
            <span className="min-w-0 truncate text-footnote text-muted">{rating.hint}</span>
          </div>
          <div className="mt-2 flex items-center gap-2.5">
            <span className="shrink-0 text-caption text-subtle">{t('把握')}</span>
            <span
              role="meter"
              aria-label={t('把握')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={rating.percent}
              className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sel"
            >
              <span className={cn('block h-full rounded-full', tone.bar)} style={{ width: `${rating.percent}%` }} />
            </span>
            <span className="shrink-0 text-title leading-none font-semibold text-fg tabular-nums">
              {rating.percent}
              <span className="text-footnote font-medium text-muted">%</span>
            </span>
          </div>
          {rating.why && (
            <Markdown
              text={rating.why}
              teamNames={teamNames}
              className={cn(INLINE, 'mt-1.5 text-footnote text-muted')}
            />
          )}
        </div>
      )}
      {origin && (
        <div className="min-w-0">
          <div className="text-caption text-subtle">{origin.author ? t('提交人') : t('引入点')}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {origin.author && (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-heading font-semibold text-fg">
                <UserRound className="h-4 w-4 shrink-0 text-muted" />
                <span className="truncate">{origin.author}</span>
              </span>
            )}
            <Badge tone="neutral">{origin.category}</Badge>
            {origin.verified && (
              <span className="inline-flex items-center gap-1 text-caption text-success">
                <BadgeCheck className="h-3.5 w-3.5" />
                {t('已按版本记录核对')}
              </span>
            )}
          </div>
          <div className="mt-2 text-footnote leading-relaxed text-muted">
            {origin.change && <code className="mr-1.5 font-mono text-fg">{origin.change}</code>}
            {origin.title && <span>{`《${origin.title}》`}</span>}
            {origin.date && <span className="ml-1.5 text-subtle">{origin.date}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 报告末尾的「依据和背景」（现象、时间线、调用路径……）：默认收起，标题旁列出里面有哪几节。
 * 标题是一个 h2：标题目录（DocOutline）把它当一节列出来，点目录里的它会先展开再跳过去（data-fold）
 */
export function ReportFold({ text, teamNames }: { text: string; teamNames: Set<string> }) {
  const [open, setOpen] = useState(false)
  const names = useMemo(() => [...text.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim()), [text])
  return (
    <div className="mt-6 border-t border-line pt-3">
      {/* 不放进 .chat-md：Markdown 标题的装饰（色条、下划线）是给正文标题的，这一行是展开收起的开关 */}
      <h2 data-fold={open ? 'open' : 'closed'} data-outline-text={t('依据和背景')} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md py-1 text-left text-heading font-semibold text-muted hover:text-fg"
        >
          <ChevronRight className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')} />
          <span className="shrink-0">{t('依据和背景')}</span>
          {!open && names.length > 0 && (
            <span className="min-w-0 truncate text-footnote font-normal text-subtle">{names.join(' · ')}</span>
          )}
        </button>
      </h2>
      <Collapse open={open}>
        <Markdown text={text} teamNames={teamNames} />
      </Collapse>
    </div>
  )
}
