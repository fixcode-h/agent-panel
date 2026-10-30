import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** 空态的上下留白：各处历史尺寸不同，按档位取，默认 lg（px-4 py-8） */
const PADDING = {
  sm: 'px-4 py-5',
  md: 'px-4 py-6',
  lg: 'px-4 py-8',
  xl: 'px-4 py-10',
  square: 'p-6',
} as const

export type EmptyPanelSize = keyof typeof PADDING

/**
 * 空态：虚线框里一句说明，需要时把按钮一起放进 children。
 * 边框、字号、字色只在这里定义，各处只挑留白档位；个别差异（行高、hover、窄一点的左右留白）用 className 补。
 */
export function EmptyPanel({
  size = 'lg',
  as = 'p',
  onClick,
  className,
  children,
}: {
  size?: EmptyPanelSize
  /** 渲染成哪个元素：说明用 p，里面还有按钮用 div，整块可点用 button */
  as?: 'p' | 'div' | 'button'
  /** as="button" 时的点击 */
  onClick?: () => void
  className?: string
  children: ReactNode
}) {
  const cls = cn(
    'rounded-(--c-empty-radius) border border-(--c-empty-border) bg-(--c-empty-bg) text-center text-[0.8125rem] text-subtle',
    PADDING[size],
    className,
  )
  if (as === 'button')
    return (
      <button type="button" className={cls} onClick={onClick}>
        {children}
      </button>
    )
  if (as === 'div') return <div className={cls}>{children}</div>
  return <p className={cls}>{children}</p>
}
