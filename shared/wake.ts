/**
 * 面板替别人叫醒一个对话（开新的一轮去处理一件事）之前的唯一判断：这次该不该叫。
 *
 * 子对话的上报（noteParent）、子对话请父对话决定 / 安排修复（messageParent）、转交子任务（forwardSpawn）、
 * 父对话或面板交给子对话（sendToChild）以前各写一份守卫，口径不一样，而且都只认「用户亲手停下」：
 * 因用量上限停下的父对话、定时核对收成「已中断」的父对话照样被叫起来空转，用量超了还会父子来回叫（复核 C1-b / C3-a）。
 * 规则只写在这里，调用方拿到不叫的结论时只把消息记进收件箱（或交回失败），不开新的一轮。
 * 用户自己发的消息走路由的 followUp，不经过这里：到了上限用户再说话照样跑一轮。
 */
import { activePlan } from './plan.ts'
import type { PlanWait, StopReason, Task, TaskStatus } from './schema.ts'

/** 执行位上的停止标记：按了停止、还没收完时落盘的 status 还是旧的，要看这一份 */
export type LiveStop = { stop: boolean; stopReason?: StopReason }

export type WakeInput = {
  /** 要叫醒的对话：落盘（或执行位上那份）的状态和停下原因 */
  status: TaskStatus
  stopReason?: StopReason
  /** 它的执行位；不在执行位上时不给 */
  live?: LiveStop
  /** 发这条消息的子对话的执行位：它自己正在被停下时，这条是停下前在路上的 */
  sender?: LiveStop
  /** 这棵对话树已经用到了用量上限（只判断，不停，见 server/tasks/budget.ts 的 overBudget） */
  overBudget: boolean
  /**
   * 上级交代下来的（父对话交给子对话、面板推子对话接着做）：目标自己的停下原因不挡——
   * 交回被停下、被收成「已中断」的子对话正是重试的做法（reportChild 的「下一步」就这么写），只挡整棵树超限
   */
  fromAbove?: boolean
}

/**
 * 不叫的原因：
 * - user：用户亲手停下（含执行位上刚按停止），让它停的人是用户，记进收件箱等用户点「继续执行」
 * - budget：因用量上限停下
 * - lost：定时核对收成「已中断」，要让用户看到中断过再决定，不能被子对话悄悄拉起来（近似悄悄重试）
 * - sender：发件的子对话自己正跟着父对话 / 用户 / 用量上限停下，这条是停下前在路上的
 * - over：整棵树已经超限，目标这一轮也不在（不在执行位上、或正在停）
 */
export type WakeHold = 'user' | 'budget' | 'lost' | 'sender' | 'over'

const HOLD_TARGET = new Set<StopReason>(['user', 'budget', 'lost']) // 模块状态：常量，加载后不改
const HOLD_SENDER = new Set<StopReason>(['parent', 'user', 'budget']) // 模块状态：常量，加载后不改

/** 叫醒前的判断：返回不叫的原因，该叫时返回 undefined */
export function wakeHold(x: WakeInput): WakeHold | undefined {
  if (x.sender?.stop && x.sender.stopReason && HOLD_SENDER.has(x.sender.stopReason)) return 'sender'
  if (!x.fromAbove) {
    // 在执行位上就看执行位：落盘的 stopped 可能是上一次的，它已经被继续了；没按停止的照常交进去
    const why = x.live
      ? x.live.stop
        ? x.live.stopReason
        : undefined
      : x.status === 'stopped'
        ? x.stopReason
        : undefined
    if (why && HOLD_TARGET.has(why)) return why as WakeHold
  }
  // 超限时目标这一轮还在（一般是用户到上限后自己发消息开的那一轮）：消息照常交进这一轮，不开新的一轮
  if (x.overBudget && !(x.live && !x.live.stop)) return 'over'
  return undefined
}

/**
 * 子对话计划里还在等父对话安排修复的那一项（message_parent 带 wait_fix 挂上的 kind parent 等待）：
 * 父对话一回话（sendToChild 的 releaseParentWait）它就不再是 waiting，所以「还挂着」就说明父对话还没回它。
 * 定时核对拿它找「父对话空闲、子对话一直等」的互等（见 server/tasks/state-sweep.ts）
 */
export function parentFixWait(tk: Pick<Task, 'plans' | 'steps'>): PlanWait | undefined {
  const plan = activePlan(tk)
  if (!plan) return undefined
  for (const s of plan.steps)
    for (const x of [...s.children, s]) {
      const w = x.waits.find((y) => y.kind === 'parent' && y.state === 'waiting')
      if (w) return w
    }
  return undefined
}
