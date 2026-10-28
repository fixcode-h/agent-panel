import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** 快捷键提示：等宽小字、细边框，菜单和输入框提示里共用 */
export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded border border-b-2 border-line-strong px-1 font-mono text-[0.6875rem] text-subtle',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
