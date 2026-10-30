import { Fragment, useState } from 'react'
import { Check, GitBranch, Pencil, Route, Split } from 'lucide-react'
import type { TaskMessage, TaskRoute } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** 分诊去向在界面上的说法和图标 */
const TARGET: Record<TaskRoute['target'], { label: string; say: string; icon: typeof Route }> = {
  child: { label: t('新开子对话'), say: '新开子对话', icon: GitBranch },
  resend: { label: t('交回子对话'), say: '交回子对话', icon: GitBranch },
  subtask: { label: t('派子任务'), say: '派子任务', icon: Split },
  'inline-edit': { label: t('就地微改动'), say: '就地微改动', icon: Pencil },
}

/** 改派的去向：说给主理的话写中文（发给 Agent 的提示不翻译），按钮文字走 t() */
type Reroute = 'inline' | 'subtask' | 'child'
const REROUTE: Record<Reroute, { label: string; say: string }> = {
  inline: { label: t('改为就地处理'), say: '就地处理（你自己回答，或者走就地微改动）' },
  subtask: { label: t('改为子任务'), say: '派子任务处理' },
  child: { label: t('改为子对话'), say: '交给子对话处理' },
}

/** 每种去向能改成什么：已经是的那种不列 */
const OPTIONS: Record<TaskRoute['target'], Reroute[]> = {
  child: ['inline', 'subtask'],
  resend: ['inline', 'child'],
  subtask: ['inline', 'child'],
  'inline-edit': ['child'],
}

/** 改派消息里带上分诊 id：界面按它认出哪张卡已经改派过 */
const rerouteTag = (id: string) => `（分诊 ${id}）`

/** 发给主理的改派消息 */
export function rerouteText(r: TaskRoute, to: Reroute) {
  const what = r.label ? `「${r.label}」` : '上一条'
  return `【改派】${what}不要${TARGET[r.target].say}，改为${REROUTE[to].say}${rerouteTag(r.id)}。已经派出去的先停掉或收回，再按新的方式处理。`
}

/**
 * 分诊卡：主理（父对话）把这条消息分到了哪里、为什么、替你做了什么假设。
 * 不同意就一键改派：发一条消息给主理，它下一轮照做（角色分层改造，见 docs/openspec/changes/role-composition-and-dispatch）
 */
export function RouteCard({
  routes,
  later,
  onReroute,
}: {
  routes: TaskRoute[]
  /** 这条用户消息之后的消息：里面有带分诊 id 的改派消息就算已改派 */
  later: TaskMessage[]
  /** 不给时只读（对话在跑、导入的对话） */
  onReroute?: (text: string) => Promise<void>
}) {
  const [busy, setBusy] = useState('')
  if (!routes.length) return null
  const rerouted = (r: TaskRoute) => later.some((m) => m.role === 'user' && m.text.includes(rerouteTag(r.id)))
  return (
    <div className="flex gap-3" data-route-card>
      <span className="grid w-[26px] shrink-0 place-items-start justify-center pt-0.5">
        <Route className="h-3.5 w-3.5 text-subtle" />
      </span>
      {/* 一次分诊可能派出好几条：每条一张卡，卡之间留空隙，不再挤在同一块底色里分不清边界 */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex h-[18px] items-center gap-1.5 text-xs text-subtle">
          {t('分诊')}
          {routes.length > 1 && <span className="tabular-nums">· {routes.length}</span>}
        </div>
        {routes.map((r) => {
          const tg = TARGET[r.target]
          const Icon = tg.icon
          const done = rerouted(r)
          const rows = [
            [t('理解'), r.understanding],
            [t('理由'), r.reason],
            [t('假设'), r.assumptions],
          ].filter(([, v]) => v)
          return (
            // 已改派的只把内容调淡，「已改派」标签保持清楚
            <div key={r.id} className="rounded-lg bg-card px-3 py-2.5 shadow-card">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <span
                  className={cn(
                    'grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-soft',
                    done && 'opacity-50',
                  )}
                >
                  <Icon className="h-3.5 w-3.5 text-accent-text" />
                </span>
                <span className={cn('flex min-w-0 flex-1 items-baseline gap-2 text-[0.8125rem]', done && 'opacity-60')}>
                  <span className="shrink-0 font-medium">{tg.label}</span>
                  {r.label && <span className="min-w-0 truncate text-muted">{r.label}</span>}
                </span>
                {done && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-sel px-1.5 py-0.5 text-[0.6875rem] text-muted">
                    <Check className="h-3 w-3" />
                    {t('已改派')}
                  </span>
                )}
                {onReroute && !done && (
                  <span className="ml-auto flex shrink-0 gap-1">
                    {OPTIONS[r.target].map((to) => (
                      <Button
                        key={to}
                        size="sm"
                        variant="secondary"
                        disabled={!!busy}
                        className="h-6 rounded-md px-2 text-xs font-normal text-muted hover:text-fg"
                        onClick={async () => {
                          setBusy(r.id)
                          try {
                            await onReroute(rerouteText(r, to))
                          } finally {
                            setBusy('')
                          }
                        }}
                      >
                        {REROUTE[to].label}
                      </Button>
                    ))}
                  </span>
                )}
              </div>
              {rows.length > 0 && (
                // 正文和标题文字左对齐（让出图标那一格），标签固定宽度，三行的正文起点对齐
                <dl
                  className={cn(
                    'mt-2 grid grid-cols-[2.25rem_1fr] gap-x-2 gap-y-1 pl-8 text-xs leading-relaxed',
                    done && 'opacity-60',
                  )}
                >
                  {rows.map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="text-subtle">{k}</dt>
                      <dd className="min-w-0 break-words text-muted">{v}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
