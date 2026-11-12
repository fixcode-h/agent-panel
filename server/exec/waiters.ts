import type { Attachment, TaskMessage } from '../../shared/schema.ts'

/**
 * 回复完停在等下一句（保活、wait_user_message）或等子任务时还能接用户消息的调用（任务 id → 它们）。
 * 用户发消息时直接交回同一个进程，不用结束再 --resume；页面切走宽限到了就让它结束这一轮。
 * 登记和摘除只在这里：每个等待只摘自己（见 docs/modules/server-exec/bugs/keepalive-double-wait.md）
 */
export interface Waiter {
  /**
   * 用户发来下一句：记进对话再交给正在等的 CLI（placed 是拷进任务目录的那份，只有 CLI 用）。
   * recorded：消息早已记在对话里（排着等下一轮的那些），只交给 CLI、不再记一遍
   */
  deliver: (msg: TaskMessage, placed?: Attachment[], recorded?: boolean) => void
  /** 用户离开了：结束等待 */
  cancel: () => void
  /** 输入框里的 CLI/模型/强度还是启动这个进程时的那一套 */
  current: () => boolean
}

const waiters = new Map<string, Set<Waiter>>() // 模块状态：会话，跟着进程或连接一起没

/** 挂上一个等待 */
export function addWaiter(taskId: string, w: Waiter) {
  ;(waiters.get(taskId) ?? waiters.set(taskId, new Set()).get(taskId)!).add(w)
  return waiters.get(taskId)!.size
}

/** 摘掉这一个等待（只摘它自己）；摘到了返回 true */
export function removeWaiter(taskId: string, w: Waiter) {
  const set = waiters.get(taskId)
  const had = !!set?.delete(w)
  if (set && !set.size) waiters.delete(taskId)
  return had
}

/** 消息交给谁：最早挂上、还在等的那一个 */
export const firstWaiter = (taskId: string) => waiters.get(taskId)?.values().next().value

/** 这个任务所有还在等的（取消时逐个结束） */
export const waitersOf = (taskId: string) => [...(waiters.get(taskId) ?? [])]

/**
 * 一次调用里的「等下一句」：同一个进程可能先后挂上两个——CLI 没等面板交消息，自己又跑了一轮
 * （把排在输入里的插话当成新一轮）再停回来。新挂上的换下旧的：旧的摘出等待表、不再接消息，
 * 它的 Promise 留到停止 / 离开时随 signal 结束（提前结束会让保活那头当成「不再等」把进程关掉）。
 * 以前共用一个变量记「当前的等待」，先收尾的那个会把后挂上的删掉、自己留在表里，
 * 之后的消息交给已经收完尾的旧等待：没记进对话、CLI 也收不到（用户 2026-11-02 复现）
 */
export function userWaitSlot(taskId: string) {
  let cur: Waiter | undefined
  return {
    /** 挂上新的等待；返回 { replaced：换下了还挂着的旧等待, size：表里现在几个 } */
    put(w: Waiter) {
      const replaced = !!cur && removeWaiter(taskId, cur)
      cur = w
      return { replaced, size: addWaiter(taskId, w) }
    },
    /** 这个等待收尾了：只摘它自己 */
    drop(w: Waiter) {
      removeWaiter(taskId, w)
      if (cur === w) cur = undefined
    },
  }
}
