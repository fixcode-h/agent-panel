import { forwardRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import * as S from '@radix-ui/react-select'
import * as P from '@radix-ui/react-popover'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

export const fieldClass =
  'w-full rounded-lg border border-line-strong bg-field px-3 text-sm text-fg placeholder:text-subtle ' +
  'outline-none transition-[border-color,box-shadow] focus:border-focus focus:ring-[3px] focus:ring-focus-soft'

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

const EMPTY = '__empty__'
const enc = (v: string) => (v === '' ? EMPTY : v)
const dec = (v: string) => (v === EMPTY ? '' : v)

const listPanel =
  'z-50 max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] ' +
  'overflow-hidden rounded-xl border border-line-strong bg-card shadow-pop animate-[fade-in_120ms_ease-out]'
export const listItem =
  'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-lg py-1 pr-8 pl-2.5 text-left text-[13px] leading-5 ' +
  'outline-none data-[highlighted]:bg-sel data-[state=checked]:text-fg data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

/** 下拉框：样式和输入框一致，弹出的列表也跟随主题（不用系统原生列表） */
export function Select({
  options,
  className,
  value,
  onChange,
  disabled,
  id,
  placeholder,
  'aria-label': ariaLabel,
}: {
  /** 没选时显示的提示 */
  placeholder?: string
  /** 带 group 的选项按组显示 */
  options: { value: string; label: string; group?: string }[]
  value: string
  onChange: (e: { target: { value: string } }) => void
  className?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
}) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))]
  const current = options.find((o) => o.value === value)
  return (
    <S.Root value={enc(value)} onValueChange={(v) => onChange({ target: { value: dec(v) } })} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          fieldClass,
          'flex h-9 cursor-pointer items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60 data-[state=open]:border-accent data-[state=open]:ring-[3px] data-[state=open]:ring-accent-soft',
          className,
        )}
      >
        <span className={cn('min-w-0 truncate', !current && 'text-subtle')}>
          {current?.label ?? (value || placeholder)}
        </span>
        <S.Icon>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={6} className={listPanel}>
          <S.ScrollUpButton className="grid h-5 place-items-center text-subtle">
            <ChevronUp className="h-3.5 w-3.5" />
          </S.ScrollUpButton>
          <S.Viewport className="p-0.5">
            {groups.map((g, i) => (
              <S.Group key={g || '_'}>
                {g && (
                  <>
                    {i > 0 && <S.Separator className="mx-1 my-1 h-px bg-line" />}
                    <S.Label className="px-2.5 pt-1.5 pb-1 text-[11px] text-subtle">{g}</S.Label>
                  </>
                )}
                {options
                  .filter((o) => (o.group ?? '') === g)
                  .map((o) => (
                    <S.Item key={o.value} value={enc(o.value)} className={listItem}>
                      <S.ItemText>{o.label}</S.ItemText>
                      <S.ItemIndicator className="absolute right-2.5">
                        <Check className="h-3.5 w-3.5 text-accent" />
                      </S.ItemIndicator>
                    </S.Item>
                  ))}
              </S.Group>
            ))}
          </S.Viewport>
          <S.ScrollDownButton className="grid h-5 place-items-center text-subtle">
            <ChevronDown className="h-3.5 w-3.5" />
          </S.ScrollDownButton>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}

/** 可以自由填写、也能从建议里选的输入框（替代原生 datalist） */
export function ComboInput({
  value,
  onChange,
  suggestions,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: string
  onChange: (v: string) => void
  /** 带 group 的建议按组显示 */
  suggestions: { value: string; label?: string; group?: string }[]
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState(false)
  const [hi, setHi] = useState(-1)
  const q = value.trim().toLowerCase()
  const list =
    typed && q
      ? suggestions.filter((s) => s.value.toLowerCase().includes(q) || s.label?.toLowerCase().includes(q))
      : suggestions
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
  }
  return (
    <P.Root open={open && list.length > 0} onOpenChange={setOpen}>
      <P.Anchor asChild>
        <div className="relative">
          <input
            {...props}
            value={value}
            role="combobox"
            aria-expanded={open}
            autoComplete="off"
            className={cn(fieldClass, 'h-10 pr-8', className)}
            onFocus={() => {
              setTyped(false)
              setOpen(true)
            }}
            onClick={() => setOpen(true)}
            onChange={(e) => {
              onChange(e.target.value)
              setTyped(true)
              setHi(-1)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setOpen(true)
                const d = e.key === 'ArrowDown' ? 1 : -1
                setHi((h) => (h + d + list.length) % Math.max(1, list.length))
              } else if (e.key === 'Enter' && open && list[hi]) {
                e.preventDefault()
                pick(list[hi].value)
              } else if (e.key === 'Escape') setOpen(false)
            }}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('展开建议')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setTyped(false)
              setOpen((o) => !o)
            }}
            className="absolute inset-y-0 right-0 grid w-8 cursor-pointer place-items-center text-subtle hover:text-fg"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </P.Anchor>
      <P.Portal>
        <P.Content
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if ((e.target as HTMLElement).closest?.('[role=combobox]')) e.preventDefault()
          }}
          className="z-50 max-h-[min(320px,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-xl border border-line-strong bg-card p-1 shadow-pop animate-[fade-in_120ms_ease-out]"
        >
          <div role="listbox">
            {list.map((s, i) => [
              s.group && s.group !== list[i - 1]?.group && (
                <div
                  key={`g:${s.group}`}
                  className={cn('px-2.5 pt-1.5 pb-1 text-[11px] text-subtle', i > 0 && 'mt-1 border-t pt-2')}
                >
                  {s.group}
                </div>
              ),
              <button
                key={s.value}
                type="button"
                role="option"
                aria-selected={s.value === value}
                data-highlighted={i === hi ? '' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(s.value)}
                className={listItem}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-[12.5px]">{s.value}</span>
                  {s.label && s.label !== s.value && (
                    <span className="truncate text-[11px] text-subtle">{s.label}</span>
                  )}
                </span>
                {s.value === value && <Check className="absolute right-2.5 h-3.5 w-3.5 text-accent" />}
              </button>,
            ])}
          </div>
        </P.Content>
      </P.Portal>
    </P.Root>
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
