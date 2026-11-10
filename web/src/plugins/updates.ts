import { useSyncExternalStore } from 'react'
import type { PluginUpdate } from '@shared/plugins/version'
import { pluginApi } from './api'
import type { PluginRow } from './registry'

/**
 * 插件更新（设置 →「插件」）：打开插件页时自动查一次，之后十分钟内不重复查（GitHub 匿名请求有限流），
 * 点「检查更新」随时重查。结果按插件 id 存着，装好新版本后按装着的版本自动去掉过期的提示。
 */
interface State {
  updates: Map<string, PluginUpdate>
  errors: { repo: string; error: string }[]
  checking: boolean
  checkedAt: string
}
let state: State = { updates: new Map(), errors: [], checking: false, checkedAt: '' }
const subs = new Set<() => void>()
const emit = (next: Partial<State>) => {
  state = { ...state, ...next }
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}
export const usePluginUpdates = () => useSyncExternalStore(subscribe, () => state)

const AUTO_MS = 10 * 60_000

/** 有没有能查更新的插件（只有从 GitHub 装的才有上游） */
export const canCheck = (rows: PluginRow[]) => rows.some((r) => r.source.kind === 'github')

export async function checkUpdates(opts: { auto?: boolean } = {}) {
  if (state.checking) return
  if (opts.auto && state.checkedAt && Date.now() - Date.parse(state.checkedAt) < AUTO_MS) return
  emit({ checking: true })
  try {
    const r = await pluginApi.updates()
    emit({ updates: new Map(r.updates.map((u) => [u.id, u])), errors: r.errors, checkedAt: r.checkedAt })
  } catch (e) {
    emit({ errors: [{ repo: '', error: (e as Error).message }], checkedAt: new Date().toISOString() })
  } finally {
    emit({ checking: false })
  }
}

/** 装着的版本变了（升级、重装、删掉）就去掉这条提示 */
export function pruneUpdates(rows: PluginRow[]) {
  const next = new Map(
    [...state.updates].filter(([id, u]) => rows.find((r) => r.manifest.id === id)?.manifest.version === u.current),
  )
  if (next.size !== state.updates.size) emit({ updates: next })
}
