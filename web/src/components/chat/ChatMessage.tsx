// 通用的对话消息：用户的气泡、AI 回复下面的时间和操作。
// 除了工作流的节点输出，所有 AI 对话（任务对话、UI 设计）都用这一套，各自通过 actions 加自己的按钮
import { useState } from 'react'
import { Check, Copy, Quote } from 'lucide-react'
import { toast } from 'sonner'
import { quoteFrom } from '@/lib/quote'
import type { Attachment } from '@shared/schema'
import { cn } from '@/lib/utils'
import { getLang, t } from '@shared/i18n'
import { copyText } from '@shared/composer'
import { MessageBody } from './AttachmentView'

/** 消息时间：今天只写时分，今年写月日，更早的带上年份；悬停看完整时间 */
export function formatAt(at: string) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return { short: '', full: '' }
  const loc = getLang() === 'en' ? 'en-US' : 'zh-CN'
  const now = new Date()
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false })
  const short =
    d.toDateString() === now.toDateString()
      ? time
      : d.getFullYear() === now.getFullYear()
        ? `${d.toLocaleDateString(loc, { month: 'short', day: 'numeric' })} ${time}`
        : `${d.toLocaleDateString(loc)} ${time}`
  return { short, full: d.toLocaleString(loc, { hour12: false }) }
}

export const msgAction =
  'grid h-7 w-7 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-sel hover:text-fg disabled:cursor-default disabled:opacity-40'

/** 复制按钮：点了显示一下「已复制」 */
export function CopyButton({
  text,
  attachments,
  className,
  label,
}: {
  text: string
  /** 用户消息的附件：卡片换成文件路径再复制（粘贴回输入框时按路径认回卡片） */
  attachments?: Attachment[]
  className?: string
  label?: string
}) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={cn(msgAction, className)}
      title={done ? t('已复制') : (label ?? t('复制'))}
      aria-label={label ?? t('复制')}
      onClick={() => {
        void Promise.resolve(navigator.clipboard?.writeText(attachments ? copyText(text, attachments) : text)).then(
          () => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          },
        )
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/** 引用：把这段内容作为引用块放进当前对话的输入框 */
export function QuoteButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      className={msgAction}
      title={t('引用到输入框')}
      aria-label={t('引用')}
      onClick={(e) => {
        if (!quoteFrom(e.currentTarget, text)) toast(t('这里没有可以引用到的输入框'))
      }}
    >
      <Quote className="h-3.5 w-3.5" />
    </button>
  )
}

/** 消息下面的一行：时间和操作按钮，一直显示（always 保留给调用方，不再控制显隐） */
export function MessageMeta({
  text,
  at,
  attachments,
  actions,
  align = 'start',
}: {
  text: string
  at?: string
  /** 用户消息：复制、引用时卡片换成文件路径 */
  attachments?: Attachment[]
  actions?: React.ReactNode
  align?: 'start' | 'end'
  always?: boolean
}) {
  const time = at ? formatAt(at) : undefined
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 text-[0.71875rem] text-subtle transition-opacity',
        align === 'end' && 'flex-row-reverse',
      )}
    >
      {text && <CopyButton text={text} attachments={attachments} />}
      {text && <QuoteButton text={attachments ? copyText(text, attachments) : text} />}
      {actions}
      {time?.short && (
        <time dateTime={at} title={time.full} className="px-1.5 tabular-nums">
          {time.short}
        </time>
      )}
    </div>
  )
}

/**
 * 用户发的消息：和输入框里一样，图片、文件、引用都是文字里的一行高的小卡片，放在同一个气泡里，点开查看；
 * 下面是时间和各个对话自己的操作（分叉、撤回…）
 */
export function UserMessage({
  text,
  at,
  attachments,
  extra,
  actions,
  size = 'md',
}: {
  text: string
  at?: string
  attachments?: Attachment[]
  /** 气泡里文字下面的内容（例如 UI 设计的标注） */
  extra?: React.ReactNode
  actions?: React.ReactNode
  size?: 'sm' | 'md'
}) {
  return (
    <div className="group/msg ml-auto flex max-w-[85%] flex-col items-end gap-1.5">
      {(text || extra || !!attachments?.length) && (
        <div
          className={cn(
            'max-w-full min-w-0 rounded-2xl bg-sel whitespace-pre-wrap [overflow-wrap:anywhere]',
            size === 'sm'
              ? 'rounded-br-md px-3.5 py-2 text-[0.84375rem] leading-relaxed'
              : 'px-4 py-2.5 text-[0.9375rem] leading-relaxed',
          )}
        >
          <MessageBody text={text} attachments={attachments} />
          {extra}
        </div>
      )}
      <MessageMeta text={text} at={at} attachments={attachments ?? []} actions={actions} align="end" />
    </div>
  )
}

/** AI 回复的外层：包住回复内容，下面是时间、复制和操作 */
export function ReplyFrame({
  text,
  at,
  actions,
  children,
}: {
  text: string
  at?: string
  actions?: React.ReactNode
  /** 兼容调用方：操作一直显示，不再需要这个开关 */
  always?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="group/msg flex flex-col gap-1">
      {children}
      {/* 图标和回复文字对齐：头像 26px 加间距 12px，减去按钮自己的内边距 */}
      <div className="pl-8">
        <MessageMeta text={text} at={at} actions={actions} />
      </div>
    </div>
  )
}

/**
 * 用户对 AI 提问的回答：和用户消息一样的气泡放在对话正文里，每个问题一行小字、下面是答案。
 * 提问面板答完就收起了，这里留下问了什么、选了什么
 */
export function AnswerMessage({
  answers,
  at,
  size = 'md',
}: {
  answers: { question: string; answer: string }[]
  at?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div className="group/msg ml-auto flex max-w-[85%] flex-col items-end gap-1.5">
      <div
        className={cn(
          'flex max-w-full min-w-0 flex-col gap-2 rounded-2xl bg-sel [overflow-wrap:anywhere]',
          size === 'sm'
            ? 'rounded-br-md px-3.5 py-2 text-[0.84375rem] leading-relaxed'
            : 'px-4 py-2.5 text-[0.9375rem] leading-relaxed',
        )}
      >
        {answers.map((a, i) => (
          <div key={i} className="flex min-w-0 flex-col">
            <span className={cn('text-muted', size === 'sm' ? 'text-[0.71875rem]' : 'text-[0.78125rem]')}>
              {a.question}
            </span>
            <span className="whitespace-pre-wrap">{a.answer}</span>
          </div>
        ))}
      </div>
      <MessageMeta text={answers.map((a) => `${a.question}\n${a.answer}`).join('\n\n')} at={at} align="end" />
    </div>
  )
}
