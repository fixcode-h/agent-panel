import { useCallback, useSyncExternalStore } from 'react'
import type { Task } from '@shared/schema'
import { childRow } from '@shared/children/row'
import { api } from '@/lib/api'

/**
 * 父对话名下的工作流运行（不是子对话，见 shared/flow/run.ts）：运行区的工作流卡片和右栏都要它，
 * 按父对话共用一份、一个轮询，有人看时每 3 秒刷新（只是一次过滤后的列表查询），没人看就停
 */
const POLL_MS = 3000
const EMPTY: Task[] = []
type Entry = { list: Task[]; sig: string; subs: Set<() => void>; timer?: ReturnType<typeof setInterval> }
const store = new Map<string, Entry>()

async function load(id: string) {
  const e = store.get(id)
  const list = await api.flowRuns(id).catch(() => null)
  if (!e || !list) return
  // 内容没变不换引用：卡片不用跟着轮询重画
  const sig = JSON.stringify(list.map((x) => [x.id, x.updatedAt, x.status]))
  if (sig === e.sig) return
  e.list = list
  e.sig = sig
  for (const f of e.subs) f()
}

/** 点了确认、暂停、重启之后马上刷新，不等下一次轮询 */
export const reloadOwnedRuns = (ownerId: string) => load(ownerId)

/** ownerId 为空表示不需要（子对话、Chat、不是最新一轮）：不订阅也不轮询 */
export function useOwnedRuns(ownerId: string): Task[] {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!ownerId) return () => {}
      const e = store.get(ownerId) ?? store.set(ownerId, { list: EMPTY, sig: '', subs: new Set() }).get(ownerId)!
      e.subs.add(cb)
      if (!e.timer) {
        void load(ownerId)
        e.timer = setInterval(() => void load(ownerId), POLL_MS)
      }
      return () => {
        e.subs.delete(cb)
        if (!e.subs.size) {
          clearInterval(e.timer)
          e.timer = undefined
        }
      }
    },
    [ownerId],
  )
  return useSyncExternalStore(subscribe, () => (ownerId ? (store.get(ownerId)?.list ?? EMPTY) : EMPTY))
}

/**
 * 名下运行画成子对话列表的一行：右栏「工作流运行」页签的 ▾ 和子对话页签一样列出来切换（用户 2026-11-15 要求）。
 * 运行不是对话进程，没有 CLI 存活、后台命令、独立分支核对这些，按「没有」给
 */
export const ownedRunRow = (x: Task) => {
  const row = childRow(x, {
    cliAlive: false,
    background: 0,
    childNeeds: 0,
    worktree: { checked: false, value: null },
    full: true,
    lastReply: '',
    stopReason: x.stopReason,
  })
  // 和子对话列表一样：没停下原因时是 undefined，不是空字符串（task-view-children.ts）
  return { ...row, stopReason: row.stopReason || undefined }
}
