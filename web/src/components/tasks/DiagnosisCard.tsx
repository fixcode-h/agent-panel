import { useMemo, useState } from 'react'
import { ChevronRight, CircleAlert, TriangleAlert } from 'lucide-react'
import type { DiagnosisCard as Card } from '@shared/bug-diagnosis-card'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Collapse } from '@/components/ui/collapse'
import { Markdown } from './Markdown'

/** 卡片里的一行 Markdown（行内代码、文件标记照常）：去掉段落的上下边距，跟着外层的字号 */
const INLINE = '[&_p]:my-0 [&_p]:text-[length:inherit] [&_p]:leading-[inherit]'

/**
 * 诊断报告最上面的决策卡（用户 2026-11-07 确认的设计稿）：状态和标签胶囊、一句话结论、要你做的、要注意。
 * 内容由 shared/bug-diagnosis-card.ts 算，这里只管样式：和请求卡一样的卡片底，左边一道主题色竖线
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
