/**
 * 对话右栏的网页页签（设计稿第 6 节）：按对话记着开了哪些网页、哪个在前面。
 *
 * 只存在这台浏览器里（localStorage，按对话），不进 Task：开过哪些网页是看的人自己的事，不是对话的数据。
 * 打开网页的入口都走 openWebTab：回复里的 HTML 卡片（W2）、回复里点链接、地址栏、插件声明的网页（W3）。
 * 打开时把右栏切到这个页签，右栏收着的话展开（useWebTabFocus 由对话页接上）。
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'

export type WebTarget =
  /**
   * 本机文件。taskId：按哪个对话的目录找（子对话的文件开在父对话右栏时，子对话在自己的独立分支目录里，
   * 要按子对话找）；不给就按右栏所在的对话
   */
  | { kind: 'file'; path: string; taskId?: string }
  | { kind: 'url'; url: string }
  /** 插件包里的文件（插件接口 11 的 webPages 写 file:…） */
  | { kind: 'plugin-file'; plugin: string; path: string }
  /** 插件托管进程的页面（webPages 写 service:<进程 id>/<路径>）：打开时没起就起 */
  | { kind: 'plugin-service'; plugin: string; service: string; path: string }

export interface WebTab {
  id: string
  target: WebTarget
  /** 页签上的名字：文件名或域名；页面自己的标题读不到（跨源） */
  title: string
  /** 地址栏里走过的地址（后退、前进用）：iframe 里自己点的链接跨源读不到，不算 */
  back: WebTarget[]
  forward: WebTarget[]
  /** 阅读模式开着 */
  reader?: boolean
}

interface WebState {
  tabs: WebTab[]
  /** 最后一次打开或切到的页签 */
  active: string
  /** 每次 openWebTab 加一：对话页据此展开右栏、切到页签 */
  focus: number
  /** 右栏当前显示的是不是网页页签（TaskFiles 报上来）：右栏据此放宽 */
  shown: string
}

const EMPTY: WebState = { tabs: [], active: '', focus: 0, shown: '' }
const KEY = (taskId: string) => `web-tabs:${taskId}`
/** 一个对话最多开这么多网页页签：再多就关掉最早的 */
const MAX_TABS = 8

// 模块状态：运行时，按对话缓存 localStorage 里的那份；刷新页面后从 localStorage 读回
const states = new Map<string, WebState>()
// 模块状态：运行时，订阅者（useSyncExternalStore），组件卸载时自己退订
const listeners = new Set<() => void>()

function read(taskId: string): WebState {
  const hit = states.get(taskId)
  if (hit) return hit
  let tabs: WebTab[] = []
  try {
    const raw = JSON.parse(localStorage.getItem(KEY(taskId)) ?? 'null') as { tabs?: WebTab[]; active?: string } | null
    tabs = Array.isArray(raw?.tabs) ? raw.tabs.filter((x) => x && x.id && x.target) : []
    const s = { ...EMPTY, tabs, active: raw?.active ?? '' }
    states.set(taskId, s)
    return s
  } catch {
    states.set(taskId, EMPTY)
    return EMPTY
  }
}

function write(taskId: string, next: WebState) {
  states.set(taskId, next)
  try {
    if (next.tabs.length)
      localStorage.setItem(KEY(taskId), JSON.stringify({ tabs: next.tabs.map(stripReader), active: next.active }))
    else localStorage.removeItem(KEY(taskId))
  } catch {}
  for (const fn of listeners) fn()
}

/** 阅读模式不跨刷新记：重新打开时先按原网页试一次 */
const stripReader = (x: WebTab) => ({ ...x, reader: undefined })

/** 地址栏里显示的那一串，也用来判断是不是同一个目标 */
export function targetAddress(target: WebTarget) {
  if (target.kind === 'file') return target.path
  if (target.kind === 'url') return target.url
  if (target.kind === 'plugin-file') return `plugin:${target.plugin}/${target.path}`
  return `service:${target.plugin}/${target.service}/${target.path}`
}

export const sameTarget = (a: WebTarget, b: WebTarget) => a.kind === b.kind && targetAddress(a) === targetAddress(b)

export function targetTitle(target: WebTarget) {
  if (target.kind === 'file' || target.kind === 'plugin-file') return target.path.split(/[\\/]/).pop() || target.path
  if (target.kind === 'plugin-service') return `${target.plugin} · ${target.service}`
  try {
    return new URL(target.url).hostname || target.url
  } catch {
    return target.url
  }
}

/** 打开一个网页：已经开着同一个就切过去，否则新开；都会让右栏切到它 */
export function openWebTab(taskId: string, target: WebTarget, opts: { title?: string } = {}) {
  const cur = read(taskId)
  const had = cur.tabs.find((x) => sameTarget(x.target, target))
  const id = had?.id ?? `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const tabs = had
    ? cur.tabs
    : [...cur.tabs, { id, target, title: opts.title || targetTitle(target), back: [], forward: [] }].slice(-MAX_TABS)
  // shown 也先记上：右栏收着时 TaskFiles 还没挂上，挂上后照它停在这个页签
  write(taskId, { ...cur, tabs, active: id, shown: id, focus: cur.focus + 1 })
  return id
}

export function closeWebTab(taskId: string, id: string) {
  const cur = read(taskId)
  const tabs = cur.tabs.filter((x) => x.id !== id)
  write(taskId, {
    ...cur,
    tabs,
    active: cur.active === id ? (tabs[tabs.length - 1]?.id ?? '') : cur.active,
    shown: cur.shown === id ? '' : cur.shown,
  })
}

/** 地址栏换地址：记进后退列表 */
export function navigateWebTab(taskId: string, id: string, target: WebTarget) {
  patch(taskId, id, (x) =>
    sameTarget(x.target, target)
      ? x
      : {
          ...x,
          target,
          title: targetTitle(target),
          back: [...x.back, x.target].slice(-30),
          forward: [],
          reader: false,
        },
  )
}

export function stepWebTab(taskId: string, id: string, dir: 'back' | 'forward') {
  patch(taskId, id, (x) => {
    const from = dir === 'back' ? x.back : x.forward
    const to = from[from.length - 1]
    if (!to) return x
    const rest = from.slice(0, -1)
    const other = [...(dir === 'back' ? x.forward : x.back), x.target]
    return dir === 'back'
      ? { ...x, target: to, title: targetTitle(to), back: rest, forward: other, reader: false }
      : { ...x, target: to, title: targetTitle(to), forward: rest, back: other, reader: false }
  })
}

export function setWebReader(taskId: string, id: string, reader: boolean) {
  patch(taskId, id, (x) => ({ ...x, reader }))
}

/** 右栏切到哪个页签：网页页签的 id，或者空（切到了文件、子对话这类别的页签） */
export function setWebShown(taskId: string, id: string) {
  const cur = read(taskId)
  if (cur.shown === id && (!id || cur.active === id)) return
  write(taskId, { ...cur, shown: id, active: id || cur.active })
}

function patch(taskId: string, id: string, fn: (x: WebTab) => WebTab) {
  const cur = read(taskId)
  write(taskId, { ...cur, tabs: cur.tabs.map((x) => (x.id === id ? fn(x) : x)) })
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useWebTabs(taskId: string): WebState {
  return useSyncExternalStore(
    subscribe,
    () => (taskId ? read(taskId) : EMPTY),
    () => EMPTY,
  )
}

/** 有新的 openWebTab 时调一次 fn（对话页用它展开右栏）；挂上时已有的那次不算 */
export function useWebTabFocus(taskId: string, fn: () => void) {
  const { focus } = useWebTabs(taskId)
  const seen = useRef(focus)
  const call = useRef(fn)
  call.current = fn
  useEffect(() => {
    if (focus === seen.current) return
    seen.current = focus
    call.current()
  }, [focus])
}

/**
 * 回复里打开网页要知道开到哪个对话的右栏：对话页提供（子对话放在父对话右栏里时开到父对话那边）。
 * 没有提供的地方（设置里的示例、AI 窗口以外的弹窗）点链接照浏览器默认的来
 */
export const WebHostCtx = createContext<{ taskId: string; projectId?: string } | null>(null)
export const useWebHost = () => useContext(WebHostCtx)

const READER_KEY = 'web-reader-sites'

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function readerSites(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(READER_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 被拒页上勾了「以后直接用阅读模式打开」的站点：只记在这台浏览器里 */
export const prefersReader = (url: string) => {
  const h = hostOf(url)
  return !!h && readerSites().includes(h)
}

export function setPrefersReader(url: string, on: boolean) {
  const h = hostOf(url)
  if (!h) return
  const next = readerSites().filter((x) => x !== h)
  try {
    localStorage.setItem(READER_KEY, JSON.stringify(on ? [...next, h] : next))
  } catch {}
}

/**
 * 面板浏览器扩展里开了「允许嵌入」的站点（extension/embed.js 写在 <html data-ap-embed-sites> 上）：
 * 扩展会给面板页签里的这些站点去掉 X-Frame-Options / CSP，服务端预检说不许嵌也照样开 iframe
 */
export function extensionAllows(url: string) {
  const h = hostOf(url)
  const list = (document.documentElement.dataset.apEmbedSites ?? '').split(/\s+/).filter(Boolean)
  return !!h && list.some((s) => h === s || h.endsWith(`.${s}`))
}

/** 装没装能「允许嵌入」的那版扩展 */
export const extensionEmbedReady = () => document.documentElement.dataset.apEmbedSites !== undefined
