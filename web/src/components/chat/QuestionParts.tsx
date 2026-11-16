// 提问弹窗里的问题区和选项行（方案 A，用户 2026-11-16 选定）：一句话问题做标题、一两句背景、证据折叠；
// 每个选项带「选了会怎样」和 ✓/✕ 对照。拆分规则在 shared/tasks/ask-layout.ts
import { useState } from 'react'
import { Check, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { askLayout, optionLayout } from '@shared/tasks/ask-layout'
import { Markdown } from '@/components/tasks/Markdown'

/** 问题：标题、背景、可展开的细节；长了在框里滚，选项和底部按钮始终留着 */
export function QuestionHead({ text, teamNames }: { text: string; teamNames: Set<string> }) {
  const { title, context, details } = askLayout(text)
  const [open, setOpen] = useState(false)
  return (
    <div className="flex max-h-[min(50vh,460px)] flex-col gap-1.5 overflow-y-auto px-0.5">
      {/* .chat-md 自己定字号和颜色、压过工具类：在外层改它读的变量（15px 粗体标题、13px 灰色背景） */}
      <div className="font-semibold [--md-body-size:1.0714] [text-wrap:balance]">
        <Markdown text={title} teamNames={teamNames} compact />
      </div>
      {context && (
        <div className="[--md-body-color:var(--muted)] [--md-body-size:0.9286]">
          <Markdown text={context} teamNames={teamNames} compact />
        </div>
      )}
      {details && (
        <div className="text-footnote text-muted">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex cursor-pointer items-center gap-1 text-subtle transition-colors hover:text-fg"
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
            {t('细节')}
          </button>
          {open && (
            <div className="mt-1 pl-4 [--md-body-color:var(--muted)] [--md-body-size:0.8571]">
              <Markdown text={details} teamNames={teamNames} compact />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 一个选项：圆点、名字和推荐、结果、对照；悬停才露出数字键 */
export function OptionRow({
  label,
  description,
  rec,
  on,
  multi,
  n,
  onPick,
}: {
  label: string
  description?: string
  rec: boolean
  on: boolean
  multi?: boolean
  n: number
  onPick: () => void
}) {
  const { name, effect, checks } = optionLayout(label, description)
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className={cn(
        'group/opt flex min-h-[1.875rem] w-full cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-ask-sel',
        on && 'bg-ask-sel',
      )}
    >
      <span className="flex h-[1.375rem] items-center">
        <Mark on={on} multi={multi} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('flex flex-wrap items-center gap-x-1.5 text-prose', on && 'font-medium')}>
          <span className="min-w-0">{name}</span>
          {rec && (
            <span className="shrink-0 rounded-full bg-success/12 px-1.5 text-caption leading-4 font-medium text-success">
              {t('推荐')}
            </span>
          )}
        </span>
        {effect && <span className="text-footnote leading-snug text-subtle">{effect}</span>}
        {checks.length > 0 && (
          <span className="flex flex-wrap gap-1 pt-0.5">
            {checks.map((c, i) => (
              <span
                key={i}
                className={cn(
                  'flex items-center gap-0.5 rounded-[4px] px-1 text-caption leading-4',
                  c.ok ? 'bg-success/10 text-success' : 'bg-warning/12 text-warning',
                )}
              >
                {c.ok ? (
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                ) : (
                  <X className="h-2.5 w-2.5" strokeWidth={3} />
                )}
                {c.text}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="flex h-[1.375rem] items-center">
        <Num n={n} />
      </span>
    </button>
  )
}

/** 选项前面的单选圆点（多选是方框）：选中时实心描边，和组件库「提问」一致 */
export function Mark({ on, multi }: { on: boolean; multi?: boolean }) {
  if (multi)
    return (
      <span
        className={cn(
          'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] transition-colors',
          on ? 'bg-warning text-card' : 'shadow-[inset_0_0_0_1.5px_var(--line-strong)]',
        )}
      >
        {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
    )
  // 单选（设计稿）：14px 圆圈，选中是琥珀色细圈 + 中间实心圆点
  return (
    <span
      className={cn(
        'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full transition-shadow',
        on ? 'shadow-[inset_0_0_0_1.5px_var(--warning)]' : 'shadow-[inset_0_0_0_1.5px_var(--line-strong)]',
      )}
    >
      {on && <span className="h-[7px] w-[7px] rounded-full bg-warning" />}
    </span>
  )
}

/** 选项行尾的数字键：按这个数字直接选它 */
export function Num({ n }: { n: number }) {
  // 平时不占眼（设计稿的选项行只有圆点和名字），悬停这一行才显出可以按的数字键
  return (
    <span
      aria-hidden
      className="grid h-4 min-w-4 shrink-0 place-items-center rounded-[4px] bg-sel/70 px-1 font-mono text-micro text-subtle tabular-nums opacity-0 transition-opacity group-hover/opt:opacity-100"
    >
      {n}
    </span>
  )
}
