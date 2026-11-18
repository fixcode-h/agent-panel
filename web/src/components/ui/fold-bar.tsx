import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 条里自带的按钮、链接、分段切换：点它们做自己的事，不顺带展开收起 */
const OWN_CONTROL = 'button, a, input, select, textarea, [role="radio"], [role="menuitem"], [role="switch"]'

/**
 * 折叠条：一整行都能点，点了展开 / 收起（用户 2026-11-18：参考「已完成 5 个阶段 … 展开 5 阶段」那种条，点整条都行，不只是箭头）。
 * 左边箭头（展开时转 90°），中间写这一段是什么，右边可以放按钮（点按钮不会顺带展开），最右写「展开 / 收起」。
 * 外观在设置 → 组件 →「折叠条」里调（圆角、底色、边框、右边的字）；bare 时不画自己的外框，
 * 由外面的卡片管（改动卡片折起来的那一行就是卡片的标题行）。
 * 不用 <button> 包整行：条里还有按钮，按钮不能套按钮，所以是 role="button" 的 div，回车 / 空格也能切换
 */
export function FoldBar({
  open,
  onToggle,
  children,
  actions,
  hint,
  bare,
  title,
  className,
  ...data
}: {
  open: boolean
  onToggle: () => void
  /** 中间的内容：这一段做了什么、增删行数 */
  children: ReactNode
  /** 右边的按钮：点它们不会展开收起 */
  actions?: ReactNode
  /** 最右的字，默认「展开 / 收起」；传 false 不写 */
  hint?: ReactNode | false
  /** 不画自己的外框（圆角、底色、边框），由外面的卡片管 */
  bare?: boolean
  title?: string
  className?: string
  [k: `data-${string}`]: string | undefined
}) {
  const click = (e: MouseEvent<HTMLDivElement>) => {
    const own = (e.target as Element).closest(OWN_CONTROL)
    if (own && own !== e.currentTarget && e.currentTarget.contains(own)) return
    // 拖选文字（复制条上的文件名）时不算点击
    if (window.getSelection()?.toString()) return
    onToggle()
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    onToggle()
  }
  return (
    <div
      {...data}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={title}
      onClick={click}
      onKeyDown={key}
      className={cn(
        'group/fold flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-left',
        !bare &&
          'min-h-7 rounded-(--c-foldBar-radius) border-(length:--c-foldBar-border) bg-(--c-foldBar-bg) px-1.5 py-0.5 text-xs text-subtle transition-colors hover:bg-sel hover:text-muted',
        className,
      )}
    >
      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {actions}
      {hint !== false && (
        <span className="shrink-0 pl-1 text-xs text-subtle group-hover/fold:text-muted [display:var(--c-foldBar-hint)]">
          {hint ?? (open ? t('收起') : t('展开'))}
        </span>
      )}
    </div>
  )
}
