// 通用的对话消息：用户的气泡、AI 回复下面的时间和操作。
// 除了工作流的节点输出，所有 AI 对话（任务对话、UI 设计）都用这一套，各自通过 actions 加自己的按钮
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Quote } from 'lucide-react'
import { CopyIcon } from '@/components/ui/copy-icon'
import { toast } from '@/lib/toast'
import { copyText as clipboardCopy } from '@/lib/copy-text'
import { quoteFrom } from '@/lib/quote'
import type { Attachment } from '@shared/schema'
import { cn } from '@/lib/utils'
import { useAiLook } from '@/lib/ai-look'
import { getLang, t } from '@shared/i18n'
import { copyText } from '@shared/composer'
import { MessageBody } from './AttachmentView'
import { IconButton } from '@/components/ui/icon-button'

/** 时间格式化器按语言、选项复用：每次渲染都新建 Intl 实例很贵（消息多时一次推送要格式化几十条） */
const formats = new Map<string, Intl.DateTimeFormat>()
function fmt(loc: string, opts: Intl.DateTimeFormatOptions) {
  const key = `${loc}|${Object.entries(opts)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(loc, opts)
    formats.set(key, f)
  }
  return f
}

/** 消息时间：今天只写时分，今年写月日，更早的带上年份；悬停看完整时间 */
export function formatAt(at: string) {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return { short: '', full: '' }
  const loc = getLang() === 'en' ? 'en-US' : 'zh-CN'
  const now = new Date()
  const time = fmt(loc, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  const short =
    d.toDateString() === now.toDateString()
      ? time
      : d.getFullYear() === now.getFullYear()
        ? `${fmt(loc, { month: 'short', day: 'numeric' }).format(d)} ${time}`
        : `${fmt(loc, {}).format(d)} ${time}`
  return {
    short,
    full: fmt(loc, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d),
  }
}

/**
 * 消息操作按钮的样子（和 IconButton size="sm" 一致）：本文件已改用 IconButton，
 * 留着给还在手写按钮的调用方（设计页的对话）
 */
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
    <IconButton
      size="sm"
      className={className}
      label={label ?? t('复制')}
      title={done ? t('已复制') : (label ?? t('复制'))}
      onClick={() => {
        void clipboardCopy(attachments ? copyText(text, attachments) : text, { fail: false }).then((ok) => {
          if (!ok) return
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      <CopyIcon done={done} className="h-4 w-4" />
    </IconButton>
  )
}

/** 引用：把这段内容作为引用块放进当前对话的输入框 */
export function QuoteButton({ text }: { text: string }) {
  return (
    <IconButton
      size="sm"
      icon={Quote}
      label={t('引用')}
      title={t('引用到输入框')}
      onClick={(e) => {
        if (!quoteFrom(e.currentTarget, text)) toast(t('这里没有可以引用到的输入框'))
      }}
    />
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
        'flex items-center gap-0.5 text-caption text-subtle transition-opacity',
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
  /** 这条消息在对话里对应的消息 id：搜索结果跳过来时按它定位（见 web/src/lib/message-anchor.ts） */
  anchorId,
  size = 'md',
  subject,
}: {
  text: string
  at?: string
  attachments?: Attachment[]
  /** 气泡里文字下面的内容（例如 UI 设计的标注） */
  extra?: React.ReactNode
  actions?: React.ReactNode
  anchorId?: string
  size?: 'sm' | 'md'
  /**
   * 不是用户打的、是面板替他拼好的第一句话（AI 分析把报错、记录交给分析对话）：
   * 照设计稿 AiWindow 画成整行宽的「分析对象」卡片，标题条写明是什么、怎么来的，不冒充用户的气泡
   */
  subject?: { label: string; hint?: string }
}) {
  const ai = useAiLook()
  if (subject)
    return (
      <div data-msg={anchorId} data-user="" className="group/msg overflow-hidden rounded-xl border">
        <div className="flex h-[2.125rem] items-center gap-2 bg-sel/60 pr-1.5 pl-3 text-footnote">
          <span className="text-caption font-semibold tracking-[0.06em] text-subtle">{subject.label}</span>
          {subject.hint && <span className="min-w-0 truncate text-muted">{subject.hint}</span>}
          <span className="ml-auto" />
          <MessageMeta text={text} at={at} attachments={attachments ?? []} actions={actions} />
        </div>
        <div className="bg-panel px-3 py-2.5 text-body leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
          <FoldBody>
            <MessageBody text={text} attachments={attachments} />
          </FoldBody>
          {extra}
        </div>
      </div>
    )
  return (
    // data-user：界面检查要区分用户的消息和 Agent 的回复（两者都有 data-msg）
    <div
      data-msg={anchorId}
      data-user=""
      className={cn('group/msg ml-auto flex flex-col items-end gap-1.5', ai ? 'max-w-[80%]' : 'max-w-[85%]')}
    >
      {(text || extra || !!attachments?.length) && (
        <div
          className={cn(
            'max-w-full min-w-0 rounded-2xl bg-sel whitespace-pre-wrap [overflow-wrap:anywhere]',
            size === 'sm'
              ? 'rounded-br-md px-3.5 py-2 text-body leading-relaxed'
              : ai
                ? // AI 分析窗口的追问气泡（设计稿 AiWindow）：浅一档的底、圆角 12、14px 字
                  'rounded-xl bg-sel/70 px-3.5 py-2.5 text-prose leading-relaxed'
                : 'px-4 py-2.5 text-heading leading-relaxed',
          )}
        >
          <FoldBody>
            <MessageBody text={text} attachments={attachments} />
          </FoldBody>
          {extra}
        </div>
      )}
      <MessageMeta text={text} at={at} attachments={attachments ?? []} actions={actions} align="end" />
    </div>
  )
}

/** 超过这么多行才折叠，折起来留 FOLD_SHOW 行；中间留几行余量，免得只藏一两行还要点开 */
const FOLD_OVER = 18
const FOLD_SHOW = 15

/**
 * 很长的用户消息（贴了大段需求、日志）折起来，只留前面十几行，底下渐隐加一个展开按钮。
 * 按实际显示的行数算（长行折行也算），所以量的是高度，不数换行符
 */
function FoldBody({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const line = parseFloat(getComputedStyle(el).lineHeight) || 24
      setLong(el.scrollHeight > line * FOLD_OVER)
    }
    measure()
    // 气泡宽度跟着窗口、侧栏变，折行数也跟着变
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const folded = long && !open
  return (
    <>
      <div
        ref={ref}
        className={cn(folded && 'overflow-hidden [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]')}
        style={folded ? { maxHeight: `${FOLD_SHOW}lh` } : undefined}
      >
        {children}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 inline-flex cursor-pointer items-center gap-1 text-footnote text-muted transition-colors hover:text-fg"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          {open ? t('收起') : t('展开')}
        </button>
      )}
    </>
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
      {/* 复制图标和缩进的回复正文（32px）对齐：减去按钮自己的内边距 6px */}
      <div className="pl-[26px]">
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
            ? 'rounded-br-md px-3.5 py-2 text-body leading-relaxed'
            : 'px-4 py-2.5 text-heading leading-relaxed',
        )}
      >
        {answers.map((a, i) => (
          <div key={i} className="flex min-w-0 flex-col">
            <span className={cn('text-muted', size === 'sm' ? 'text-caption' : 'text-footnote')}>{a.question}</span>
            <span className="whitespace-pre-wrap">{a.answer}</span>
          </div>
        ))}
      </div>
      <MessageMeta text={answers.map((a) => `${a.question}\n${a.answer}`).join('\n\n')} at={at} align="end" />
    </div>
  )
}
