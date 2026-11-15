import type { z } from 'zod'
import type { HookDefInput, HookEventName } from '@shared/hooks/defs'
import type { HookTier } from '@shared/hooks/builtins'
import {
  hooksContract as H,
  type BuiltinHookView as BuiltinHookViewSchema,
  type HookCheckView as HookCheckViewSchema,
  type HookTestView as HookTestViewSchema,
  type HookTriggerView as HookTriggerViewSchema,
  type HooksView as HooksViewSchema,
  type PluginHookView as PluginHookViewSchema,
} from '@shared/api-contract/hooks'
import { call } from './api/call'

/**
 * 设置页「钩子」的接口（server/hooks/api.ts），按 shared/api-contract/hooks.ts 的契约调。单独一个文件：api.ts 到了行数上限。
 * 演示版没有后端，同样的路径交给 demo-hooks.ts 的模拟实现
 */
export type BuiltinHookView = z.infer<typeof BuiltinHookViewSchema>
/** 开着的插件带的钩子：只能开关 */
export type PluginHookView = z.infer<typeof PluginHookViewSchema>
export type HooksView = z.infer<typeof HooksViewSchema>
export type HookCheckView = z.infer<typeof HookCheckViewSchema>
export type HookTestView = z.infer<typeof HookTestViewSchema>
export type HookTriggerView = z.infer<typeof HookTriggerViewSchema>

export const hooksApi = {
  list: (projectId = '') => call(H.list, { query: { projectId } }),
  /** projectId 给了是这个项目单独的开关；on 为 null 去掉单独的设置 */
  setBuiltin: (id: string, on: boolean | null, projectId = '') =>
    call(H.setBuiltin, { params: { id }, body: projectId ? { on, projectId } : { on } }),
  /** projectId 给了是这个项目的档位；tier 为 null 表示项目跟随全局 */
  setTier: (tier: HookTier | null, projectId = '') =>
    call(H.setTier, { body: projectId ? { tier, projectId } : { tier } }),
  setPlugin: (id: string, on: boolean) => call(H.setPlugin, { params: { id }, body: { on } }),
  setCliOff: (cli: string, events: HookEventName[]) => call(H.setCliOff, { params: { cli }, body: { events } }),
  setParam: (id: string, key: string, value: string[] | number) =>
    call(H.setParam, { params: { id }, body: { key, value } }),
  check: (def: HookDefInput, run = false) => call(H.check, { body: { def, run } }),
  test: (def: HookDefInput, input?: unknown) => call(H.test, { body: { def, input } }),
  save: (def: HookDefInput) =>
    def.id ? call(H.update, { params: { id: def.id }, body: def }) : call(H.create, { body: def }),
  remove: (id: string) => call(H.remove, { params: { id } }),
  order: (ids: string[]) => call(H.order, { body: { ids } }),
  triggers: () => call(H.triggers),
}
