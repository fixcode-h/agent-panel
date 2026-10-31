import { useState } from 'react'
import { Check, ChevronRight, Copy } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/copy-text'
import { Input, SelectLook } from '@/components/ui/input'
import { HelpTip } from '@/components/ui/help-tip'
import { useSectionAnchor } from './section-nav'

/**
 * 设置页各栏共用的排版：一行一项、分组卡片、高级折叠、带单位的数字框、只读值、可复制的文字。
 *
 * 文案的约定（用户 2026-10-31 定的改版方案）：标题 2～6 个字的名词短语，组名里有的词不重复；
 * desc 只写一行（20 字左右）说「开了会怎样」，边界情况、原理、和别的项的关系写进 hint，挂在标题旁的问号上。
 */

/**
 * 设置里的一行：左边标题和一行说明，右边控件；窄屏或 stack 时上下排。
 * 右边控件栏定宽 280px，里面的东西靠右：开关、下拉、窄数字框贴着右边，文本框占满这一栏。
 * indent：从属于上一行总开关的项，往里缩一档。
 */
export function Row({
  title,
  desc,
  hint,
  children,
  stack,
  indent,
}: {
  title: string
  desc?: React.ReactNode
  /** 详细说明：标题旁问号悬停时显示（设置搜索也搜得到） */
  hint?: React.ReactNode
  children: React.ReactNode
  stack?: boolean
  indent?: boolean
}) {
  return (
    // data-setting：设置搜索点结果时按标题找到这一行（section-nav.tsx 的 revealSetting）
    <div
      data-setting={title}
      className={cn(
        'settings-row flex flex-col gap-3 py-3.5',
        indent && 'pl-5',
        !stack && 'sm:min-h-14 sm:flex-row sm:items-center sm:justify-between sm:gap-8',
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[0.875rem] font-medium">
          {title}
          {hint && <HelpTip>{hint}</HelpTip>}
        </span>
        {desc && <span className="text-[0.8125rem] leading-relaxed text-subtle">{desc}</span>}
      </div>
      {/* 右边的下拉照 Claude 设置页：不带框、右对齐（SelectLook）；上下排时还是带框的输入框样式 */}
      <SelectLook.Provider value={stack ? 'field' : 'ghost'}>
        {/* 开关贴右边靠 index.css 的 .settings-row 规则；文本框是块级、w-full，照样占满整栏 */}
        <div className={cn('min-w-0', !stack && 'sm:w-[280px] sm:shrink-0')}>{children}</div>
      </SelectLook.Provider>
    </div>
  )
}

/**
 * 一组设置项：组名在外，内容放在一张浅底圆角卡片里，行和行之间一道细线（边界靠底色分，不描边）。
 * 在设置页里且有 title 时算本节的一个小节：右侧的小节菜单会列出它（见 section-nav），
 * 不在设置页外（没挂滚动容器）用时只是多个标题，什么都不登记。
 * plain：内容本身是大块的自定义排版（预览、列表、表格），不套卡片。
 */
export function Group({ title, children, plain }: { title?: string; children: React.ReactNode; plain?: boolean }) {
  const anchor = useSectionAnchor(title)
  return (
    <section
      ref={anchor.ref}
      id={title ? anchor.id : undefined}
      data-setting-group={title}
      className="flex flex-col pt-6 first:pt-2"
    >
      {title && <h3 className="pb-2 pl-1 text-[0.75rem] font-semibold tracking-wide text-subtle">{title}</h3>}
      {plain ? <div className="flex flex-col">{children}</div> : <div className="settings-card">{children}</div>}
    </section>
  )
}

/**
 * 组里不常改的项（路径、端口、镜像、额外参数）收进「高级」。用原生 details：
 * 设置搜索跳到里面的项时 revealSetting 会把它展开。
 */
export function Advanced({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="settings-advanced group/adv">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-3 text-[0.8125rem] text-subtle transition-colors select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open/adv:rotate-90" />
        {label ? `${t('高级')} · ${label}` : t('高级')}
      </summary>
      {children}
    </details>
  )
}

/**
 * 带单位的数字框：单位写在框里，标题和说明里就不用再解释「分钟」「天」。
 * empty：0 有特殊含义（不限、关闭）时传占位字，0 显示成空框、清空存 0；不传时照原样显示数字。
 */
export function NumberField({
  value,
  onChange,
  unit,
  empty,
  invalid,
  error,
  label,
}: {
  value: string
  onChange: (v: string) => void
  unit?: string
  empty?: string
  invalid?: boolean
  /** 不合法时框下面的一行提示 */
  error?: string
  label: string
}) {
  const shown = empty && value === '0' ? '' : value
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="relative w-32">
        <Input
          inputMode="numeric"
          value={shown}
          placeholder={empty}
          onChange={(e) => {
            const v = e.target.value.replace(/[^\d]/g, '')
            onChange(empty && v === '' ? '0' : v)
          }}
          aria-invalid={invalid}
          aria-label={label}
          className={cn(
            'text-right tabular-nums',
            unit ? 'pr-12' : 'pr-3',
            invalid && 'border-danger focus:border-danger focus:ring-danger/20',
          )}
        />
        {unit && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[0.75rem] text-subtle">
            {unit}
          </span>
        )}
      </div>
      {invalid && error && <span className="text-xs text-danger">{error}</span>}
    </div>
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
