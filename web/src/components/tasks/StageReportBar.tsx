import { useState } from 'react'
import { ClipboardCheck } from 'lucide-react'
import type { Task, TaskStep } from '@shared/schema'
import type { StageReportVersion } from '@shared/flow/stage-report'
import { stepTree } from '@shared/flow'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusPill, type StatusTone } from '@/components/ui/status-pill'
import { ConfirmReview } from './ConfirmReview'

/** 每一版的状态胶囊：和审阅弹窗里每一版的说明（ConfirmReview 的 RESULT）对得上 */
const STATE = (): Record<NonNullable<StageReportVersion['result']> | 'pending', [string, StatusTone]> => ({
  pending: [t('等你确认'), 'wait'],
  confirmed: [t('已确认'), 'ok'],
  changed: [t('改了决策，重出中'), 'idle'],
  revised: [t('已退回修改'), 'idle'],
  next: [t('已确认，接着下一轮'), 'idle'],
  auto: [t('没有新问题，自动通过'), 'ok'],
})

/** 节点（含多步节点的每一步）交过的阶段报告：一步一份，按执行顺序 */
export function stepReports(task: Pick<Task, 'steps'>, root: TaskStep) {
  return [root, ...stepTree(task, root.id)].flatMap((s) =>
    s.submitted?.reports?.length ? [{ step: s, reports: s.submitted.reports }] : [],
  )
}

/**
 * 流程图节点详情里常驻的阶段报告入口（用户 2026-11-25 要求：确认之后报告就看不到了，要一直能点开看）。
 * 一份报告一行：最新一版的结论和状态，每一版一个小按钮；点开就是审阅时那个弹窗（ConfirmReview），只看不答。
 * 吸在节点详情底部，输出再长也不会被顶出去
 */
export function StageReportBar({ task, root }: { task: Pick<Task, 'steps'>; root: TaskStep }) {
  const list = stepReports(task, root)
  const [open, setOpen] = useState<{ step: string; version: number } | null>(null)
  if (!list.length) return null
  const shown = open && list.find((x) => x.step.id === open.step)
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-2 bg-bg px-1 pt-2 pb-1">
      {list.map(({ step, reports }) => {
        const last = reports.at(-1)!
        const [label, tone] = STATE()[last.result ?? 'pending']
        return (
          <div
            key={step.id}
            data-stage-report={step.id}
            className="flex items-center gap-2.5 rounded-2xl border border-line bg-card px-4 py-2.5 shadow-card"
          >
            <ClipboardCheck className="h-4 w-4 shrink-0 text-muted" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-body font-medium">
                  {step.id === root.id ? t('阶段报告') : t('「{title}」的阶段报告', { title: step.title })}
                </span>
                <StatusPill tone={tone}>{label}</StatusPill>
              </span>
              <span className="truncate text-xs text-muted" title={last.report.summary}>
                {last.report.summary}
              </span>
            </div>
            {/* 每一版一个按钮：多轮时能直接看某一轮；只有一版时不显示，点「查看报告」就是它 */}
            {reports.length > 1 && (
              <div className="flex shrink-0 items-center gap-1 max-md:hidden">
                {reports.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setOpen({ step: step.id, version: i + 1 })}
                    title={t('看第 {n} 版', { n: i + 1 })}
                    className={cn(
                      'rounded-md px-1.5 py-0.5 text-caption text-subtle tabular-nums transition-colors hover:bg-hover hover:text-fg',
                      i === reports.length - 1 && 'font-medium text-muted',
                    )}
                  >
                    {t('第 {n} 版', { n: i + 1 })}
                  </button>
                ))}
              </div>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              onClick={() => setOpen({ step: step.id, version: reports.length })}
            >
              {t('查看报告')}
            </Button>
          </div>
        )
      })}
      {shown && (
        // 换一份或换一版重新挂载：弹窗只在打开时按 initialVersion 定停在哪一版
        <ConfirmReview
          key={`${shown.step.id}:${open.version}`}
          req={{
            id: `report:${shown.step.id}`,
            title: t('「{title}」的阶段报告', { title: shown.step.title }),
            detail: '',
            reports: shown.reports,
          }}
          open
          onOpenChange={(o) => !o && setOpen(null)}
          onAnswer={async () => {}}
          view={{
            version: open.version,
            hint: shown.reports.at(-1)?.result
              ? t('报告已经处理过了，只能查看；切版本看每一轮')
              : t('只能查看；要确认或修改，点确认卡片上的「查看结果」'),
          }}
        />
      )}
    </div>
  )
}
