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

export interface HeldMessage {
  id: string
  text: string
  attachments: Attachment[]
  /** 合进这一条的其他消息（父对话接连交代的几封信）：开新一轮时它们的交付状态一起改 */
  merged?: string[]
  /** 父对话交代任务的信：排在它后面的同类信合进来 */
  letter?: boolean
}

const held = new Map<string, HeldMessage[]>()

/** 父对话交代任务的信（不是回答、收尾结果、面板消息） */
const isLetter = (msg: TaskMessage) => msg.peer?.rel === 'parent' && msg.peer.kind === 'task'

export function holdForNextTurn(taskId: string, msg: TaskMessage) {
  const list = held.get(taskId) ?? []
  const last = list.at(-1)
  // 子对话正在执行时父对话又接连写了几封：排在一起的合成一轮处理，不按封数一轮轮开（实测 2 分钟 5 封）。
  // 只合紧挨着的，中间夹着用户消息就不合，顺序不变；每封信在对话里还是各自一行
  if (last?.letter && isLetter(msg)) {
    last.text += `\n\n（父对话接着又发来一封：）\n${msg.text}`
    last.attachments = [...last.attachments, ...(msg.attachments ?? [])]
    last.merged = [...(last.merged ?? []), msg.id]
    return
  }
  list.push({ id: msg.id, text: msg.text, attachments: msg.attachments ?? [], ...(isLetter(msg) && { letter: true }) })
  held.set(taskId, list)
}

/** 这一条排着的消息对应对话里的哪几条（合进来的信也算），改交付状态时一起改 */
export const heldIds = (q: Pick<HeldMessage, 'id' | 'merged'>) => [q.id, ...(q.merged ?? [])]

/** 把这几条排着的消息（含合进来的信）在对话里的交付状态改成 how */
export function markHeld(
  messages: TaskMessage[],
  list: Pick<HeldMessage, 'id' | 'merged'>[],
  how: 'wait' | 'next' | 'lost',
) {
  const ids = new Set(list.flatMap(heldIds))
  const at = new Date().toISOString()
  for (const m of messages) if (ids.has(m.id) && m.role === 'user') m.delivery = { how, at }
}

/**
 * 排着的这条交给 CLI 时用的消息：对话里记着的那条（recorded）换上排队时的正文，没记的当面板消息。
 * 父对话接连几封信合成了一条（holdForNextTurn），只交第一封的原文会丢掉后面几封
 */
export function heldMessage(messages: TaskMessage[], q: HeldMessage): { msg: TaskMessage; recorded: boolean } {
  const rec = messages.find((m) => m.id === q.id)
  if (rec) return { msg: { ...rec, text: q.text }, recorded: true }
  return {
    msg: { id: q.id, role: 'system', agentId: '', step: '', text: q.text, tools: [], at: new Date().toISOString() },
    recorded: false,
  }
}

/** 取出来交不出去：原样放回队首（合并过的不拆开），顺序不变 */
export function returnHeld(taskId: string, q: HeldMessage) {
  held.set(taskId, [q, ...(held.get(taskId) ?? [])])
}

/** 取这一轮结束后要处理的下一条；没有时返回空 */
export function takeHeld(taskId: string): HeldMessage | undefined {
  const list = held.get(taskId)
  const first = list?.shift()
  if (list && !list.length) held.delete(taskId)
  return first
}

/**
 * 从这一轮结束后的队列里撤掉一条（自动询问没送出去时用）：后面的消息保持原来的顺序，
 * 不会因为一条过时的状态询问排在用户消息前面
 */
export function removeHeld(taskId: string, id: string) {
  const list = held.get(taskId)
  if (!list) return
  const i = list.findIndex((x) => x.id === id)
  if (i >= 0) list.splice(i, 1)
  if (!list.length) held.delete(taskId)
}

export const hasHeld = (taskId: string) => !!held.get(taskId)?.length

/** 这一轮停下了（失败、暂停、面板退出）：不再自动接着跑，消息留在对话里由用户决定 */
export const dropHeld = (taskId: string) => {
  const list = held.get(taskId) ?? []
  held.delete(taskId)
  return list
}
