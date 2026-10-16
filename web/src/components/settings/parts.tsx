import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/** 设置页各栏共用的排版：一行一项、分组、只读值、可复制的文字 */

/** 设置里的一行：左边标题和说明，右边控件；窄屏或 stack 时上下排 */
export function Row({
  title,
  desc,
  children,
  stack,
}: {
  title: string
  desc?: React.ReactNode
  children: React.ReactNode
  stack?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b py-4 last:border-b-0',
        !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-8',
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-medium">{title}</span>
        {desc && <span className="text-[13px] leading-relaxed text-subtle">{desc}</span>}
      </div>
      <div className={cn('min-w-0', !stack && 'sm:w-[280px] sm:shrink-0')}>{children}</div>
    </div>
  )
}

export function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      {title && <h3 className="pt-6 pb-1 text-xs font-medium text-subtle">{title}</h3>}
      {children}
    </section>
  )
}

export function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
          .catch(() => {})
      }
      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border bg-field px-2 py-1 font-mono text-xs text-muted hover:text-fg"
      title={t('复制安装命令')}
    >
      <span className="truncate">{text}</span>
      {done ? <Check className="h-3 w-3 shrink-0 text-success" /> : <Copy className="h-3 w-3 shrink-0" />}
    </button>
  )
}

/** 只读的设置值：样子和输入框对齐，但不能改 */
export function ReadValue({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-9 items-center truncate rounded-lg border border-line bg-field/50 px-3 text-[13px] text-muted',
        mono && 'font-mono',
      )}
    >
      {children}
    </span>
  )
}
