import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const base =
  'w-full rounded-[10px] border border-border-strong bg-bg/60 px-3 text-[13px] text-fg placeholder:text-subtle ' +
  'transition-[border-color,box-shadow] hover:border-subtle/60 ' +
  'focus:outline-none focus:border-accent focus:ring-4 focus:ring-ring/40'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(base, 'h-9', className)} {...props} />,
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(base, 'py-2.5 min-h-24 resize-y leading-relaxed', className)} {...props} />
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
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-[12px] font-medium text-fg/85">{label}</span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs leading-relaxed text-subtle">{hint}</span>
      ) : null}
    </label>
  )
}

/** 表单里的分组标题 */
export function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {desc && <p className="mt-0.5 text-xs text-subtle">{desc}</p>}
      </div>
      {children}
    </section>
  )
}
