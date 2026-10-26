/**
 * 打开一条对话时的加载进度：每个真实发起的请求、真正画完的那一帧各记一条，
 * 界面按它逐行打出日志，卡在哪一步一眼能看到。
 *
 * 这里只算「什么时候开始、什么时候结束、有没有失败」，不含任何假进度：
 * 没发起的步骤是 waiting，发起了没回来的是 running，已等待多久由 stepElapsed 现算
 * （界面每秒重算一次，不在这里起定时器）。时间全部可注入，单测不依赖真实时钟。
 */

/** 打开对话要走的步骤，按用户能感知的先后排（只是 id，文案在界面上翻） */
export const LOAD_STEPS = ['task', 'stream', 'children', 'seen', 'render'] as const
export type TraceStepId = (typeof LOAD_STEPS)[number]

/**
 * waiting：还没发起（界面写「等待中」）
 * running：已发起、还没回来（界面写「进行中」并显示已等待时长）
 * done：正常结束；failed：出错，error 里是错误原文
 * skipped：这次不走这一步，或前面失败后没再执行（界面写「未执行」/ 说明原因）
 */
export type TraceStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

export interface TraceStep {
  id: TraceStepId
  status: TraceStatus
  /** 发起时刻（毫秒时间戳） */
  startedAt?: number
  endedAt?: number
  /** 失败时的错误原文：界面上原样显示，不吞 */
  error?: string
  /** 这一步实际做了什么：「611 条消息」「演示版没有实时推送」 */
  detail?: string
}

export const createTrace = (ids: readonly TraceStepId[] = LOAD_STEPS): TraceStep[] =>
  ids.map((id) => ({ id, status: 'waiting' }))

const patch = (steps: TraceStep[], id: TraceStepId, next: (s: TraceStep) => TraceStep) =>
  steps.map((s) => (s.id === id ? next(s) : s))

/** 发起：只在还没开始时记起点，重复调用不会把已等待的时长清零 */
export function startStep(steps: TraceStep[], id: TraceStepId, at = Date.now()) {
  return patch(steps, id, (s) => (s.status === 'waiting' ? { ...s, status: 'running', startedAt: at } : s))
}

/** 正常结束：已经失败的步骤保持失败（catch 里记了失败、finally 里又走一次结束是常规写法） */
export function finishStep(steps: TraceStep[], id: TraceStepId, at = Date.now(), detail?: string) {
  return patch(steps, id, (s) =>
    s.status === 'running' || s.status === 'waiting'
      ? { ...s, status: 'done', startedAt: s.startedAt ?? at, endedAt: at, detail: detail ?? s.detail }
      : s,
  )
}

/** 失败：错误原文留在步骤上；已经完成的步骤不再改成失败 */
export function failStep(steps: TraceStep[], id: TraceStepId, error: string, at = Date.now()) {
  return patch(steps, id, (s) =>
    s.status === 'running' || s.status === 'waiting'
      ? { ...s, status: 'failed', startedAt: s.startedAt ?? at, endedAt: at, error }
      : s,
  )
}

/** 失败后恢复了（实时推送断过一次、重连成功）：改回完成并清掉错误，另写一句说明。
 *  和 finishStep 分开：finishStep 的「已失败的不被完成覆盖」是对真失败的保证，
 *  恢复是另一条语义，只由确认真的好了的调用方（SSE 的 full 事件）触发 */
export function recoverStep(steps: TraceStep[], id: TraceStepId, detail?: string, at = Date.now()): TraceStep[] {
  return patch(steps, id, (s) =>
    s.status === 'failed' ? { ...s, status: 'done', endedAt: at, error: undefined, detail: detail ?? s.detail } : s,
  )
}

/** 这一步这次不走（演示版没有实时推送），或前面失败后没再执行 */
export function skipStep(steps: TraceStep[], id: TraceStepId, detail?: string) {
  return patch(steps, id, (s) => (s.status === 'waiting' ? { ...s, status: 'skipped', detail: detail ?? s.detail } : s))
}

/** 某一步失败后把还没开始的步骤标成「未执行」：它们不是卡住了，是没轮到 */
export function abortWaiting(steps: TraceStep[]): TraceStep[] {
  return steps.map((s) => (s.status === 'waiting' ? { ...s, status: 'skipped' } : s))
}

/**
 * 这一步花了多久：结束的按起止算，进行中的按「到现在」算（界面每秒重算，越卡数字越大）。
 * 还没开始、没记录起点的返回 undefined，界面不显示耗时。
 */
export function stepElapsed(step: TraceStep, now = Date.now()) {
  const start = step.startedAt
  if (start === undefined) return undefined
  return Math.max(0, (step.endedAt ?? now) - start)
}

/** 全部走完（没有还在等、还在跑的步骤） */
export const traceSettled = (steps: TraceStep[]) =>
  steps.every((s) => s.status === 'done' || s.status === 'failed' || s.status === 'skipped')
