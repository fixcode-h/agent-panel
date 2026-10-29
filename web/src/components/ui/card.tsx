import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const paddings = {
  none: '',
  xs: 'p-1.5',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
}

/**
 * 卡片：卡片底 + 大圆角 + 很淡的投影（浅色下）；不描边，和页面靠底色分开。
 * interactive：整张可点（列表里的角色、工作流卡片），悬停底色加深一点，键盘聚焦有焦点圈；
 * 要真正可点还得调用方给 onClick，并在 as="button" 或 role / tabIndex 里选一种
 */
export const Card = forwardRef<
  HTMLElement,
  HTMLAttributes<HTMLElement> & {
    as?: 'div' | 'section' | 'article' | 'li' | 'ul' | 'pre' | 'button'
    padding?: keyof typeof paddings
    interactive?: boolean
  }
>(({ as: Tag = 'div', padding = 'none', interactive, className, ...props }, ref) => (
  <Tag
    // 不同标签的 ref 类型不一样，这里统一按 HTMLElement 收
    ref={ref as never}
    {...(Tag === 'button' ? { type: 'button' as const } : {})}
    className={cn(
      'rounded-xl bg-card shadow-card',
      paddings[padding],
      interactive &&
        'cursor-pointer text-left transition-colors outline-none hover:bg-sel/45 focus-visible:ring-[3px] focus-visible:ring-focus-soft',
      className,
    )}
    {...props}
  />
))
Card.displayName = 'Card'
