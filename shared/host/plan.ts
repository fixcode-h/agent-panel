// 计划和工作流运行：set_plan / finish_plan / end_turn、共享状态、在对话名下起工作流，以及宿主那边的收尾、完成依据。
// 从 shared/engine/host.ts 的 EngineHost / Orchestra 两个大接口里按能力拆出来（重构文档第 5 条），
// 新能力加进对应的小接口或新开一个，不再往大接口上加；成员数由 scripts/structure-check.mjs 盯着
import type { GateStep, TurnExtra } from '../done-evidence.ts'
import type { FlowRunHost, RunTools } from '../flow/run-orch.ts'
import type { PickedFlow, WorkflowEntry } from '../flow/run.ts'
import type { PlanItemInput, WrapUpAnswer } from '../plan.ts'

/** Orchestra 里计划和工作流运行的那部分（重构文档第 5 条：按能力拆成小接口，Orchestra 只是它们的组合） */
export interface OrchPlan {
  /** 项目里的对话有执行计划：set_plan 交整份计划，finish_plan 结束这份计划 */
  plans: boolean
  /** partial：只交变更步骤，其余没写到的步骤留在计划里不动（步骤多时分两批交） */
  setPlan(input: {
    title?: string
    steps?: PlanItemInput[]
    partial?: boolean
    summary?: string
  }): Promise<{ ok: boolean; info: string }>
  finishPlan(summary: string): Promise<{ ok: boolean; info: string }>
  /** 对话（Agent 模式）交代这一轮怎么结束：done / blocked（shared/end-turn.ts）；其余身份没有这个工具 */
  endTurn?: (outcome: string, need: string) => Promise<{ ok: boolean; info: string }>
  /** 等你操作：请用户离开对话去做一件事（shared/user-action.ts）；和 endTurn 同样只给对话 */
  requestUserAction?: (input: Record<string, unknown> | undefined) => { ok: boolean; info: string }
  /**
   * 这次运行有共享状态（存在 task.runs 里）：工作流运行才有，对话模式没有。
   * 没有时 read_state / write_state 根本不注册，注册了也只会让模型每次都调出「这次运行没有共享状态」
   */
  sharedState: boolean
  /** 本次运行的共享状态：读快照 / 写一个键 */
  readState(): string
  writeState(key: string, value: string): { ok: boolean; info: string }
  /** 父对话能启动工作流（角色开了 canPlan、能分派子对话）：start_workflow 在它名下起一次工作流运行 */
  planning: boolean
  /** 按 id 或名字找能启动的工作流（空是项目默认的）；找不到时 info 列出可选的 */
  pickWorkflow(idOrName: string): { ok: false; info: string } | { ok: true; flow: PickedFlow }
  /** 工作流运行的那几样操作（flow-run-orch.ts）：起、看、补充、调整、代答、终止、合回 */
  runs: RunTools
}

/** EngineHost 里计划和工作流运行的那部分 */
export interface PlanHost {
  /** 项目里可选的工作流目录：父对话按名称、说明、适用场景和节点概览挑一个（ADR 0044） */
  workflowCatalog?: () => WorkflowEntry[]
  /** 工作流运行的操作（父对话用，flow-run-orch.ts）：宿主在父对话名下起运行、补充、调整、终止、合回 */
  runs?: FlowRunHost
  /**
   * 项目打开了「改了代码要跑过测试步骤才能结束」（Project.requireVerify）：end_turn 记成做完前按这些步骤核对（shared/done-evidence.ts）。
   * 没开时不传，只记完成依据、卡片上标出来
   */
  verifyGate?: { steps: GateStep[] }
  /**
   * 这一轮工具调用之外的完成依据（shared/done-evidence.ts 的 TurnExtra）：插件工具报的改动和验证；
   * 打开了 verifyGate 时还有命令改的文件（工作区快照差）。end_turn(done) 时现取，见 server/exec/turn-extra.ts
   */
  turnExtra?: () => Promise<TurnExtra>
  /**
   * 这个对话的收尾（面板保证它是计划的最后一步，见 plan.ts 的 ensureWrapUp）：
   * merge 子对话的独立分支合回父对话所在的分支，p4 子对话按文件类型分进各自的 pending changelist，
   * push 父对话把分支推到远端；不用收尾的不传，'none' 是明确不推送（去掉计划里还挂着的推送收尾）
   */
  wrapUp?: WrapUpAnswer
  /** 这一轮的 CLI 自带待办会被面板解析显示（CLI 定义的 todos）：Chat 模式据此决定怎么说计划（shared/chat-prompt.ts） */
  cliTodos?: boolean
}
