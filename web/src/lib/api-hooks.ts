import type { HookDef, HookDefInput, HookEventName } from '@shared/hooks/defs'
import type { HookTier } from '@shared/hooks/builtins'
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
  /** 从哪一档开始开；老的服务端没有 */
  tier?: HookTier
  /** 这一层按档位该是什么（不看逐个改过的） */
  tierOn?: boolean
  /** 实际用的值：看的是某个项目时按那个项目算 */
  on: boolean
  globalOn: boolean
  /** 这个项目单独设的开关；没设（跟着全局）为 null */
  projectOn: boolean | null
  params: { key: string; kind: 'list' | 'number'; label: string; hint: string; value: string[] | number }[]
}
/** 开着的插件带的钩子：只能开关 */
export interface PluginHookView {
  id: string
  name: string
  description: string
  event: HookEventName
  /** 插件名 */
  plugin: string
  on: boolean
}
export interface HooksView {
  builtins: BuiltinHookView[]
  /** 全局档位、这个项目选的档位（没选为 null）、这一层逐个改过几个；老的服务端没有 */
  tier?: HookTier
  projectTier?: HookTier | null
  tierChanged?: number
  hooks: HookDef[]
  /** 老的服务端没有这个字段 */
  plugins?: PluginHookView[]
  support: {
    id: string
    name: string
    /** 本机检测到的版本；没检测到为空 */
    version?: string
    events: HookEventName[]
    /** 本机版本太老、装不上的事件和要多少版本 */
    tooOld: { event: HookEventName; min: string }[]
  }[]
  /** 按 CLI 关掉的事件 */
  cliOff: Record<string, HookEventName[]>
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
  list: (projectId = '') =>
    request<HooksView>(projectId ? `/hooks?projectId=${encodeURIComponent(projectId)}` : '/hooks'),
  /** projectId 给了是这个项目单独的开关；on 为 null 去掉单独的设置 */
  setBuiltin: (id: string, on: boolean | null, projectId = '') =>
    request<{ ok: true }>(`/hooks/builtins/${id}`, json('PUT', projectId ? { on, projectId } : { on })),
  /** projectId 给了是这个项目的档位；tier 为 null 表示项目跟随全局 */
  setTier: (tier: HookTier | null, projectId = '') =>
    request<{ ok: true }>('/hooks/tier', json('PUT', projectId ? { tier, projectId } : { tier })),
  setPlugin: (id: string, on: boolean) =>
    request<{ ok: true }>(`/hooks/plugins/${encodeURIComponent(id)}`, json('PUT', { on })),
  setCliOff: (cli: string, events: HookEventName[]) =>
    request<{ ok: true }>(`/hooks/cli-off/${cli}`, json('PUT', { events })),
  setParam: (id: string, key: string, value: string[] | number) =>
    request<{ ok: true }>(`/hooks/builtins/${id}/params`, json('PUT', { key, value })),
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
