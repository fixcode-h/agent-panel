import type { TaskMessage } from '@shared/schema'

/**
 * 「n 个子任务交回了结果」的 n。新数据记着交回的是哪几个子任务（results）；旧数据只有正文，
 * 不能数「### 」标题：子任务自己的输出里也常带三级小标题，两个子任务能数出五个（用户 2026-11-09 报）。
 * 旧数据按面板写的固定格式认：做完的标题行后面跟着「（交了结果…）/（没有用 submit_result…）」，
 * 没做完的末尾有一句「（要重试就调用 spawn_agents…）」，见 shared/engine.ts 的 settleHelpers
 */
export function helperResultCount(m: Pick<TaskMessage, 'results'>, body: string) {
  if (m.results?.length) return m.results.length
  const done = body.match(/^### [^\n]*（(交了结果|没有用 submit_result)[^\n]*）$/gm)?.length ?? 0
  const failed = body.match(/^（要重试就调用 spawn_agents/gm)?.length ?? 0
  if (done + failed) return done + failed
  return Math.max(1, body.match(/^### /gm)?.length ?? 0)
}
