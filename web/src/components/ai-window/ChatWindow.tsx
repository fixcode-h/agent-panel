import type { LucideIcon } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { cn } from '@/lib/utils'

/** 窗口自己的按钮照设计稿是 32px、圆角 8、灰字：比对话挂上来的工具按钮大一号，一眼分得出哪些是管窗口的 */
export const WIN_BTN = 'h-8 w-8 rounded-lg text-muted'

/**
 * 盖在页面上看一个对话的大窗口：AI 分析窗口和子任务窗口共用这一个外壳（尺寸、标题栏），
 * 两边看起来是同一种窗口，改样式只改这里。正文（嵌的对话页或只读对话流）由调用方自己放。
 */
export function ChatWindow({
  open,
  onOpenChange,
  title,
  icon: Icon,
  label,
  subject,
  danger,
  meta,
  pill,
  tools,
  actions,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 给读屏的弹窗名 */
  title: string
  /** 标题栏最左边黑底方块里的图标 */
  icon: LucideIcon
  /** 哪种窗口：「AI 分析」「子任务」 */
  label: string
  /** 看的对象，画成标签 */
  subject: string
  /** 对象标签用红色（排查报错） */
  danger?: boolean
  /** 标签后面的灰字说明（来自哪里），窄屏不显示 */
  meta?: string
  /** 右侧状态胶囊；took 是用时 */
  pill?: { tone: StatusTone; text: string; took?: string }
  /** 状态胶囊和窗口按钮之间：这个对话自己的操作 */
  tools?: React.ReactNode
  /** 最右边管窗口的按钮（最小化、关闭） */
  actions: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Modal
      open={open}
      title={title}
      size="full"
      bare
      closeOnOutside
      // 嵌的是对话页，底色跟页面一样用 bg。尺寸照设计稿 AiWindow：1440×900 下是 1300×828，
      // 四周露出背后的页面（左右各 70、上下各 36），让人知道这是盖在原页面上的窗口；高度到 960 为止，大屏上不显得空
      className="h-[min(960px,calc(100dvh-4.5rem))] max-h-none max-w-[1300px] rounded-[0.875rem] bg-bg"
      onOpenChange={onOpenChange}
    >
      {/* 窗口自己的标题栏（照设计稿 AiWindow）：哪种窗口、看的对象、来自哪里、现在的状态，管窗口的按钮也放这里 */}
      <header className="flex h-[3.25rem] shrink-0 items-center gap-2.5 border-b pr-3 pl-[1.125rem]">
        <span className="grid h-[1.625rem] w-[1.625rem] shrink-0 place-items-center rounded-lg bg-fg text-bg">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="shrink-0 text-[0.9375rem] font-semibold">{label}</span>
        <span
          title={subject}
          className={cn(
            'inline-flex h-6 max-w-[45%] min-w-0 shrink items-center rounded-md px-2.5 text-[0.75rem] font-medium',
            danger ? 'bg-danger/10 text-danger' : 'bg-sel text-muted',
          )}
        >
          <span className="truncate">{subject}</span>
        </span>
        {meta && <span className="hidden min-w-0 truncate text-[0.75rem] text-subtle md:inline">{meta}</span>}
        <span className="flex-1" />
        {pill && (
          <StatusPill tone={pill.tone} spin={pill.tone === 'run'} className="h-6 shrink-0 px-2.5">
            {pill.text}
            {pill.took && <span className="tabular-nums">· {pill.took}</span>}
          </StatusPill>
        )}
        {tools}
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      </header>
      {children}
    </Modal>
  )
}
