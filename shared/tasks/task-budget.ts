import { z } from 'zod'
import { liftFields } from './lift-fields.ts'

/**
 * 一个对话最多能设多少 token 的执行上限：一亿 token 已经远超一次对话，
 * 再大一定是填错了；太小会挡住正常的长时间任务，所以不收更小的人工上限
 */
export const MAX_TASK_BUDGET_TOKENS = 100_000_000
/** 一个对话的时长上限最多几天（分钟）：和设置里的单步时限同一个上限，超过一天的任务该拆成多个 */
export const MAX_TASK_BUDGET_MINUTES = 1440

/**
 * 对话上和执行上限有关的数据（复查报告 A7）：原来平铺在 Task 顶层（budgetFrom、budgetTokens、budgetMinutes、budgetNotice），
 * 收进 task.budget 一个子对象。没设上限、也还没跑过的对话没有 task.budget。
 * 旧数据由 server/migrations/0008-task-budget.ts 一次性转过来，旧导出文件导入时由 liftBudgetFields 转。
 */
export const TaskBudget = z.object({
  /** 执行上限（定时计划带的）：token 上限，没有或 0 表示不限（原 task.budgetTokens） */
  tokens: z.number().int().min(0).max(MAX_TASK_BUDGET_TOKENS).optional(),
  /** 时长上限（分钟），没有或 0 表示不限（原 task.budgetMinutes） */
  minutes: z.number().int().min(0).max(MAX_TASK_BUDGET_MINUTES).optional(),
  /** 这一轮开始时的累计用量：上限按每次执行算，继续执行就重新给一份额度（原 task.budgetFrom） */
  from: z
    .object({
      usd: z.number(),
      tokens: z.number(),
      /** 这一轮开始的时刻（epoch ms）：时长上限从它算起；旧记录没有，时长上限按不限处理 */
      at: z.number().optional(),
    })
    .optional(),
  /** 顶层对话的用量上限提醒到了哪一级（warn 提醒过、over 停过）：同一级只说一次；调高上限后跟着回落（原 task.budgetNotice） */
  notice: z.enum(['warn', 'over']).optional(),
})
export type TaskBudget = z.infer<typeof TaskBudget>

/** 旧格式平铺在 Task 顶层的字段 → task.budget 里的键 */
const LEGACY_KEYS = { budgetTokens: 'tokens', budgetMinutes: 'minutes', budgetFrom: 'from', budgetNotice: 'notice' }

/**
 * 把旧格式的原始任务 JSON 就地改成 task.budget 子对象，返回改没改；0（不限）的上限直接丢掉。
 * 只给一次性迁移和导入旧导出文件用，读任务时不再调
 */
export const liftBudgetFields = (raw: Record<string, unknown>): boolean =>
  liftFields(raw, 'budget', LEGACY_KEYS, (to, v) => (to === 'tokens' || to === 'minutes') && v === 0)
