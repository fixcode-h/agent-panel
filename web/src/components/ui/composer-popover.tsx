import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * 输入框上方弹出的一层（/ 命令、@ 引用、计划、加载日志）：贴在输入框顶上、往上长，卡片底 + 浮层投影，不描边。
 * 父元素要是 relative（输入框外壳）。stretch：左右撑满输入框（补全列表）；不传时靠左、宽度取 width
 */
export const ComposerPopover = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    stretch?: boolean
    /** 不撑满时的宽度（CSS 值），默认最多 420px、窄屏留边 */
    width?: string
    /** 内容超高时在弹层里滚动（列表）；不传时由调用方自己安排滚动区（有头有尾的面板） */
    scroll?: boolean
  }
>(({ stretch, width = 'min(420px, calc(100% - 1.5rem))', scroll, className, style, ...props }, ref) => (
  <div
    ref={ref}
    style={stretch ? style : { width, ...style }}
    className={cn(
      'absolute bottom-full z-30 flex flex-col rounded-(--c-popover-radius) bg-(--c-popover-bg) shadow-pop anim-pop [--pop-origin:bottom_left]',
      stretch ? 'right-3 left-3 mb-2 p-1' : 'left-0 mb-1',
      scroll ? 'max-h-[min(20rem,60vh)] overflow-y-auto overscroll-contain' : 'overflow-hidden',
      className,
    )}
    {...props}
  />
))
ComposerPopover.displayName = 'ComposerPopover'
