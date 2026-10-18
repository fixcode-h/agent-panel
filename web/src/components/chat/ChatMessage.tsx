// 通用的对话消息：用户的气泡、AI 回复下面的时间和操作。
// 除了工作流的节点输出，所有 AI 对话（任务对话、UI 设计）都用这一套，各自通过 actions 加自己的按钮
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { Attachment } from '@shared/schema'
import { cn } from '@/lib/utils'
import { getLang, t } from '@shared/i18n'
import { MessageAttachments } from './Attachments'

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
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={cn(msgAction, className)}
      title={done ? t('已复制') : t('复制')}
      aria-label={t('复制')}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/** 消息下面的一行：时间和操作按钮，鼠标移到消息上才显示（always 时一直显示，例如最后一条回复） */
export function MessageMeta({
  text,
  at,
  actions,
  align = 'start',
  always,
}: {
  text: string
  at?: string
  actions?: React.ReactNode
  align?: 'start' | 'end'
  always?: boolean
}) {
  const time = at ? formatAt(at) : undefined
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 text-[11.5px] text-subtle transition-opacity',
        align === 'end' && 'flex-row-reverse',
        !always && 'opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100',
      )}
    >
      {text && <CopyButton text={text} />}
      {actions}
      {time?.short && (
        <time dateTime={at} title={time.full} className="px-1.5 tabular-nums">
          {time.short}
        </time>
      )}
    </div>
  )
}

/** 用户发的消息：附件、气泡，下面悬停显示时间、复制和各个对话自己的操作（分叉、撤回…） */
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
      {!!attachments?.length && <MessageAttachments items={attachments} />}
      {(text || extra) && (
        <div
          className={cn(
            'max-w-full min-w-0 rounded-2xl bg-sel whitespace-pre-wrap [overflow-wrap:anywhere]',
            size === 'sm'
              ? 'rounded-br-md px-3.5 py-2 text-[13px] leading-relaxed'
              : 'px-4 py-2.5 text-[14.5px] leading-relaxed',
          )}
        >
          {text}
          {extra}
        </div>
      )}
      <MessageMeta text={text} at={at} actions={actions} align="end" />
    </div>
  )
}

/** AI 回复的外层：包住回复内容，下面是时间、复制和操作 */
export function ReplyFrame({
  text,
  at,
  actions,
  always,
  children,
}: {
  text: string
  at?: string
  actions?: React.ReactNode
  /** 最后一条回复的操作一直显示 */
  always?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="group/msg flex flex-col gap-1">
      {children}
      {/* 图标和回复文字对齐：头像 26px 加间距 12px，减去按钮自己的内边距 */}
      <div className="pl-8">
        <MessageMeta text={text} at={at} actions={actions} always={always} />
      </div>
    </div>
  )
}
