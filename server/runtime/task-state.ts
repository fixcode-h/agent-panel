/**
 * 按对话记的运行时状态（重构文档第 11 条第二步）：只在内存里、重启就丢的那些「这个对话的……」——
 * 钩子「说过一次」的记录、留给下一个节点的补充、排队待交给 CLI 的消息、每轮改动的快照……
 *
 * 以前每个模块各自在顶层 `new Map()`，谁也不知道一共有多少份、对话删掉后哪些还留着（钩子那几张表只增不减）。
 * 现在都经这里建：
 * - `taskMap(owner)` / `taskSet(owner)` 建一份以对话 id 为键的表，登记在这里；
 *   结构复杂、自己有清理函数的（例如在场心跳的计时器）用 `onForgetTask(owner, fn)` 登记清理函数。
 * - 对话彻底删掉（回收站过期、永久删除）时 `forgetTask(id)` 一次把所有登记过的都清掉，不用在删除那里一个个点名。
 * - `taskStateReport()` 列出每一份有多少条，排查内存、看谁在攒数据时用。
 *
 * 跨重启要保留的不放这里，落盘（见 docs/lessons/structure.md）。
 */

interface Slot {
  owner: string
  forget: (taskId: string) => void
  size: () => number
}

// 模块状态：接线，各模块加载时登记自己的表，表本身的内容才是运行时数据
const slots: Slot[] = []

/** 一份以对话 id 为键的表；owner 写「模块.用途」，排查时按它认 */
export function taskMap<V>(owner: string): Map<string, V> {
  const m = new Map<string, V>()
  slots.push({ owner, forget: (id) => m.delete(id), size: () => m.size })
  return m
}

/** 一组对话 id（例如「正在复核的对话」） */
export function taskSet(owner: string): Set<string> {
  const s = new Set<string>()
  slots.push({ owner, forget: (id) => s.delete(id), size: () => s.size })
  return s
}

/** 自己管清理的状态：对话删掉时调 forget；不知道条数的 size 给 -1 */
export function onForgetTask(owner: string, forget: (taskId: string) => void, size: () => number = () => -1) {
  slots.push({ owner, forget, size })
}

/** 对话彻底删掉：所有登记过的按对话记的状态一起清 */
export function forgetTask(taskId: string) {
  for (const s of slots) s.forget(taskId)
}

/** 每一份现在有多少条（排查用） */
export function taskStateReport() {
  return slots.map((s) => ({ owner: s.owner, size: s.size() }))
}
