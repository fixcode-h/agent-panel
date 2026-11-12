import { z } from 'zod'
import { QuotaResumeState } from '../quota-resume.ts'

/**
 * 对话上的几样运行记录和「对话自己的用量上限」（分析稿 A6、A10）。
 * 从 schema.ts 拆出来：那个文件贴着行数上限，这里只放结构，规则在各自的文件里
 * （shared/budget.ts、shared/budget-rate.ts、server/turn/changes.ts、shared/drive.ts）
 */

/** 用量上限：token（输入 + 输出）和费用（美元），0 表示这一项不限 */
export const ConvBudget = z.object({
  tokens: z.number().int().min(0).default(0),
  costUsd: z.number().min(0).max(100000).default(0),
})
export type ConvBudget = z.infer<typeof ConvBudget>

/**
 * 每轮改动的起点（server/turn/changes.ts）：原来只记在内存里，面板重启后进行中的那一轮就没有改动卡片了（A10）。
 * open 为 true 表示这一轮开了还没收（重启后接着这个起点算）；收了以后 mark 是终点，接着做的那一轮从它算起
 */
export const TurnTrack = z.object({
  dir: z.string(),
  /** 这一段的起点快照（git 树） */
  mark: z.string(),
  /** 这一轮里已经切下来的几段（中间被子对话合并隔开） */
  spans: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .max(200)
    .default([]),
  /** 这一段开始时的提交：认出拉代码带进来的文件 */
  head: z.string().default(''),
  /** 这一段开始的时刻（epoch ms） */
  at: z.number(),
  open: z.boolean().default(false),
})
export type TurnTrack = z.infer<typeof TurnTrack>

/**
 * 面板推对话接着做的次数（shared/drive.ts 的 DriveBudget）：同一个进度推了几次、同一条输入之后一共推了几次。
 * 存进对话，面板重启后接着数，不从 1 重新数（A10）
 */
export const DriveCount = z.object({
  key: z.string().default(''),
  n: z.number().int().min(0).default(0),
  input: z.string().default(''),
  total: z.number().int().min(0).default(0),
})
export type DriveCount = z.infer<typeof DriveCount>

/** Task 上的这几个字段：schema.ts 的 TaskData 里展开 */
export const TaskRuntimeFields = {
  /** 新建对话时单独设的用量上限（连同名下子对话）：设了就用它，不用项目的（shared/budget.ts 的 budgetFor） */
  convBudget: ConvBudget.optional(),
  /** 用量速率提醒过的时间：每个对话只提醒一次（shared/budget-rate.ts） */
  rateNoticeAt: z.string().optional(),
  turnTrack: TurnTrack.optional(),
  driveCount: DriveCount.optional(),
  /** 额度用完、被限流后自动接的记录：接了几次、换过哪些模型、在等到什么时候（shared/quota-resume.ts） */
  quotaResume: QuotaResumeState.optional(),
}
