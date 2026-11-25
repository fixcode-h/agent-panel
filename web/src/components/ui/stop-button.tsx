import { useState } from 'react'
import { Loader2, Square } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { IconButton } from './icon-button'

/**
 * 「终止」按钮：运行区每一行在跑的东西（后台命令、编译、子任务……）行尾都用它，样子和行为只写这一处。
 *
 * - 点了马上转圈并禁用：终止要等进程树真退出（Windows 上 taskkill 补杀可能要几秒），期间重复点不再发请求；
 * - onStop 返回 false 或抛错算没停成，按钮恢复可点（错误由调用方提示）；停成了保持禁用，直到这一行随结束消失；
 * - 自己 stopPropagation：行本身点了是展开 / 打开窗口，点终止不能连带触发。
 *
 * compact：行内 20px 的图标按钮（运行区行尾）；不传是 28px；withText：带「终止」两个字的文字按钮（窗口标题栏）
 */
export function StopButton({
  onStop,
  label,
  tip,
  compact,
  withText,
  className,
}: {
  onStop: () => Promise<boolean | void> | boolean | void
  /** 读屏名，例如「终止后台命令」 */
  label: string
  /** 悬停提示：写清终止后会怎样（交回给对话的是什么） */
  tip?: string
  compact?: boolean
  withText?: boolean
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  const click = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (busy) return
    setBusy(true)
    let ok: boolean | void = false
    try {
      ok = await onStop()
    } catch {
      ok = false
    }
    // 停成了不恢复：这一行马上会因为结束而消失，恢复成可点的话中间那一两秒能再点一次
    if (ok === false) setBusy(false)
  }
  const spin = <Loader2 className={cn('animate-spin', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
  if (withText)
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        aria-label={label}
        title={tip ?? label}
        onClick={click}
        className={cn('shrink-0 text-subtle hover:text-danger', className)}
      >
        {busy ? spin : <Square className="h-3 w-3 fill-current" />}
        {busy ? t('正在终止') : t('终止')}
      </Button>
    )
  return (
    <IconButton
      size={compact ? '2xs' : 'sm'}
      tone="danger"
      label={label}
      title={tip ?? label}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={click}
      className={className}
    >
      {/* 实心方块（媒体「停止」）：空心方块放在行尾像个复选框 */}
      {busy ? spin : <Square className={cn('fill-current', compact ? 'h-2.5 w-2.5' : 'h-3 w-3')} />}
    </IconButton>
  )
}
