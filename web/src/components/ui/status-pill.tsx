import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** 状态色只有这几种：运行中（青）、完成（绿）、等你（琥珀）、失败（红）、没开始（灰） */
export const STATUS_TONES = ['run', 'ok', 'wait', 'err', 'idle'] as const
export type StatusTone = (typeof STATUS_TONES)[number]

const tones: Record<StatusTone, string> = {
  run: 'bg-run-soft text-run',
  ok: 'bg-success/12 text-success',
  wait: 'bg-warning/12 text-warning',
  err: 'bg-danger/10 text-danger',
  idle: 'bg-sel text-subtle',
}

/** 转圈：和状态胶囊、页签、工具行共用一个，粗细跟着字号走 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent',
        className,
      )}
    />
  )
}

/**
 * 状态胶囊：浅底 + 深字，颜色只表达状态。
 * 图标和文字的口径（什么算运行中）由调用方从 childIcon / convState 派生，这里只管画
 */
export function StatusPill({
  tone,
  spin,
  className,
  title,
  children,
}: {
  tone: StatusTone
  /** 悬停提示（界面检查也靠它定位，例如子对话的「已解决」） */
  title?: string
  /** 运行中时前面画一个转圈 */
  spin?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-[1.375rem] shrink-0 items-center gap-1.5 rounded-full px-2 text-[0.75rem] font-medium whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {spin && <Spinner className="h-2 w-2 border-[1.5px]" />}
      {children}
    </span>
  )
}
