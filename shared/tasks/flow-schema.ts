import { z } from 'zod'

/** 工作流的种类：change 改代码，跑完经收尾阶段（评审 → 测试 → 修复）待合回；readonly 一个文件都不写，跑完直接完成 */
export const WorkflowKind = z.enum(['change', 'readonly'])
export type WorkflowKind = z.infer<typeof WorkflowKind>

/**
 * 工作流运行的阶段（docs/openspec/changes/workflow-runs/design.md 第 3.3 节）：
 * running 在跑节点；confirm 停在节点上等用户确认；failed 节点失败等决定；wrapup 收尾（评审 / 测试 / 修复，只在显示时按收尾节点现算）；
 * ready 待合回（change）；done 完成（readonly 跑完，或合回之后）；discarded 放弃了；cancelled 被终止。
 * 暂停不单列：任务停着（status stopped）而阶段还在 running / confirm / wrapup，继续时从这里接着走
 */
export const FlowRunPhase = z.enum([
  'running',
  'confirm',
  'failed',
  'wrapup',
  'ready',
  'done',
  'discarded',
  'cancelled',
])
export type FlowRunPhase = z.infer<typeof FlowRunPhase>

/** 运行的决定记录：确认、修改、追问、退回、补充说明；之后每个节点的提示都带上，知道哪些是用户明确要求的 */
export const FlowDecision = z.object({
  at: z.string(),
  /** 在哪个节点上（节点标题）；补充说明可以为空 */
  node: z.string().default(''),
  kind: z.enum(['confirm', 'revise', 'ask', 'back', 'note', 'parent']),
  text: z.string().default(''),
})
export type FlowDecision = z.infer<typeof FlowDecision>

/** 收尾阶段做到哪：评审、测试、修复，第几轮（按步骤现算，见 shared/flow-run.ts 的 wrapNow；不落盘） */
export const FlowWrap = z.object({
  stage: z.enum(['review', 'test', 'fix']),
  round: z.number().int().default(1),
  /** 上一次评审意见、测试输出：修复节点带着它们修 */
  review: z.string().default(''),
  test: z.string().default(''),
})
export type FlowWrap = z.infer<typeof FlowWrap>

/**
 * 工作流运行（不是子对话）：父对话 start_workflow 起的一次运行，记在一个 mode=workflow 的任务上。
 * owner 是它属于哪个父对话；子对话的那一套（自驱、收尾规则、对话状态）不作用到它身上，状态只看 phase
 */
export const FlowRun = z.object({
  owner: z.string(),
  workflowName: z.string().default(''),
  kind: WorkflowKind.default('change'),
  input: z.string().default(''),
  phase: FlowRunPhase.default('running'),
  decisions: z.array(FlowDecision).default([]),
  /** 运行级说明：之后每个节点都带上（message_workflow 的 later、运行面板里的「之后的节点都要知道」） */
  notes: z.array(z.string()).default([]),
  /** 同一节点修改几轮以后在结尾提示（不强制终止，用户 2026-11-05 定）；取自工作流设置，0 表示不提示 */
  reviseLimit: z.number().int().min(0).default(3),
  /** 跑完后交给父对话的结论（一段话）；全文在节点输出里 */
  summary: z.string().default(''),
  /** 父对话停了它（D4：父对话停止时运行也停）；用户在运行上点「重启」或父对话继续时接着跑 */
  pausedBy: z.enum(['parent', 'user', 'restart']).optional(),
  /** 停在等确认时用户点了「交给父对话决定」：父对话用 answer_workflow 代答，决定记录里记成父对话的决定 */
  delegated: z.boolean().optional(),
  /** 运行停着时父对话已经代答了确认：继续执行回到确认时直接用这个回答，不再弹卡片（用过就清掉） */
  preAnswer: z.object({ allow: z.boolean(), answer: z.string().default('') }).optional(),
  /** 已经就哪个阶段给父对话写过信（同一阶段只写一次，面板重启后也不重写） */
  told: z.string().default(''),
})
export type FlowRun = z.infer<typeof FlowRun>
