import { t } from './i18n.ts'
import type { EngineHost } from './engine.ts'

/**
 * 两个上限（工作流设的、计划设的）取更小的非零值：都设了时谁先到都算超。
 * 返回上限值和它是谁设的，文案要说清是哪个上限到了，用户才知道该去哪里改。
 */
export function budgetLimit(
  workflow: number | undefined,
  plan: number,
): { value: number; by: 'workflow' | 'plan' } | null {
  const w = workflow && workflow > 0 ? workflow : 0
  const p = plan && plan > 0 ? plan : 0
  if (!w && !p) return null
  if (!p) return { value: w, by: 'workflow' }
  if (!w) return { value: p, by: 'plan' }
  return w <= p ? { value: w, by: 'workflow' } : { value: p, by: 'plan' }
}

/**
 * 这一轮用掉的花费 / token / 时长超过上限时，返回暂停的说明（导出给单测验证聊天模式也走这套判定）。
 * includeWorkflow：要把工作流设的上限也算进来吗。节点执行路径传 true；
 * chat 路径传 false——工作流预算管的是「这次工作流执行」，对话里跑过一次 start_plan 之后，
 * 任务会一直带着工作流快照（host.workflow 非空），不能让那个上限转头把普通的聊天轮次也停掉。
 */
export function overBudget(host: EngineHost, includeWorkflow = true): string {
  const w = includeWorkflow ? host.workflow : undefined
  const { usage, budgetFrom, budgetTokens, budgetMinutes } = host.task
  const usd = usage.costUsd - (budgetFrom?.usd ?? 0)
  const tokens = usage.inputTokens + usage.outputTokens - (budgetFrom?.tokens ?? 0)
  if (w?.budgetUsd && usd >= w.budgetUsd)
    return t('这次执行已经花了 ${used}，达到工作流设定的上限 ${limit}，已暂停。点「继续执行」会再给一份同样的额度。', {
      used: usd.toFixed(2),
      limit: w.budgetUsd.toFixed(2),
    })
  // token：工作流和计划都设了上限时取小的那个
  const tokenLimit = budgetLimit(w?.budgetTokens, budgetTokens ?? 0)
  if (tokenLimit && tokens >= tokenLimit.value)
    return tokenLimit.by === 'workflow'
      ? t('这次执行已经用了 {used} token，达到工作流设定的上限 {limit}，已暂停。点「继续执行」会再给一份同样的额度。', {
          used: Math.round(tokens).toLocaleString(),
          limit: tokenLimit.value.toLocaleString(),
        })
      : t(
          '这次执行已经用了 {used} token，达到计划设定的上限 {limit}，已暂停。已经产出的内容都保留着，点「继续执行」会重新计。',
          { used: Math.round(tokens).toLocaleString(), limit: tokenLimit.value.toLocaleString() },
        )
  // 时长：从这一轮开始算，旧任务没有开始时刻（at）时按不限处理
  const startedAt = budgetFrom?.at
  if (budgetMinutes && startedAt) {
    const usedMinutes = (Date.now() - startedAt) / 60_000
    if (usedMinutes >= budgetMinutes)
      return t(
        '这次执行已经用了 {used} 分钟，达到计划设定的上限 {limit} 分钟，已暂停。已经产出的内容都保留着，点「继续执行」会重新计时。',
        { used: Math.round(usedMinutes), limit: budgetMinutes },
      )
  }
  return ''
}
