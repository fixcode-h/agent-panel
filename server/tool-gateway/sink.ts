/**
 * 这次调用里各钩子做了什么：守卫谁拒绝的、补充说明来自哪些钩子。钩子不认识网关，它们照旧记「最近触发」（server/hooks/run.ts 的 noteTrigger），
 * noteTrigger 顺手交到这里；网关在处理一次钩子时开一个收集器（AsyncLocalStorage），同一时刻几个并行的工具调用各收各的，不串
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface CallSink {
  pushes: { id: string; chars: number }[]
  denyBy?: string
}

const als = new AsyncLocalStorage<CallSink>()

export function withSink<T>(sink: CallSink, fn: () => Promise<T>): Promise<T> {
  return als.run(sink, fn)
}

/** 由 noteTrigger 调：不在网关处理的钩子里（结束前、后台命令守卫）时什么都不做 */
export function noteToSink(hookId: string, result: string, detail: string) {
  const s = als.getStore()
  if (!s) return
  if (result === 'deny' || result === 'block') s.denyBy ??= hookId
  else if (result === 'context') s.pushes.push({ id: hookId, chars: detail.length })
}
