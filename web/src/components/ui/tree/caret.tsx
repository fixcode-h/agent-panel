import { cn } from '@/lib/utils'

/** 树和折叠行前面的小三角：展开时转 90 度（UE 插件的同款 2026-11-23 收回面板，开放给插件） */
export function Caret({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 10 10"
      aria-hidden
      className={cn(
        'h-2.5 w-2.5 shrink-0 fill-current transition-transform duration-150',
        open && 'rotate-90',
        className,
      )}
    >
      <path d="M3 1.5 L7.5 5 L3 8.5 Z" />
    </svg>
  )
}
