import type { ApiWait, TaskStep } from '../../shared/schema.ts'

/**
 * 「在排队等 API 名额」这个临时标记的读写。
 *
 * 单独拆出来是为了能被单测覆盖：标记必须保证「此刻真的在排队」才存在，
 * 而它一度由 takeApiSlot 里的一个闭包变量 `queued` 决定清不清 ——
 * 复用别处已经排上的队（ApiSlot 的 pending）时那次回调不会触发，写进去的标记就没人清，
 * 跟着快照留到任务结束，页面上就变成「一直在输出、却显示排队等名额」。
 */

/** 能挂标记的对象：任务的 apiWait 和步骤的 apiWait 是同一套语义 */
type WaitTarget = { apiWait?: ApiWait }

/** 有状态、能挂标记的步骤：节点和子任务都满足，测试里也用最小对象 */
type WaitStep = WaitTarget & { status: TaskStep['status'] }

/** 标记要写进哪个对象：有步骤写步骤，对话这一轮没有步骤，记在任务上 */
const target = (task: WaitTarget, step?: WaitStep): WaitTarget => step ?? task

/** 上下文里这个函数用到的部分：任务（挂标记）和推送变化 */
type WaitCtx = { task: WaitTarget; changed: (x?: boolean) => void }

/**
 * 记下「在排队等名额」，返回步骤原来的状态（清标记时用它还原）。
 * reason 区分开跑前排队（start）和让出名额后拿回（yield）：后者这一轮仍在跑，不能把状态改成排队中。
 * 只在真的改了状态时返回原状态，队伍动了再回调时返回 undefined，调用方保留第一次的值。
 */
export function markApiWait(
  ctx: WaitCtx,
  step: WaitStep | undefined,
  api: string,
  ahead: number,
  reason: ApiWait['reason'],
): TaskStep['status'] | undefined {
  const before = reason === 'start' && step?.status === 'running' ? step.status : undefined
  target(ctx.task, step).apiWait = { api, ahead, reason }
  // 开跑前排队就是还没开始，显示成排队中；让出后拿回时这一轮仍在跑，不动状态
  if (before && step) step.status = 'pending'
  ctx.changed(true)
  return before
}

/** 清掉标记；已经没有就不再推送（拿到名额后不该多推一次空变化） */
export function clearApiWait(ctx: WaitCtx, step: WaitStep | undefined, before?: TaskStep['status']): void {
  const had = !!target(ctx.task, step).apiWait
  delete target(ctx.task, step).apiWait
  if (step && before && step.status === 'pending') step.status = before
  if (had || (step && before)) ctx.changed(true)
}
