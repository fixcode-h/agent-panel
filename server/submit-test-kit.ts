/**
 * 单测里的假 CLI 用：派出的子任务像真的 Agent 那样最后调 submit_result 交「做完」（ADR 0041 第 16 节：面板只认工具，不看回复文字）。
 * 专测「没交结果」的用例不要用它（见 shared/helper-summary.test.ts）
 */
import type { AgentCall } from '../shared/engine.ts'

export function autoSubmit(call: AgentCall) {
  if (call.step?.slot === 'sub' && call.orch?.submitResult && !call.step.submitted?.state)
    call.orch.submitResult({ state: 'done', summary: '做完了', left: '' })
}
