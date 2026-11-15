import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  finalPick,
  reportChanges,
  reportOutput,
  type Decision,
  type Picks,
  type StageReportVersion,
} from '@shared/flow/stage-report'
import { compareReports } from '@shared/bug/diagnosis-compare'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapse } from '@/components/ui/collapse'
import { ReportCompare } from '@/components/ui/report-compare'
import { StatusPill } from '@/components/ui/status-pill'
import { Markdown } from './Markdown'

/**
 * 阶段报告的正文（用户 2026-11-15 定的分区）：结论 → 需要你决定 → 我按规则定的 → 确认后接着做 → 方案详情 → 过程记录。
 * 决策一题一张卡片，选项是勾选框，Agent 选的那项预先勾上并标「推荐」；改了的卡片描边变色、标「已改」。
 * 结构和差异的算法在 shared/flow/stage-report.ts，这里只画
 */

/** 分区标题：和对话里的小节标题同一档字号，后面跟条数 */
function Head({ title, extra, children }: { title: string; extra?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mt-6 mb-2.5 flex items-center gap-2 first:mt-0">
      <h3 className="text-heading font-semibold text-fg">{title}</h3>
      {extra && <span className="text-footnote text-subtle tabular-nums">{extra}</span>}
      {children}
    </div>
  )
}

function DecisionCard({
  d,
  pick,
  onPick,
  locked,
  dense,
  teamNames,
}: {
  d: Decision
  pick: string
  onPick?: (id: string) => void
  locked: boolean
  /** 按规则自己定的：卡片收紧一档，问题背景字更小 */
  dense?: boolean
  teamNames: Set<string>
}) {
  const changed = pick !== d.pick
  return (
    <div
      data-decision={d.id}
      data-changed={changed || undefined}
      className={cn(
        'rounded-xl border bg-card transition-colors',
        dense ? 'px-3.5 py-3' : 'px-4 py-3.5',
        changed ? 'border-warning/60' : 'border-line',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-md bg-hover px-1.5 py-px text-caption font-semibold text-muted tabular-nums">
          {d.id}
        </span>
        <span className={cn('min-w-0 flex-1 font-medium text-fg', dense ? 'text-body' : 'text-prose')}>{d.title}</span>
        {changed && <StatusPill tone="wait">{t('已改')}</StatusPill>}
      </div>
      {d.question.trim() && (
        <Markdown
          compact
          text={d.question}
          teamNames={teamNames}
          className={cn('mt-1.5 text-muted', dense && 'text-footnote')}
        />
      )}
      <div role="radiogroup" aria-label={d.title} className="mt-2.5 flex flex-col gap-1">
        {d.options.map((o) => {
          const on = o.id === pick
          return (
            <div
              key={o.id}
              className={cn(
                'flex items-start gap-2 rounded-lg px-2.5 py-2 transition-colors',
                on ? 'bg-sel' : !locked && 'hover:bg-hover',
              )}
            >
              <Checkbox
                checked={on}
                disabled={locked && !on}
                // 单选：勾另一项就换过去；已勾的再点不取消（每题必须有一个选择）
                onChange={() => !locked && !on && onPick?.(o.id)}
                className={cn('min-w-0 flex-1', locked && 'cursor-default disabled:opacity-60')}
                label={
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-medium text-subtle tabular-nums">{o.id}</span>
                    <span className="text-fg">{o.label}</span>
                    {o.id === d.pick && (
                      <span className="rounded-md bg-primary/10 px-1.5 py-px text-caption font-medium text-primary">
                        {t('Agent 推荐')}
                      </span>
                    )}
                  </span>
                }
                hint={o.note || undefined}
              />
            </div>
          )
        })}
      </div>
      {d.why.trim() && (
        <p className="mt-2 border-t border-line pt-2 text-footnote leading-relaxed text-subtle">
          {t('推荐理由：{why}', { why: d.why.trim() })}
        </p>
      )}
    </div>
  )
}

/** 报告正文前面那一大块：结论、两类决策、确认后接着做什么 */
export function StageLead({
  v,
  picks,
  onPick,
  locked,
  teamNames,
}: {
  v: StageReportVersion
  picks: Picks
  onPick: (id: string, opt: string) => void
  locked: boolean
  teamNames: Set<string>
}) {
  const rep = v.report
  const ask = rep.decisions.filter((d) => !d.self)
  const own = rep.decisions.filter((d) => d.self)
  const changed = reportChanges(rep, picks)
  const n = (list: Decision[]) => changed.filter((c) => list.some((d) => d.id === c.id)).length
  const extra = (list: Decision[]) =>
    n(list) ? t('{n} 项 · 改了 {k} 项', { n: list.length, k: n(list) }) : t('{n} 项', { n: list.length })
  const card = (d: Decision, dense?: boolean) => (
    <DecisionCard
      key={d.id}
      d={d}
      pick={finalPick(d, picks)}
      onPick={(o) => onPick(d.id, o)}
      locked={locked}
      dense={dense}
      teamNames={teamNames}
    />
  )
  return (
    <div data-stage-report className="mb-2">
      <section
        data-stage-summary
        className="rounded-xl border border-line border-l-[3px] border-l-primary bg-card px-4 py-3"
      >
        <div className="mb-1 text-caption font-medium tracking-wide text-subtle">{t('结论')}</div>
        <Markdown text={rep.summary} teamNames={teamNames} className="text-fg" />
      </section>
      {ask.length > 0 && (
        <>
          <Head title={t('需要你决定')} extra={extra(ask)} />
          <div className="flex flex-col gap-2.5">{ask.map((d) => card(d))}</div>
        </>
      )}
      {own.length > 0 && (
        <>
          <Head title={t('我按规则定的')} extra={extra(own)}>
            {!locked && <span className="text-footnote text-subtle">{t('不同意也可以改')}</span>}
          </Head>
          <div className="flex flex-col gap-2">{own.map((d) => card(d, true))}</div>
        </>
      )}
      {rep.next.trim() && (
        <div data-stage-next className="mt-4 rounded-lg bg-hover px-3.5 py-2.5 text-body text-muted">
          <span className="font-medium text-fg">{t('确认后接着：')}</span>
          {rep.next.trim()}
        </div>
      )}
      {rep.details.trim() && <Head title={t('方案详情')} />}
    </div>
  )
}

/** 过程记录：Agent 边做边说的话。不是报告本身，默认收起（结论和方案都在上面，不折叠） */
export function StageProcess({ text, teamNames }: { text: string; teamNames: Set<string> }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <section data-stage-process className="mt-6 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-footnote text-subtle hover:bg-hover hover:text-fg"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        {t('过程记录')}
        <span>{t('（Agent 做这一步时说的话）')}</span>
      </button>
      <Collapse open={open} className="pt-2 text-muted">
        <Markdown compact text={text} teamNames={teamNames} />
      </Collapse>
    </section>
  )
}

/** 第几版是怎么来的：前一版被你改了决策 / 退回 / 接着下一轮 */
export function redoLabel(prev: StageReportVersion | undefined) {
  if (!prev?.result) return ''
  return {
    changed: t('按你改的决策重出'),
    revised: t('按你的修改意见重出'),
    next: t('确认上一轮后接着问'),
    confirmed: '',
  }[prev.result]
}

/** 和上一版对比：两份都按最终选择写成文档，逐节比（和诊断报告「对比上一份」同一个画法） */
export function StageCompare({
  base,
  cur,
  baseNo,
  curNo,
}: {
  base: StageReportVersion
  cur: StageReportVersion
  baseNo: number
  curNo: number
}) {
  const items = useMemo(
    () => compareReports(reportOutput(base.report, base.picks, true), reportOutput(cur.report, undefined, true)),
    [base, cur],
  )
  const changed = base.report.summary.trim() !== cur.report.summary.trim()
  return (
    <ReportCompare
      items={items}
      summary={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={changed ? 'wait' : 'ok'}>{changed ? t('结论已改') : t('结论没变')}</StatusPill>
            <span className="text-muted">{t('第 {a} 版 → 第 {b} 版', { a: baseNo, b: curNo })}</span>
          </div>
          {base.result === 'changed' && base.picks && (
            <div className="text-muted">
              {t('上一版你改了：{list}', {
                list: reportChanges(base.report, base.picks)
                  .map((c) => `${c.id} ${c.from} → ${c.to}`)
                  .join('；'),
              })}
            </div>
          )}
        </>
      }
    />
  )
}
