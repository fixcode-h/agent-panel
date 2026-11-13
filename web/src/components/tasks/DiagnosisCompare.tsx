import { useMemo } from 'react'
import type { Diagnosis } from '@shared/bug/diagnosis-schema'
import { diagnosisMarkdown } from '@shared/bug/diagnosis-md'
import { compareReports, conclusionChanged } from '@shared/bug/diagnosis-compare'
import { labelOf, phaseOf } from '@shared/bug/phase'
import { t } from '@shared/i18n'
import { ReportCompare } from '@/components/ui/report-compare'
import { StatusPill } from '@/components/ui/status-pill'

/**
 * 诊断报告和上一份对比（用户 2026-11-13 定，设计稿「诊断报告-提问补充出新版」）：
 * 你提问、补充之后它重出一版，这里摆出结论变没变、回答了几条、改了哪几节。
 * 比较逻辑在 shared/bug/diagnosis-compare.ts，这里只拼界面
 */

/** 拿来比的上一份：同一阶段里更早的最后一份（跨阶段比没有意义，例如根因和方案） */
export function compareBase(d: Diagnosis, list: Diagnosis[]): Diagnosis | undefined {
  const i = list.indexOf(d)
  return list
    .slice(0, i < 0 ? list.length : i)
    .reverse()
    .find((x) => phaseOf(x) === phaseOf(d))
}

/** 这一份是不是按你的提问、补充、不认同重出的：前一份被你退回过（有 intent） */
export const redoneFrom = (d: Diagnosis, list: Diagnosis[]) => {
  const i = list.indexOf(d)
  const prev = i > 0 ? list[i - 1] : undefined
  return prev?.intent ? prev : undefined
}

/** 报告上方的一行：按你的提问重出，结论变没变（面板按档案字段比，不看它写的话） */
export function RedoBadge({ d, list }: { d: Diagnosis; list: Diagnosis[] }) {
  const prev = redoneFrom(d, list)
  if (!prev) return null
  const changed = conclusionChanged(prev, d)
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-footnote text-subtle" data-redo-badge>
      <span>
        {prev.intent === 'reject'
          ? t('按你的不认同重出，对比第 {v} 版', { v: labelOf(prev, list).ver })
          : t('按你的提问和补充重出，对比第 {v} 版', { v: labelOf(prev, list).ver })}
      </span>
      <StatusPill tone={changed ? 'wait' : 'ok'}>{changed ? t('结论已改') : t('结论没变')}</StatusPill>
    </div>
  )
}

export function DiagnosisCompare({
  d,
  base,
  list,
  author,
}: {
  d: Diagnosis
  base: Diagnosis
  list: Diagnosis[]
  author: boolean
}) {
  const items = useMemo(() => {
    // 两份都按「等你确认」画：状态、「要你做的」每份都不同（已被取代 / 等你确认），不算报告内容的改动
    const md = (x: Diagnosis) =>
      diagnosisMarkdown({ ...x, status: 'pending', awaiting: undefined }, list[list.indexOf(x) - 1], { author, list })
    return compareReports(md(base), md(d), [t('回答你的意见'), t('你贴的日志')])
  }, [d, base, list, author])
  const changed = conclusionChanged(base, d)
  // 回答的是紧挨着的上一份的标注（被你退回的那一份）
  const asked = redoneFrom(d, list)
  const answered = asked ? d.answers.filter((a) => asked.notes.some((n) => n.id === a.id)).length : 0
  return (
    <ReportCompare
      items={items}
      summary={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={changed ? 'wait' : 'ok'}>{changed ? t('结论已改') : t('结论没变')}</StatusPill>
            <span className="text-muted">
              {t('第 {a} 版 → 第 {b} 版', { a: labelOf(base, list).ver, b: labelOf(d, list).ver })}
            </span>
          </div>
          {asked && asked.notes.length > 0 && (
            <div className="text-muted">{t('回应了你的 {k}/{n} 条标注', { k: answered, n: asked.notes.length })}</div>
          )}
          {d.whatChanged.trim() && (
            <div className="text-muted">{t('它说改了：{text}', { text: d.whatChanged.trim() })}</div>
          )}
        </>
      }
    />
  )
}
