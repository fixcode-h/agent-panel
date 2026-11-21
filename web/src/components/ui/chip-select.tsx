/**
 * 输入框里的小下拉（从 ChatModelPicker 拆出来，「发给…」也用它）：按钮上只显示选中项，展开是分组的列表
 */
import type { ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'

export type ChipOpt = { value: string; label: string; group?: string }

/** 输入框里的小下拉：按钮上只显示选中项，展开是分组的列表 */
export function ChipSelect({
  value,
  options,
  onChange,
  title,
  className,
  dot,
  icon,
  plain,
}: {
  value: string
  options: ChipOpt[]
  onChange: (v: string) => void
  title: string
  className?: string
  /** 选项前的色块（选 CLI 时用 CLI 的颜色） */
  dot?: (value: string) => string
  /** 按钮上选中项前的图标（思考强度用大脑） */
  icon?: (value: string) => ReactNode
  /** 选项是普通文字（对话标题），不用等宽字（模型名、强度用等宽） */
  plain?: boolean
}) {
  const cur = options.find((o) => o.value === value) ?? options[0]
  // 按钮上不要「（默认）」后缀，太长；列表里还标着
  const text = (cur?.label ?? '').replace(/（默认）$| \(default\)$/, '')
  return (
    <Popover>
      <PopoverTrigger
        title={title}
        aria-label={title}
        className={cn(
          'inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-footnote text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel',
          !dot && !plain && 'font-mono',
          className,
        )}
      >
        {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: dot(cur?.value ?? '') }} />}
        {icon?.(cur?.value ?? '')}
        <span className="truncate">{text}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      {/* 列表按最长的选项自适应宽度，太长时才截断 */}
      <PopoverContent className="w-max max-w-[min(560px,calc(100vw-24px))] min-w-[220px]" align="start">
        <div className="max-h-80 overflow-y-auto">
          {options.map((o, i) => (
            <div key={o.value + i}>
              {o.group && o.group !== options[i - 1]?.group && (
                <p className="px-2.5 pt-2 pb-1 text-caption text-subtle">{o.group}</p>
              )}
              {/* 行距和设置里的下拉框一样 */}
              <PopoverClose className={cn(menuItem, 'gap-2 py-1.5')} onClick={() => onChange(o.value)}>
                {dot && <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: dot(o.value) }} />}
                <span className={cn('min-w-0 flex-1 truncate text-footnote', !dot && !plain && 'font-mono')}>
                  {o.label}
                </span>
                {o.value === value && <Check className="h-4 w-4 shrink-0 text-accent-text" />}
              </PopoverClose>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
