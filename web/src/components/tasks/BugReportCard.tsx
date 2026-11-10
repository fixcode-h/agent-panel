import { useEffect } from 'react'
import { FileSearch, Loader2 } from 'lucide-react'
import type { Task } from '@shared/schema'
import type { Diagnosis } from '@shared/bug-diagnosis-schema'
import { phaseOf, revOf, roundOf } from '@shared/bug-phase'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { RowShell } from './ToolRow'
import { firstShow, showTag } from './ChildReport'
import { childLabelClass } from './child-line'
import { useDiagnosisWindow } from './diagnosis-window'

/**
 * 诊断报告在对话里的卡片（ADR 0045）：放在最新一段回复下面的运行区里，跟着消息流走。
 * 用户 2026-11-07 定：报告入口只在这里，输入框上方的状态栏不再放「诊断报告 · 查看报告」那一行；
 * 同一个 Bug 只列一张，写最新那一份（用户 2026-11-09 定：根因、修复方案各占一行像是两个 Bug），
 * 更早的几份在审阅弹窗的版本下拉里看；点了「不修了」的那份描红边，之后也不会再有新的（服务端拒交）
 */
export const MAX_REPORT_CARDS = 1

/** 运行区要列的报告卡片：用户报的 Bug 子对话才有，只取最新一份 */
export const reportCards = (task?: Pick<Task, 'bug' | 'diagnoses'>): Diagnosis[] =>
  task?.bug ? (task.diagnoses ?? []).slice(-MAX_REPORT_CARDS) : []

const PHASE = () => ({
  evidence: t('论证'),
  cause: t('根因'),
  plan: t('修复方案'),
  fix: t('修复'),
  verify: t('验证'),
})

/** 卡片上的状态标签：等你的用提醒色，不修了用红色，别的淡色 */
function statusChip(d: Diagnosis): { text: string; cls: string } {
  const verify = phaseOf(d) === 'verify'
  if (d.status === 'pending')
    return {
      text: d.awaiting ? t('等你复现') : verify ? t('等你验证') : t('等你确认'),
      cls: childLabelClass.warning,
    }
  if (d.status === 'cancelled')
    return { text: t('不修了'), cls: 'shrink-0 rounded-full bg-danger/12 px-1.5 text-caption text-danger' }
  if (d.status === 'approved')
    return {
      // 面板按「没有要注意的就自动通过」替你同意的（分析稿 B2）
      text: verify ? t('已结束验证') : d.auto ? t('自动通过') : t('已同意'),
      cls: childLabelClass.success,
    }
  if (d.status === 'questioned') return { text: t('提了意见'), cls: childLabelClass.plain }
  if (d.status === 'answered') return { text: verify ? t('给了验证结果') : t('给了日志'), cls: childLabelClass.plain }
  return { text: t('已被取代'), cls: childLabelClass.plain }
}

/** 运行区里的报告卡片：一个 Bug 一行（最新那一份） */
export function BugReportCards({ task, list }: { task: Task; list: Diagnosis[] }) {
  const { open } = useDiagnosisWindow(task)
  const last = task.diagnoses?.at(-1)
  const pending = last?.status === 'pending' ? last.version : 0
  // 交上来时自动弹一次（每一版一次，和父对话页共用记号）：交报告那一行折叠着时根本没挂上，不能只靠它弹
  useEffect(() => {
    if (pending && firstShow(task.id, pending, showTag(task))) open(task, true)
    // 同一版加好日志回到等你时（showTag 变了）再弹一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, pending, showTag(task)])
  return (
    <>
      {list.map((d) => (
        <ReportCard key={d.version} task={task} d={d} onOpen={() => open(task, false, d.version)} />
      ))}
    </>
  )
}

function ReportCard({ task, d, onOpen }: { task: Task; d: Diagnosis; onOpen: () => void }) {
  const all = task.diagnoses ?? []
  const n = revOf(d)
  const k = roundOf(d, all)
  const phase = PHASE()[phaseOf(d)]
  const waiting = d.status === 'pending'
  const cancelled = d.status === 'cancelled'
  const chip = statusChip(d)
  return (
    <RowShell
      // 不修了的那份描红边（用户 2026-11-07 要的），一眼和别的分开
      boxed={cancelled}
      className={cancelled ? 'border-danger/60' : undefined}
      glyph={
        // 对话停下了：报告还能确认，但没有人在等着往下做，不再转圈
        waiting && task.status !== 'stopped' ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
        ) : (
          <FileSearch
            className={`h-3.5 w-3.5 shrink-0 ${cancelled ? 'text-danger' : waiting ? 'text-warning' : 'text-subtle'}`}
          />
        )
      }
      verb={t('诊断报告')}
      title={k > 1 ? t('第 {n} 版 · {phase} · 第 {k} 轮', { n, phase, k }) : t('第 {n} 版 · {phase}', { n, phase })}
      titleClass="font-sans text-footnote"
      open={false}
      rowOpen={onOpen}
      onOpen={onOpen}
      openTip={t('打开诊断报告第 {n} 版', { n })}
      detailStart
      detail={<span className={chip.cls}>{chip.text}</span>}
      action={
        <Button
          size="sm"
          variant={waiting ? 'primary' : 'secondary'}
          className="h-6 shrink-0 px-2 text-xs"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
        >
          {t('查看报告')}
        </Button>
      }
    />
  )
}
