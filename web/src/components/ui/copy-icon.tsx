import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 复制按钮里的图标：复制成功后原地交叉缩放成对勾（index.css 的 .swap），1.5 秒后由调用方换回。
 * 两个图标叠在同一格里，按钮宽度不跟着变
 */
export function CopyIcon({
  done,
  className,
  doneClassName,
}: {
  done: boolean
  className?: string
  doneClassName?: string
}) {
  return (
    <span className="swap" data-done={done || undefined} aria-hidden>
      <Copy className={className} />
      <Check className={cn(className, doneClassName ?? 'text-success')} />
    </span>
  )
}
