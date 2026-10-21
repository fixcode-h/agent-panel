import type { Attachment, TaskMessage } from '../../shared/schema.ts'

/**
 * 执行中补充的两种「交不出去」的落脚点。
 *
 * 1. 这一轮里能收、但还没被取走的补充（CLI 没有插话协议，用 read_user_notes 取）：
 *    消息已经记进对话，这里只登记给正在跑的那次调用；它取走时交给模型。
 * 2. 这一轮里完全交不出去的补充：消息同样已经在对话里，这里只记「这一轮结束后要接着处理哪几条」。
 *
 * 都只在内存里：面板重启后这一轮本来就中断了，消息还留在对话里，用户点「继续执行」时会带上；
 * 不落盘也不会因为某条数据坏了把任务弄丢。
 */
export interface NoteTaker {
  /** 新登记一条补充 */
  add: (msg: TaskMessage) => void
  /** 面板的工具调用：把还没取走的交给模型（返回给模型的文字） */
  read: () => string[]
}

const takers = new Map<string, Set<NoteTaker>>()

export function addNoteTaker(taskId: string, taker: NoteTaker) {
  const set = takers.get(taskId) ?? new Set<NoteTaker>()
  set.add(taker)
  takers.set(taskId, set)
}

export function removeNoteTaker(taskId: string, taker: NoteTaker) {
  const set = takers.get(taskId)
  set?.delete(taker)
  if (!set?.size) takers.delete(taskId)
}

/** 这个任务正在跑、能用面板工具取补充的调用；没有时为空 */
export const noteTakersOf = (taskId: string) => takers.get(taskId)

interface HeldMessage {
  id: string
  text: string
  attachments: Attachment[]
}

const held = new Map<string, HeldMessage[]>()

export function holdForNextTurn(taskId: string, msg: TaskMessage) {
  const list = held.get(taskId) ?? []
  list.push({ id: msg.id, text: msg.text, attachments: msg.attachments ?? [] })
  held.set(taskId, list)
}

/** 取这一轮结束后要处理的下一条；没有时返回空 */
export function takeHeld(taskId: string): HeldMessage | undefined {
  const list = held.get(taskId)
  const first = list?.shift()
  if (list && !list.length) held.delete(taskId)
  return first
}

export const hasHeld = (taskId: string) => !!held.get(taskId)?.length

/** 这一轮停下了（失败、暂停、面板退出）：不再自动接着跑，消息留在对话里由用户决定 */
export const dropHeld = (taskId: string) => void held.delete(taskId)
