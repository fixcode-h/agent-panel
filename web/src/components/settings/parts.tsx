import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/copy-text'
import { SelectLook } from '@/components/ui/input'
import { useSectionAnchor } from './section-nav'

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
    // data-setting：设置搜索点结果时按标题找到这一行（section-nav.tsx 的 revealSetting）
    <div
      data-setting={title}
      className={cn(
        'flex flex-col gap-3 border-b border-line/80 py-4 last:border-b-0',
        !stack && 'sm:flex-row sm:items-center sm:justify-between sm:gap-8',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[0.875rem] font-medium">{title}</span>
        {desc && <span className="text-[0.8125rem] leading-relaxed text-subtle">{desc}</span>}
      </div>
      {/* 右边的下拉照 Claude 设置页：不带框、右对齐（SelectLook）；上下排时还是带框的输入框样式 */}
      <SelectLook.Provider value={stack ? 'field' : 'ghost'}>
        <div className={cn('min-w-0', !stack && 'sm:w-[280px] sm:shrink-0')}>{children}</div>
      </SelectLook.Provider>
    </div>
  )
}

/**
 * 一组设置项。在设置页里且有 title 时算本节的一个小节：右侧的小节菜单会列出它（见 section-nav），
 * 不在设置页外（没挂滚动容器）用时只是多个标题，什么都不登记。
 */
export function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  const anchor = useSectionAnchor(title)
  return (
    <section ref={anchor.ref} id={title ? anchor.id : undefined} data-setting-group={title} className="flex flex-col">
      {title && <h3 className="pt-6 pb-1.5 text-[0.75rem] font-semibold tracking-wide text-muted">{title}</h3>}
      {children}
    </section>
  )
}

export function CopyText({ text, title = t('复制安装命令') }: { text: string; title?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={() =>
        void copyText(text, { fail: false }).then((ok) => {
          if (!ok) return
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md bg-sel/60 px-2 py-1 font-mono text-xs text-muted transition-colors hover:bg-sel hover:text-fg"
      title={title}
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
        'flex h-9 items-center truncate rounded-lg border border-line bg-field/50 px-3 text-[0.8125rem] text-muted',
        mono && 'font-mono',
      )}
    >
      {children}
    </span>
  )
}
