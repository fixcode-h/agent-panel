import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HelpTip } from './help-tip'

/** 勾选框：方块里一个对勾，后面跟文字和说明，整行都能点 */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  tip,
  disabled,
  className,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: React.ReactNode
  hint?: React.ReactNode
  /** 复杂项的说明：文字后面一个问号，鼠标移上去才显示 */
  tip?: React.ReactNode
  disabled?: boolean
  className?: string
}) {
  const box = (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'group flex cursor-pointer items-start gap-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span
        className={cn(
          'mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border transition-colors',
          checked ? 'border-accent bg-accent text-white' : 'border-line-strong bg-field group-hover:border-subtle',
        )}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[0.84375rem] text-fg">{label}</span>
        {hint && <span className="text-xs leading-relaxed text-subtle">{hint}</span>}
      </span>
    </button>
  )
  if (!tip) return box
  // 问号不能放进按钮里（按钮里不能再套可聚焦的元素），挨着放
  return (
    <span className="flex items-start gap-1.5">
      {box}
      <HelpTip className="mt-0.5">{tip}</HelpTip>
    </span>
  )
}
