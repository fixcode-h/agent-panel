import type { ReactNode } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Progress } from './progress'
import { SIDEBAR_ROW_OFF } from './sidebar'

/**
 * 侧栏底部的后台状态条（用户 2026-11-23：建文件索引时侧栏底部要看得到进度）：一行说明 + 细进度条，点一下去对应的设置。
 * 只管样子，什么时候出现由调用方定（建立中、出错时出现，就绪就不画）；以后别的后台任务（下载、扫描）也用这一个
 */
export function BackgroundStatus({
  label,
  detail,
  value,
  max,
  error,
  onClick,
  className,
}: {
  label: ReactNode
  /** 右边的小字：已读多少、百分比 */
  detail?: ReactNode
  /** 进度：value / max；不给 max 时画不定进度 */
  value?: number
  max?: number
  error?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left text-xs',
        SIDEBAR_ROW_OFF,
        className,
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        {error ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        )}
        <span className={cn('min-w-0 flex-1 truncate', error && 'text-danger')}>{label}</span>
        {detail && <span className="shrink-0 font-mono text-caption text-subtle">{detail}</span>}
      </span>
      {!error && (
        <Progress
          size="xs"
          value={value ?? 0}
          max={max || 1}
          indeterminate={!max}
          label={typeof label === 'string' ? label : ''}
        />
      )}
    </button>
  )
}
