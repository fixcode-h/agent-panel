import type { PlanWait, Task, TaskPlan } from '../schema.ts'

// 放在单独的文件里：shared/plan.ts 到了行数上限（scripts/file-caps.json）。不引 plan.ts，免得循环引用

/**
 * 等的结果回来时要改哪几份计划：进行中的那份，加上还挂着这个等待的、已经结束的计划。
 * Agent 用 finish_plan 提前结束计划（换方向重开）时，里面挂着的子对话、后台命令还在跑；
 * 只看进行中的计划的话，结果回来没人收口，旧计划里那一步永远显示「等待中」。从新到旧排，进行中的在最前
 */
export function waitPlans(task: Pick<Task, 'plans'>, kind: PlanWait['kind'], ref?: string): TaskPlan[] {
  const plans = [...(task.plans ?? [])].reverse()
  const holds = (p: TaskPlan) =>
    p.steps
      .flatMap((s) => [s, ...s.children])
      .some((x) =>
        x.waits.some((w) => w.kind === kind && (ref === undefined || w.ref === ref) && w.state === 'waiting'),
      )
  return plans.filter((p, i) => (i === 0 && !p.doneAt) || holds(p))
}
