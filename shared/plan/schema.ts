import { z } from 'zod'

// 从 schema.ts 拆出来（那个文件到了行数上限）：执行计划的结构，schema.ts 原样转出，引用的地方不用改

/**
 * 对话的执行计划：对话分析完列出主步骤，每个主步骤最多再分一层子步骤。
 * 完成的步骤锁死不再改；整份做完、写了总结后收起，之后的新内容开一份新计划。
 * waiting：步骤在等后台命令、子对话这类耗时的结果，对话先去做下一步，结果回来再处理它。
 * running 与 waiting 分开：running 是「对话现在在动手」（一份计划里最多一个），waiting 是「在等外部结果」（必须挂着 waits）。
 * skipped：明确不做，终态（见 ADR 0020）。
 * 没有「失败」：等的结果没成功、工作流没走完，那一步退回进行中、备注写「需要修复：原因」，对话去查问题修好重做，
 * 不在计划上留一个失败的步骤（用户 2026-10-30 定的，见 ADR 0032）。旧数据里的 failed 读出来就是进行中
 */
export const PlanStatus = z.preprocess(
  (v) => (v === 'failed' ? 'running' : v),
  z.enum(['pending', 'running', 'waiting', 'done', 'skipped']),
)
export type PlanStatus = z.infer<typeof PlanStatus>

/**
 * 步骤在等的东西：后台命令（编号）、子对话（id）、子任务（spawn_agents 派出的步骤 id）、等你操作（user，request_user_action 的 id）；
 * 结果回来时按 kind + ref 找到挂在计划里的那一步
 */
export const PlanWait = z.object({
  /** parent：子对话把不是自己改出来的报错交给父对话，等父对话通知修好（ref 固定 fix） */
  kind: z.enum(['background', 'child', 'helper', 'parent', 'workflow', 'user']),
  ref: z.string(),
  label: z.string().default(''),
  state: z.enum(['waiting', 'ok', 'failed']).default('waiting'),
  /** 开始等的时间（子对话是它的创建时间）：步骤用时从真正开工算起。旧数据没有 */
  at: z.string().optional(),
})
export type PlanWait = z.infer<typeof PlanWait>

export const PlanItem = z.object({
  id: z.string(),
  title: z.string(),
  status: PlanStatus.default('pending'),
  /** Agent 写的一句备注（在等什么、卡在哪），或者面板写的等待结果 */
  note: z.string().default(''),
  waits: z.array(PlanWait).default([]),
  startedAt: z.string().default(''),
  endedAt: z.string().default(''),
  /**
   * 这一项最后一次真正变化（状态、标题、备注、等待项）的时间：滞后检测和界面的「N 分钟前更新」读它。
   * 旧数据没有这个字段，读时退回 startedAt（见 shared/plan.ts 的 itemUpdatedAt）
   */
  updatedAt: z.string().optional(),
})
export type PlanItem = z.infer<typeof PlanItem>

export const PlanStep = PlanItem.extend({
  /** 子步骤；主步骤是一次工作流运行时为空，子步骤就是那次运行的节点（run） */
  children: z.array(PlanItem).default([]),
  /** 这个主步骤是第几次工作流运行（工作流子对话的流程图） */
  run: z.number().int().optional(),
  /**
   * 面板加的收尾步骤，永远是计划的最后一步（见 plan.ts 的 ensureWrapUp）：merge 是子对话的独立分支合回父对话
   * 所在的分支，由合并结果标完成；p4 是子对话把改动按文件类型分进各自的 pending changelist 后请父对话验收、
   * deliver 是共用目录或没有版本管理的子对话请父对话验收，这两种都由父对话收下后面板标完成；
   * push 是父对话把分支推到远端，Agent 推完自己标。旧数据没有这个字段，当普通步骤
   */
  wrapUp: z.enum(['merge', 'p4', 'deliver', 'push']).optional(),
  /**
   * 评审本次改动的一步：子对话收尾前必须把它写进计划（标 review: true）并做完，
   * submit_merge 会校验计划里有没有这样一步（见 shared/review-gate.ts）。旧数据没有这个字段
   */
  review: z.boolean().optional(),
  /**
   * 面板按子对话自动补的步骤（见 plan.ts 的 ensureChildStep）：派子对话时计划里没有能挂的一步就补一步，
   * 免得子对话在父对话的计划里看不见。Agent 交整份计划时没写到的自动步骤不会被当成「不做了」删掉。
   * 旧数据没有这个字段
   */
  auto: z.boolean().optional(),
})
export type PlanStep = z.infer<typeof PlanStep>

export const TaskPlan = z.object({
  id: z.string(),
  title: z.string().default(''),
  steps: z.array(PlanStep).default([]),
  createdAt: z.string(),
  /**
   * 面板重开这份计划的时间（见 plan.ts 的 ensureChildStep）：计划已结束后又派了子对话，就重开它。
   * 总用时从重开时刻重新算，不把上一轮的历史时长并进这一轮（旧数据没有这个字段）
   */
  reopenedAt: z.string().optional(),
  /** 所有步骤都完成的时间；没完成时为空 */
  doneAt: z.string().default(''),
  /**
   * 这份计划最后一次变化（任何一步的状态、标题、备注，或计划的标题）的时间：
   * 界面的「N 分钟前更新」和「新输入之后计划有没有动过」都读它。旧数据没有，退回 createdAt
   */
  updatedAt: z.string().optional(),
  /**
   * 最近一次「带新要求性质」的输入到达时间（用户消息、父对话转达、子对话 / 后台结果里带了新任务）。
   * 只用来判断「新输入之后计划有没有动过」，不参与状态推进（见 ADR 0020）
   */
  lastInputAt: z.string().optional(),
  /**
   * 已经为哪一次输入提醒过「计划没跟着改」（对应 lastInputAt 的值）：只提醒一次，
   * 否则对话选了「不改计划、说明一句」时会被每轮重复追问（见 shared/plan.ts 的 inputUnhandled）
   */
  inputNotedAt: z.string().optional(),
  /**
   * 对话自己（set_plan）最后一次改这份计划的时间。「新要求进来后计划有没有跟着改」只认它：
   * 面板替它推进的变化（结果回来标完成、派子对话挂等待、子对话上报改备注）不算对话看过了新要求
   */
  agentUpdatedAt: z.string().optional(),
  /** 对话自己写的这份计划的总结：收尾时随 set_plan / finish_plan 交（ADR 0041）；autoSummary 是旧数据的标记 */
  summary: z.string().default(''),
  autoSummary: z.boolean().default(false),
})
export type TaskPlan = z.infer<typeof TaskPlan>
