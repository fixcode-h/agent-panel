import { AlertTriangle, Wrench } from 'lucide-react'
import type { Task } from '@shared/schema'
import { reworkCounts } from '@shared/task-export'
import { PROBE_KINDS, probeTotal, toolFailures, toolsOutsideNodes, type ProbeFailures } from '@shared/tool-failures'
import { t } from '@shared/i18n'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu'
import { cn } from '@/lib/utils'
import { META_CHIP } from './chip'

/**
 * 探路失败的中文原文：和 shared/tool-failures.ts 的 PROBE_LABELS 是同一条文案。
 * 这里必须写成 t('…') 的字面量（scripts/i18n-check.mjs 只收字面量，t(变量) 不进英文词典），
 * 所以新增一个探路类别时要两边一起加。
 */
const PROBE_TEXT: Record<keyof ProbeFailures, string> = {
  tool: t('工具不存在'),
  path: t('路径不存在'),
  command: t('命令不存在'),
}

/** 返工按原因的说法：和 shared/task-export.ts 报告里的四个分类一一对应 */
const REWORK_TEXT = {
  review: t('验收不通过'),
  rerun: t('同一节点重跑'),
  merge: t('子对话收尾被驳回'),
  sub: t('子任务验收不通过'),
}

/**
 * 输入框下面的「工具与返工」小块：这个任务（含各节点）的工具调用总数、失败数、探路失败和返工次数。
 * 数据只来自任务记录（消息里的工具调用、节点的验收/重跑、收尾消息），这里和导出报告用同一套计数函数，
 * 界面和导出不会出现两个数。没有工具调用时不占这一行。
 */
export function ToolFailuresChip({ task }: { task: Task }) {
  const all = toolFailures(task.messages.flatMap((m) => m.tools))
  const by = reworkCounts(task)
  const reworks = by.review + by.rerun + by.merge + by.sub
  const turns = task.turns?.length ?? 0
  // 工具调用、返工、追加对话三个数字里有一个就该露出入口：
  // 纯问答任务（0 次工具调用）也有返工和轮数，不能因为没调工具就整块不显示
  if (!all.calls && !reworks && !turns) return null
  const probes = probeTotal(all.probeBy)
  // 派单维度：每个节点自己的调用数；节点外那部分（系统消息等）单独一行，否则拿总数去对节点相加会对不上
  const perNode = task.steps.map((s) => ({
    step: s,
    tools: toolFailures(task.messages.filter((m) => m.step === s.id).flatMap((m) => m.tools)),
  }))
  const rows = perNode.filter((x) => x.tools.calls)
  const outside = toolsOutsideNodes(
    all,
    perNode.map((x) => x.tools),
  )
  const reworkParts = (Object.keys(REWORK_TEXT) as (keyof typeof REWORK_TEXT)[])
    .filter((k) => by[k])
    .map((k) => `${REWORK_TEXT[k]} ${by[k]} 次`)
  return (
    <Popover>
      <PopoverTrigger
        className={cn(META_CHIP, all.failed > 0 && 'text-danger')}
        title={t('工具与返工')}
        aria-label={t('工具与返工')}
      >
        {all.failed > 0 ? <AlertTriangle className="h-3.5 w-3.5" /> : <Wrench className="h-3.5 w-3.5" />}
        {all.calls ? (
          <>
            <span className="font-mono tabular-nums">{all.calls}</span>
            {all.failed > 0 && <span className="font-mono tabular-nums">{t('失败 {n}', { n: all.failed })}</span>}
          </>
        ) : (
          <span className="font-mono tabular-nums">
            {reworks ? t('返工 {n} 次', { n: reworks }) : t('{n} 轮', { n: turns })}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-[min(420px,calc(100vw-24px))]">
        <div className="flex flex-col gap-2.5 p-2.5 text-xs text-muted">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-fg">{t('工具与返工')}</span>
            <span className="text-subtle">{t('追加要求/对话 {n} 轮', { n: turns })}</span>
          </div>
          {all.calls > 0 && (
            <div className="flex flex-col gap-1">
              <span>
                {t('工具调用 {calls} 次，失败 {failed} 次', { calls: all.calls, failed: all.failed })}
                {probes > 0 && <span className="text-danger"> · {t('其中探路失败 {n} 次', { n: probes })}</span>}
              </span>
              {probes > 0 && (
                <span className="flex flex-wrap gap-x-2 text-[0.6875rem] text-subtle">
                  {PROBE_KINDS.filter((k) => all.probeBy[k]).map((k) => (
                    <span key={k}>
                      {PROBE_TEXT[k]} {all.probeBy[k]}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
          {reworks > 0 && (
            <div className="flex flex-col gap-1 border-t pt-2">
              <span>{t('返工 {n} 次', { n: reworks })}</span>
              {reworkParts.length > 0 && (
                <span className="flex flex-wrap gap-x-2 text-[0.6875rem] text-subtle">
                  {reworkParts.map((x) => (
                    <span key={x}>{x}</span>
                  ))}
                </span>
              )}
            </div>
          )}
          {(rows.length > 0 || outside.calls > 0) && (
            <ul className="flex flex-col gap-1.5 border-t pt-2">
              <li className="text-[0.6875rem] text-subtle">{t('按节点')}</li>
              {rows.map(({ step, tools }) => (
                <li key={step.id} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg" title={step.title}>
                    {step.title}
                  </span>
                  <span className="whitespace-nowrap font-mono text-subtle tabular-nums">
                    {t('{calls} 次，失败 {failed}', { calls: tools.calls, failed: tools.failed })}
                    {probeTotal(tools.probeBy) > 0 && `（${t('探路 {n}', { n: probeTotal(tools.probeBy) })}）`}
                  </span>
                </li>
              ))}
              {outside.calls > 0 && (
                <li className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-subtle">{t('节点外')}</span>
                  <span className="whitespace-nowrap font-mono text-subtle tabular-nums">
                    {t('{calls} 次，失败 {failed}', { calls: outside.calls, failed: outside.failed })}
                  </span>
                </li>
              )}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
