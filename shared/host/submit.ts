// 交结论、交结果、交阶段报告：Agent 用工具交上来的东西，状态只认它们（ADR 0041 第 16 节）。
// 从 shared/engine/host.ts 的 Orchestra 大接口里按能力拆出来（重构文档第 5 条），成员数由 scripts/structure-check.mjs 盯着
import type { StageReport } from '../flow/stage-report.ts'
import type { Blocker } from '../submitted.ts'

type Receipt = { ok: boolean; info: string }

/** Orchestra 里交东西的那部分 */
export interface OrchSubmit {
  /** 交结果（submit_result）：只有子任务有 */
  submitResult?: (r: { state: 'done' | 'unfinished' | 'stuck'; summary: string; left: string }) => Receipt
  /** 交结论（submit_verdict，ADR 0041 第 16 节）：节点和子任务有，对话本身没有 */
  submitVerdict?: (v: { verdict: 'pass' | 'fail'; blockers?: Blocker[] }) => Receipt
  /** 交阶段报告（submit_report）：只有勾了「完成后等我确认」的节点有，审阅弹窗按它排版、勾选决策 */
  submitReport?: (r: StageReport) => Receipt
}
