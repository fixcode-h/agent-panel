import { useSyncExternalStore } from 'react'
import type { PluginUpdate } from '@shared/plugins/version'
import { pluginApi } from './api'
import type { PluginRow } from './registry'

/**
 * 插件更新（设置 →「插件」）：只在用户点「刷新」时查（用户定的长期规则：拉 GitHub 只能手动，打开页面不自动查）。结果按插件 id 存着，装好新版本后按装着的版本自动去掉过期的提示。
 */
interface State {
  updates: Map<string, PluginUpdate>
  errors: { repo: string; error: string }[]
  checking: boolean
  checkedAt: string
  /** 「一键更新」里每个插件走到哪一步（按插件 id），卡片按它显示进度和失败原因；见 update-all.ts */
  bulk: Map<string, BulkStep>
}
export interface BulkStep {
  /** skipped：包装插件的权限变了或有新增中高级发现，一键更新跳过、要用户单独确认（ADR 0068） */
  status: 'waiting' | 'updating' | 'done' | 'failed' | 'skipped'
  /** 要升到的版本 */
  to: string
  error?: string
}
let state: State = { updates: new Map(), errors: [], checking: false, checkedAt: '', bulk: new Map() }
const subs = new Set<() => void>()
const emit = (next: Partial<State>) => {
  state = { ...state, ...next }
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}
/** 当前状态（React 外读，比如一键更新跑完后的测试） */
export const pluginUpdatesState = () => state
export const usePluginUpdates = () => useSyncExternalStore(subscribe, pluginUpdatesState)

export async function checkUpdates() {
  if (state.checking) return
  // 重新查更新时清掉上一轮一键更新留下的「已更新到」和失败原因，卡片按这次查到的结果重新显示；还在跑的不动
  const running = [...state.bulk.values()].some((s) => s.status === 'waiting' || s.status === 'updating')
  emit({ checking: true, ...(!running && { bulk: new Map() }) })
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

/** 一键更新改某个插件的进度；传 undefined 时清空全部（新一轮开始前） */
export function setBulkStep(id?: string, step?: BulkStep) {
  if (!id) return emit({ bulk: new Map() })
  emit({ bulk: new Map(state.bulk).set(id, step!) })
}
