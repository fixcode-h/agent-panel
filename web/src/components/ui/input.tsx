import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
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
