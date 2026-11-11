import { cn } from '@/lib/utils'

/**
 * 工具栏里的一组按钮：组和组之间一道细竖线（第一组前面不画）。
 * 表格页工具栏按「查看 / 数据 / 版本 / AI / 编辑」分组，图标多了也分得清；label 给读屏
 */
export function ToolGroup({
  label,
  first,
  className,
  children,
}: {
  label: string
  /** 第一组：前面不画竖线 */
  first?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <>
      {!first && <span aria-hidden className="tool-sep mx-1 h-4 w-px shrink-0 bg-line" />}
      <span role="group" aria-label={label} className={cn('flex shrink-0 items-center gap-0.5', className)}>
        {children}
      </span>
    </>
  )
}
