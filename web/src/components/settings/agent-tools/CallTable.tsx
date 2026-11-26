import { Fragment, useState, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { hhmm } from '@shared/datetime'
import type { CallRecord } from '@shared/tool-gateway/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  CATEGORY_LABEL,
  DECISION_LOOKS,
  KIND_LABEL,
  actualRoute,
  capabilityLabel,
  hookLabel,
  msText,
} from './call-labels'

/** 调用记录的表格：一行一次调用，点开看原调用、认成什么、守卫和补充说明来源 */
export function CallTable({ items }: { items: CallRecord[] }) {
  const [open, setOpen] = useState('')
  const th = 'px-3 py-2 text-left font-normal whitespace-nowrap'
  return (
    <div className="settings-card overflow-x-auto p-0">
      <table className="w-full text-body">
        <thead className="text-footnote text-subtle">
          <tr className="border-b">
            <th className={th}>{t('时间')}</th>
            <th className={th}>{t('对话')}</th>
            <th className={th}>{t('Agent 调的')}</th>
            <th className={th}>{t('决定')}</th>
            <th className={th}>{t('实际走的 / 会改到哪')}</th>
            <th className={cn(th, 'hidden lg:table-cell')}>{t('推的技能')}</th>
            <th className={cn(th, 'text-right')}>{t('耗时')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <Fragment key={r.id}>
              <tr
                className={cn('cursor-pointer border-b last:border-0 hover:bg-hover', open === r.id && 'bg-sel')}
                onClick={() => setOpen(open === r.id ? '' : r.id)}
              >
                <td className="px-3 py-2 font-mono text-footnote whitespace-nowrap text-subtle">
                  {hhmm(new Date(r.at))}
                </td>
                <td className="max-w-40 truncate px-3 py-2" title={r.taskTitle}>
                  {r.taskTitle || r.taskId}
                </td>
                <td className="max-w-72 truncate px-3 py-2 font-mono text-footnote" title={r.summary}>
                  {r.tool}
                  {r.summary && <span className="text-subtle"> · {r.summary}</span>}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={DECISION_LOOKS[r.decision].tone}>{DECISION_LOOKS[r.decision].label()}</Badge>
                  {r.error && (
                    <Badge tone="danger" className="ml-1">
                      {t('网关出错')}
                    </Badge>
                  )}
                </td>
                <td className="max-w-64 truncate px-3 py-2 text-footnote text-subtle">
                  {actualRoute(r)}
                  {r.wouldRoute && (
                    <span className="text-accent-text">
                      {' → '}
                      {r.wouldRoute.to}
                    </span>
                  )}
                </td>
                <td className="hidden max-w-40 truncate px-3 py-2 font-mono text-footnote text-accent-text lg:table-cell">
                  {(r.skills ?? []).map((s) => s.skill).join('、')}
                </td>
                <td className="px-3 py-2 text-right font-mono text-footnote whitespace-nowrap text-subtle">
                  {msText(r.durMs ?? r.hookMs)}
                </td>
              </tr>
              {open === r.id && (
                <tr className="border-b bg-sel/50">
                  <td colSpan={7} className="px-3 py-3">
                    <CallDetail r={r} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Line({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="w-20 shrink-0 text-subtle">{k}</span>
      <span className="min-w-0 flex-1 break-all">{children}</span>
    </div>
  )
}

/** 点开一行：原调用、认成什么、会改到哪、谁拒绝的、补充说明和技能来自哪、各段耗时 */
function CallDetail({ r }: { r: CallRecord }) {
  const what = [
    KIND_LABEL[r.kind](),
    r.category && CATEGORY_LABEL[r.category](),
    r.segments !== undefined && t('{n} 段', { n: r.segments }),
    r.capability && t('能力 {name}', { name: capabilityLabel(r.capability) }),
    r.readOnly && t('只读'),
    r.serial && t('本可以并行'),
  ].filter(Boolean)
  return (
    <div className="flex flex-col gap-1.5 text-footnote">
      <Line k={t('原调用')}>
        <span className="font-mono">
          {r.tool} · {r.input}
        </span>
      </Line>
      <Line k={t('认成')}>{what.join(' · ')}</Line>
      {r.wouldRoute && (
        <Line k={t('会改到')}>
          {t('{to}（{decision}，按 {by} 认的；观察模式没有真的改）', {
            to: r.wouldRoute.to,
            decision: DECISION_LOOKS[r.wouldRoute.decision].label(),
            by: r.wouldRoute.by,
          })}
        </Line>
      )}
      {r.denyBy && <Line k={t('拒绝')}>{hookLabel(r.denyBy)}</Line>}
      {!!r.pushes?.length && (
        <Line k={t('补充说明')}>
          {r.pushes.map((p) => t('{name} {n} 字', { name: hookLabel(p.id), n: p.chars })).join('、')}
        </Line>
      )}
      {!!r.skills?.length && (
        <Line k={t('推的技能')}>
          {r.skills.map((s) => t('{name} {n} token', { name: s.skill, n: s.tokens })).join('、')}
        </Line>
      )}
      <Line k={t('耗时')}>
        {t('网关 {g} · 工具前 {h} · 执行 {d}', {
          g: `${r.ms}ms`,
          h: msText(r.hookMs),
          d: msText(r.durMs),
        })}
        {r.failed && <span className="text-danger"> · {t('执行失败')}</span>}
      </Line>
      {r.error && <Line k={t('网关出错')}>{t('{msg}（已放行）', { msg: r.error })}</Line>}
    </div>
  )
}
