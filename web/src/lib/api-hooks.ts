import type { HookDef, HookDefInput, HookEventName } from '@shared/hook-defs'
import { json, request } from './api'

/**
 * 设置页「钩子」的接口（server/hooks/api.ts）。单独一个文件：api.ts 到了行数上限。
 * 演示版没有后端，同样的路径交给 demo-hooks.ts 的模拟实现
 */
export interface BuiltinHookView {
  id: string
  event: HookEventName
  name: string
  description: string
  defaultOn: boolean
  on: boolean
}
export interface HooksView {
  builtins: BuiltinHookView[]
  hooks: HookDef[]
  support: { id: string; name: string; events: HookEventName[] }[]
}
export interface HookCheckView {
  errors: string[]
  warnings: string[]
}
export interface HookTestView extends HookCheckView {
  input: unknown
  out?: { block?: boolean; deny?: boolean; reason?: string; context?: string }
  error?: string
  ms: number
}
export interface HookTriggerView {
  at: string
  hookId: string
  name: string
  event: string
  taskId: string
  result: 'none' | 'block' | 'deny' | 'context' | 'error'
  detail: string
  ms: number
}

export const hooksApi = {
  list: () => request<HooksView>('/hooks'),
  setBuiltin: (id: string, on: boolean) => request<{ ok: true }>(`/hooks/builtins/${id}`, json('PUT', { on })),
  check: (def: HookDefInput, run = false) => request<HookCheckView>('/hooks/check', json('POST', { def, run })),
  test: (def: HookDefInput, input?: unknown) => request<HookTestView>('/hooks/test', json('POST', { def, input })),
  save: (def: HookDefInput) =>
    def.id
      ? request<{ hook: HookDef; warnings: string[] }>(`/hooks/${def.id}`, json('PUT', def))
      : request<{ hook: HookDef; warnings: string[] }>('/hooks', json('POST', def)),
  remove: (id: string) => request<{ ok: true }>(`/hooks/${id}`, { method: 'DELETE' }),
  order: (ids: string[]) => request<{ ok: true }>('/hooks/order', json('POST', { ids })),
  triggers: () => request<HookTriggerView[]>('/hooks/triggers'),
}
