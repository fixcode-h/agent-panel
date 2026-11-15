import type { TasksScope } from '../scope.ts'
import type { IntegrateResult } from '../../exec/worktree-integrate.ts'

/**
 * 子对话收尾各阶段共用的状态（以前是 createMerge 闭包里的几个 let / Set，内层函数直接读写）。
 * 收成显式的对象传给 submit / integrate / after-merge / report，谁读谁写一眼看得出来：
 * - merging：integrate 的 finishChildStep 合并期间加、合完删；submit 拒收「正在合并」；
 *   外面经 TasksScope 读（run.ts 一轮结束时不催正在合并的子对话，worktree-routes.ts 合并中不让删分支）
 * - mergeNudged：submit 收到收尾请求时删；外面经 TasksScope 读写（run.ts、actions-routes.ts）
 * - planNudged：这几个阶段不碰，经 TasksScope 由 drive.ts 读写，createMerge 的 stuckAfterNudge 读
 * - wrapRecheckMs：submit 在收尾请求退回收件箱时用
 */
export type MergeCtx = {
  sc: TasksScope
  /** 父对话正在合并的子对话：这一轮结束时不催它合并，父对话等它的计划步骤也留给合并结果收口 */
  merging: Set<string>
  /** 这一轮结束时已经催过「请父对话收尾」的子对话：再结束还没请就照常上报父对话，不反复催 */
  mergeNudged: Set<string>
  /**
   * 计划没做完就收尾、推满了还停着的子对话：记下推满时计划的进度指纹（见 shared/drive.ts 的 planProgressKey）。
   * 推满了还停在原地，才上报父对话「卡住」；没推满时子对话还在自驱，不打扰父对话（ADR 0041）
   */
  planNudged: Map<string, string>
  /** 收尾请求没能马上交给父对话时，过多久复查一次；测试用环境变量缩短 */
  wrapRecheckMs: number
}

/** 收尾结果：没合进去时带上类别（只有 conflict 退回了子对话）和一行原因，界面按它决定给不给「用 AI 合并」 */
export type FinishResult = Pick<IntegrateResult, 'ok' | 'info' | 'kind' | 'why'>
