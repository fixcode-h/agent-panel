import { useState, type ReactNode } from 'react'
import { ChevronRight, CircleAlert } from 'lucide-react'
import type { Audience, CatalogParam, ToolEffect } from '@shared/mcp-catalog/types'
import { AUDIENCES } from '@shared/mcp-catalog/types'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Collapse } from '@/components/ui/collapse'

/**
 * 能力行（设置 →「MCP」）：一个 MCP 工具或面板动作。第一行显示名、原名、徽标；下面一句作用、「该用 / 别用」；
 * 点开看交给 Agent 的原文和参数。留白、圆角、显不显示「该用 / 别用」和原名在设置 → 组件里调（--c-capRow-*）。
 */

const EFFECT_TONE: Record<ToolEffect, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  read: 'neutral',
  edit: 'accent',
  verify: 'success',
  dispatch: 'neutral',
  ask: 'warning',
  confirm: 'warning',
  danger: 'danger',
}
export const effectLabel = (e: ToolEffect) =>
  ({
    read: t('只读'),
    edit: t('会改东西'),
    verify: t('验证'),
    dispatch: t('派出去做'),
    ask: t('等你回答'),
    confirm: t('会请你确认'),
    danger: t('不可撤回'),
  })[e]

/** 工具对外界做什么的徽标 */
export function EffectBadge({ effect }: { effect: ToolEffect }) {
  return <Badge tone={EFFECT_TONE[effect]}>{effectLabel(effect)}</Badge>
}

export const audienceLabel = (a: Audience) =>
  ({ parent: t('父对话'), child: t('子对话'), helper: t('子任务'), node: t('工作流节点'), chat: 'Chat' })[a]

/** 给谁：五类对话，给的高亮，不给的淡掉划线 */
export function AudienceChips({ on, className }: { on: Audience[]; className?: string }) {
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {AUDIENCES.map((a) => (
        <span
          key={a}
          className={cn(
            'rounded-(--c-badge-radius) px-1.5 py-px text-caption whitespace-nowrap',
            on.includes(a) ? 'bg-accent-soft text-accent-text' : 'text-subtle/60 line-through decoration-subtle/40',
          )}
        >
          {audienceLabel(a)}
        </span>
      ))}
    </span>
  )
}

export interface CapabilityRowProps {
  title: string
  /** 交给 CLI 的原名（工具名、动作名） */
  name: string
  summary?: string
  useWhen?: string
  avoidWhen?: string
  effects: ToolEffect[]
  /** 额外的小标签（收进 more_tools） */
  tags?: string[]
  /** 面板工具：可能拿到它的对话类型 */
  audience?: Audience[]
  /** 交给 Agent 的说明原文 */
  description: string
  params?: CatalogParam[]
  /** 没写使用时机：第三行换成琥珀色提示 */
  missing?: boolean
  defaultOpen?: boolean
}

export function CapabilityRow(p: CapabilityRowProps) {
  const [open, setOpen] = useState(!!p.defaultOpen)
  const canOpen = !!p.description || !!p.params?.length
  return (
    <li className="rounded-(--c-capRow-radius) px-3 py-(--c-capRow-pad) transition-colors hover:bg-hover/60">
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        aria-expanded={canOpen ? open : undefined}
        onClick={() => canOpen && setOpen(!open)}
      >
        <ChevronRight
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0 text-subtle transition-transform',
            open && 'rotate-90',
            !canOpen && 'invisible',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-body font-medium">{p.title}</span>
            {p.name !== p.title && (
              <code className="[display:var(--c-capRow-name)] font-mono text-caption text-subtle">{p.name}</code>
            )}
            {p.effects.map((e) => (
              <EffectBadge key={e} effect={e} />
            ))}
            {p.tags?.map((x) => (
              <Badge key={x}>{x}</Badge>
            ))}
          </span>
          {p.summary && <span className="mt-1 block text-body text-muted">{p.summary}</span>}
          {p.missing ? (
            <span className="mt-1.5 flex items-center gap-1.5 text-caption text-warning">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />
              {t('没写「什么时候用」，Agent 只能从原文里猜')}
            </span>
          ) : (
            (p.useWhen || p.avoidWhen) && (
              <span className="mt-1.5 [display:var(--c-capRow-when)] grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-caption">
                {p.useWhen && <WhenLine label={t('该用')} tone="text-success" text={p.useWhen} />}
                {p.avoidWhen && <WhenLine label={t('别用')} tone="text-subtle" text={p.avoidWhen} />}
              </span>
            )
          )}
        </span>
        {p.audience && <AudienceChips on={p.audience} className="hidden max-w-[300px] shrink-0 pt-0.5 lg:flex" />}
      </button>
      <Collapse open={open} className="mt-3 ml-6 flex flex-col gap-3">
        {p.audience && <AudienceChips on={p.audience} className="lg:hidden" />}
        {p.description && (
          <div>
            <div className="mb-1 text-caption font-medium text-subtle">{t('交给 Agent 的原文')}</div>
            <div className="rounded-md bg-sel/50 px-3 py-2 text-caption leading-relaxed whitespace-pre-wrap text-muted">
              {p.description}
            </div>
          </div>
        )}
        {!!p.params?.length && <ParamTable params={p.params} />}
      </Collapse>
    </li>
  )
}

function WhenLine({ label, tone, text }: { label: string; tone: string; text: string }) {
  return (
    <>
      <span className={tone}>{label}</span>
      <span className="text-muted">{text}</span>
    </>
  )
}

function ParamTable({ params }: { params: CatalogParam[] }) {
  return (
    <div>
      <div className="mb-1 text-caption font-medium text-subtle">{t('参数')}</div>
      <table className="w-full text-caption">
        <tbody>
          {params.map((x) => (
            <tr key={x.name} className="border-t border-border/50 align-top first:border-t-0">
              <td className="py-1 pr-3 font-mono whitespace-nowrap">
                {x.name}
                {!x.required && <span className="text-subtle">?</span>}
              </td>
              <td className="max-w-[180px] py-1 pr-3 break-words text-subtle">{x.type}</td>
              <td className="py-1 text-muted">{x.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 一组能力行：组名 · 个数，下面一列 */
export function CapabilityGroup({ title, children, count }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1 px-3 text-caption font-medium tracking-wide text-subtle">
        {title} · {count}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  )
}
