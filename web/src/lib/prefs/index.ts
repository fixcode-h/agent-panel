import { useSyncExternalStore } from 'react'

/**
 * 本机偏好（可统一能力盘点第 12 项，开放给插件）：界面记在浏览器 localStorage 里的东西（拖过的尺寸、折叠、页签、筛选……）
 * 读写只走这里，并按「族」登记（一个固定的键，或一个前缀下的一组键），设置 → 外观 →「界面状态」据此列出、按项重置。
 *
 * 以前约 180 处直接读写 localStorage，每处自己 try/catch，键名没有统一前缀，用户拖乱了也没处重置。
 * - local.*：带兜底的读写（隐私模式下访问 localStorage 都会抛错），写了通知订阅方（设置页的列表跟着变）。
 * - registerPrefs：登记族；插件在网页激活时登记自己的（例如 UE 的 `ue:` 前缀），返回撤销函数。
 */

export type PrefGroup = 'layout' | 'view' | 'settings' | 'other'

export interface PrefFamily {
  /** 唯一 id（插件的带插件前缀） */
  id: string
  /** 固定的键 */
  key?: string
  /** 一组键的前缀（`pane:`、`ue:`） */
  prefix?: string
  /** 给人看的名字（已经翻译好的，或返回翻译的函数） */
  label: string | (() => string)
  /**
   * layout：尺寸、折叠；view：页签、筛选、排序这类「看什么」；settings：主题、语言这类真正的设置（「全部重置」不碰）；other：其余
   */
  group: PrefGroup
  /** 哪个插件登记的（设置页显示来源） */
  owner?: string
}

const families = new Map<string, PrefFamily>() // 模块状态：运行时，页面加载时登记
const listeners = new Set<() => void>() // 模块状态：运行时，订阅方自己撤
let version = 0 // 模块状态：运行时，每次写都加一，设置页据此刷新

function bump() {
  version++
  for (const f of listeners) f()
}

function store(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** 带兜底的 localStorage：读不到给 null / 默认值，写不进去就算了（不影响页面） */
export const local = {
  get(key: string): string | null {
    try {
      return store()?.getItem(key) ?? null
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      store()?.setItem(key, value)
      bump()
    } catch {
      // 满了、被禁用：这次不记
    }
  },
  remove(key: string) {
    try {
      store()?.removeItem(key)
      bump()
    } catch {
      // 同上
    }
  },
  json<T>(key: string, fallback: T): T {
    const raw = local.get(key)
    if (raw === null) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },
  setJson(key: string, value: unknown) {
    local.set(key, JSON.stringify(value))
  },
  /** 现在存着的所有键 */
  keys(): string[] {
    const s = store()
    if (!s) return []
    try {
      return Array.from({ length: s.length }, (_, i) => s.key(i)).filter((k): k is string => k !== null)
    } catch {
      return []
    }
  },
}

/** 登记一组族；返回撤销函数（插件停用时） */
export function registerPrefs(list: PrefFamily[]): () => void {
  for (const f of list) families.set(f.id, f)
  bump()
  return () => {
    for (const f of list) if (families.get(f.id) === f) families.delete(f.id)
    bump()
  }
}

export const prefFamilies = () => [...families.values()]

export const prefLabel = (f: PrefFamily) => (typeof f.label === 'function' ? f.label() : f.label)

/** 这个族现在存着的键；有更具体的族（更长的前缀、固定键）认领的键不算进来 */
export function storedKeys(f: PrefFamily, keys = local.keys()): string[] {
  return keys.filter((k) => ownerOf(k) === f)
}

/** 一个键归哪个族：固定键优先，其次最长的前缀 */
export function ownerOf(key: string): PrefFamily | undefined {
  let best: PrefFamily | undefined
  for (const f of families.values()) {
    if (f.key === key) return f
    if (f.prefix && key.startsWith(f.prefix) && (!best?.prefix || f.prefix.length > best.prefix.length)) best = f
  }
  return best
}

/** 重置一个族：删掉它存着的键，页面刷新后回到默认 */
export function resetPrefs(f: PrefFamily) {
  for (const k of storedKeys(f)) local.remove(k)
}

/** 设置页用：存着的东西变了就重画 */
export function usePrefsVersion() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => version,
    () => version,
  )
}
