import type { PlanItem, PlanStatus, PlanStep, TaskPlan } from '../schema.ts'

/**
 * 计划的文字版（交给 Agent 看：工具结果、每轮提示）。plan.ts 的 planText 和 set_plan 只交变更时的回包共用这一套写法，
 * 这里只依赖类型：工作流运行的子步骤由调用方算好传进来（planChildren 要读任务的节点）
 */

export const STATUS_TEXT: Record<PlanStatus, string> = {
  pending: '待做',
  running: '进行中',
  waiting: '等待中',
  done: '完成',
  skipped: '跳过',
}

const MARK: Record<PlanStatus, string> = { done: '[x]', running: '[>]', waiting: '[~]', skipped: '[-]', pending: '[ ]' }

/** 计划的每一行（带 id，方便 Agent 引用） */
export function planRows(plan: TaskPlan, childrenOf: (s: PlanStep) => PlanItem[]): { id: string; text: string }[] {
  const line = (x: PlanItem, pad: string) => {
    const wait = x.waits.filter((w) => w.state === 'waiting').map((w) => w.label || w.ref)
    const extra = [x.note, wait.length ? `等：${wait.join('、')}` : ''].filter(Boolean).join('；')
    return `${pad}${MARK[x.status]} ${x.id} ${x.title}（${STATUS_TEXT[x.status]}）${extra ? `— ${extra}` : ''}`
  }
  return plan.steps.flatMap((s) => [
    { id: s.id, text: line(s, '') + (s.run ? `（工作流第 ${s.run} 次运行）` : '') },
    ...childrenOf(s).map((c) => ({ id: c.id, text: line(c, '  ') })),
  ])
}

/**
 * set_plan 只交变更（partial）时的回包：变了的行（新加的步骤带上 id）+ 进度 + 现在做到哪。
 * 规则要求每一步动手前、做完后各更新一次，每次回整份计划的话计划越长回包越接近平方增长；整份计划每轮提示词里都有
 */
export function planDelta(rows: { id: string; text: string }[], before: Map<string, string>, progress: string) {
  const changed = rows.filter((r) => before.get(r.id) !== r.text)
  return [
    changed.length
      ? `计划已更新，变了的步骤：\n${changed.map((r) => r.text).join('\n')}`
      : '计划已更新：没有步骤变化。',
    progress,
  ].join('\n')
}
