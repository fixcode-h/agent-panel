import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const fieldClass =
  'w-full rounded-lg border border-line-strong bg-field px-3 text-sm text-fg placeholder:text-subtle ' +
  'outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-[3px] focus:ring-accent-soft'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(fieldClass, 'h-10', className)} {...props} />,
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldClass, 'resize-y py-2.5 leading-relaxed', className)} {...props} />
  ),
)
Textarea.displayName = 'Textarea'

const selectArrow =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")"

/** 原生下拉框，样式和输入框一致 */
export function Select({
  options,
  className,
  style,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  /** 带 group 的选项按组放进 optgroup */
  options: { value: string; label: string; group?: string }[]
}) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))]
  const opt = (o: { value: string; label: string }) => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  )
  return (
    <select
      className={cn(
        fieldClass,
        'h-9 cursor-pointer appearance-none bg-[length:14px] bg-[right_10px_center] bg-no-repeat pr-8',
        className,
      )}
      style={{ backgroundImage: selectArrow, ...style }}
      {...props}
    >
      {groups.map((g) =>
        g ? (
          <optgroup key={g} label={g}>
            {options.filter((o) => o.group === g).map(opt)}
          </optgroup>
        ) : (
          options.filter((o) => !o.group).map(opt)
        ),
      )}
    </select>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string
  hint?: React.ReactNode
  error?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-xs text-muted">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="text-xs text-subtle">{hint}</span>
      ) : null}
    </label>
  )
}

/** 表单分组：标题 + 内容，组之间用细线隔开 */
export function FormSection({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-4 border-t pt-7 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  )
}
