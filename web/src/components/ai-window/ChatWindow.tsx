import type { LucideIcon } from 'lucide-react'
import { MODAL_ICON_BTN, Modal, ModalHeader } from '@/components/ui/modal'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { cn } from '@/lib/utils'

/**
 * 窗口自己的按钮（IconButton size="sm" 上叠的样式）：和所有弹窗标题栏一样是 24px、16px 图标、前景灰，
 * 见 components/ui/modal.tsx 的 MODAL_BTN
 */
export const WIN_BTN = MODAL_ICON_BTN

/**
 * 盖在页面上看一个对话的大窗口：AI 分析窗口和子任务窗口共用这一个外壳，
 * 标题栏和所有弹窗一样用 ModalHeader（照 Claude Code 网页版的方案弹窗）。正文（嵌的对话页或只读对话流）由调用方自己放。
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
  /** 标题栏最左边的小图标 */
  icon: LucideIcon
  /** 哪种窗口：「AI 分析」「子任务」 */
  label: string
  /** 看的对象，标题后面的灰字 */
  subject: string
  /** 对象和图标用红色（排查报错） */
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
    <Modal open={open} title={null} size="full" bare closeOnOutside onOpenChange={onOpenChange}>
      {/* 标题栏：哪种窗口、看的对象（灰字，排查报错是红字）、来自哪里、现在的状态，管窗口的按钮在最右 */}
      <ModalHeader
        icon={Icon}
        iconClass={danger ? 'text-danger' : undefined}
        title={title}
        titleClass="sr-only"
        close={false}
        actions={actions}
        aside={
          <>
            {pill && (
              <StatusPill tone={pill.tone} spin={pill.tone === 'run'} className="h-5 shrink-0 px-2">
                {pill.text}
                {pill.took && <span className="tabular-nums">· {pill.took}</span>}
              </StatusPill>
            )}
            {tools}
          </>
        }
      >
        <span aria-hidden className="shrink-0 text-body font-medium text-fg">
          {label}
        </span>
        <span
          aria-hidden
          title={subject}
          className={cn('min-w-0 shrink truncate text-body', danger ? 'text-danger' : 'text-muted')}
        >
          {subject}
        </span>
        {meta && <span className="hidden min-w-0 shrink-[2] truncate text-footnote text-subtle md:inline">{meta}</span>}
      </ModalHeader>
      {children}
    </Modal>
  )
}
