// makeOrchestra 拼工具时各组共用的上下文（重构文档第 3 条：makeOrchestra 按派发 / 计划 / 对话 / 能力拆开）。
// 以前这些是 makeOrchestra 闭包里的局部变量，各组工具直接读；现在显式传进去，看签名就知道一组工具依赖什么。
import type { NodeTier, Task, TaskStep, Workflow, Agent } from '../schema.ts'
import type { EngineHost } from '../engine-host.ts'
import type { orchState } from '../engine-helpers.ts'

/** makeOrchestra 的第二个参数：这组工具给谁用 */
export interface OrchOpts {
  workflow?: Workflow
  tier: NodeTier
  chat?: boolean
  planning?: boolean
  coordinator?: boolean
  /** 调用者是派出去的子任务：只做并行的收集、核实、出计划，不能再往外派 */
  helper?: boolean
}

export interface OrchCtx {
  host: EngineHost
  ctx: OrchOpts
  /** 调用这组工具的节点（对话是 @chat） */
  self: TaskStep
  /** 这个任务的编排运行时状态（派出的子任务、交回的批次，见 orchState） */
  st: ReturnType<typeof orchState>
  task: Task
  helper: boolean
  /** 调用者自己的角色：挂了哪些能力、能不能就地改动都看它 */
  selfAgent: Agent | undefined
  /** 能启动计划 */
  planner: boolean
  /** 能分派子对话 */
  coordinator: boolean
  /** Chat 模式（ADR 0038） */
  chatMode: boolean
  /** 系统消息挂在哪个节点上：对话的工具调用不挂 */
  where: string
  /** 按 id 或标题找节点 */
  findStep: (key: string) => TaskStep | undefined
}
