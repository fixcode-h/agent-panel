import { liftBudgetFields } from '../../shared/tasks/task-budget.ts'
import type { Migration } from './index.ts'
import { liftTaskFiles } from './lift-tasks.ts'

/**
 * 任务记录上平铺的执行上限字段（budgetFrom、budgetTokens、budgetMinutes、budgetNotice）收进 task.budget 子对象
 * （复查报告 A7，格式见 shared/tasks/task-budget.ts）。只改原始 JSON 上的这几个键，别的原样；没有要改的不写盘
 */
export const taskBudget: Migration = {
  version: 8,
  name: 'task-budget',
  async run(ctx) {
    const n = await liftTaskFiles(ctx, liftBudgetFields)
    if (n) ctx.log(`把 ${n} 个任务记录的执行上限字段收进了 task.budget`)
  },
}
