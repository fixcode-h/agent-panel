import { useSyncExternalStore } from 'react'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import { extendDict, getLang } from '@shared/i18n'
import { setEnabledPlugins, setInstalledPlugins } from '@shared/plugins/index'
import type { PluginConfig, PluginInfo } from '@shared/plugins/types'
import { taskPlugin } from '@shared/task'
import type { Task } from '@shared/schema'
import { request } from '@/lib/api'
import { pickFileViewer } from './file-viewers'
import { pruneUpdates } from './updates'
import type { ActivateWeb, DesignMode, PluginPage, TaskTab, WebPlugin } from './sdk'

/**
 * 网页里的插件（ADR 0059）：启动时读 /api/plugins，把清单交给共享层（内置列表、工具名按它算），
 * 开着的插件 import 包里的 web 入口、调 activate，登记它给的设计模式、右栏页签和状态面板。
 * 插件关掉、删除后从这里撤掉（已经加载的模块留在内存里，不再用到），重新打开时不用刷新页面。
 */
export interface PluginRow extends PluginInfo {
  enabled: boolean
  config: PluginConfig
}

interface State {
  rows: PluginRow[]
  broken: { id: string; error: string }[]
  market: string
  web: Map<string, WebPlugin>
  /** 网页入口加载出错 */
  webErrors: Map<string, string>
  loaded: boolean
}
let state: State = { rows: [], broken: [], market: '', web: new Map(), webErrors: new Map(), loaded: false }
const subs = new Set<() => void>()
const emit = (next: Partial<State>) => {
  state = { ...state, ...next }
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

export const usePlugins = () => useSyncExternalStore(subscribe, () => state)

/** 已经 import 过的入口（同一个地址不重复加载，地址里带安装时间，升级后是新地址） */
const loadedUrls = new Map<string, WebPlugin>()

async function exposeHost() {
  // 插件构建时把 react 系的 import 换成从这里取，和面板共用一份 React；
  // 开放给插件的面板模块（插件接口 4，host-modules.ts）同样挂在这，插件的 import 在入口执行时就要取到
  const g = globalThis as { __agentPanel?: Record<string, unknown> & { modules?: Record<string, object> } }
  const p = (g.__agentPanel ??= { React, ReactDOM, jsxRuntime })
  p.modules ??= await (await import('./host-modules')).loadHostModules()
}

async function activate(row: PluginRow): Promise<WebPlugin | undefined> {
  if (!row.webUrl) return undefined
  const hit = loadedUrls.get(row.webUrl)
  if (hit) return hit
  await exposeHost()
  if (row.cssUrl && !document.querySelector(`link[data-plugin="${row.manifest.id}"][href="${row.cssUrl}"]`)) {
    document.querySelectorAll(`link[data-plugin="${row.manifest.id}"]`).forEach((l) => l.remove())
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = row.cssUrl
    link.dataset.plugin = row.manifest.id
    document.head.appendChild(link)
  }
  const mod = (await import(/* @vite-ignore */ row.webUrl)) as { default?: ActivateWeb }
  if (typeof mod.default !== 'function') throw new Error('网页入口没有默认导出 activate')
  const { host } = await import('./host')
  const plugin = await mod.default(host(row.manifest.id, () => currentConfig(row.manifest.id)))
  loadedUrls.set(row.webUrl, plugin)
  return plugin
}

const currentConfig = (id: string) => state.rows.find((r) => r.manifest.id === id)?.config ?? {}

/** 读过英文文案的包（按地址，升级后地址变了会重读） */
const loadedDicts = new Set<string>()

/** 包里的英文文案：关着的插件也要读，插件页上的参数名、说明才有英文 */
async function loadDict(row: PluginRow) {
  if (getLang() !== 'en') return
  const key = `${row.manifest.id}@${row.installedAt}`
  if (loadedDicts.has(key)) return
  loadedDicts.add(key)
  const dict = await fetch(`/api/plugins/${encodeURIComponent(row.manifest.id)}/files/locales/en.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  if (dict) extendDict('en', dict)
}

/** 读一遍插件列表：共享层同步，开着的加载网页部分，关掉的撤下 */
export async function loadPlugins() {
  const r = await request<{ plugins: PluginRow[]; broken: State['broken']; market: string }>('/plugins')
  setInstalledPlugins(r.plugins.map((p) => p.manifest))
  setEnabledPlugins(Object.fromEntries(r.plugins.map((p) => [p.manifest.id, { enabled: p.enabled, config: p.config }])))
  const web = new Map<string, WebPlugin>()
  const webErrors = new Map<string, string>()
  await Promise.all(r.plugins.map(loadDict))
  for (const row of r.plugins.filter((p) => p.enabled)) {
    try {
      const p = await activate(row)
      if (p) web.set(row.manifest.id, p)
    } catch (e) {
      webErrors.set(row.manifest.id, (e as Error).message)
    }
  }
  emit({ rows: r.plugins, broken: r.broken, market: r.market, web, webErrors, loaded: true })
  pruneUpdates(r.plugins)
}

/** 所有开着的插件登记的设计模式 */
export const designModes = (s: State = state): DesignMode[] => [...s.web.values()].flatMap((p) => p.designModes ?? [])
export const useDesignModes = () => designModes(usePlugins())

/** 对话归开着的插件的设计模式（侧栏的项目对话、项目首页不列它，打开时进设计模式）；插件不在时当普通对话 */
export const ownedDesign = (task: Pick<Task, 'plugin' | 'modelDesign'>, modes: DesignMode[] = designModes()) => {
  const id = taskPlugin(task)
  return id ? modes.find((m) => m.id === id) : undefined
}

/** 开着的插件登记的整页（图标栏里的格子）：带上插件 id，地址 #/plugin/<插件>/<页面> */
type OwnedPage = PluginPage & { plugin: string }
const pluginPages = (s: State = state): OwnedPage[] =>
  [...s.web.entries()].flatMap(([plugin, p]) => (p.pages ?? []).map((x) => ({ ...x, plugin })))
export const usePluginPages = (): OwnedPage[] => pluginPages(usePlugins())

/** 对话归开着的插件的整页（PluginPage.taskPlugin，例如 Blender 的模型设计页）；插件不在时当普通对话 */
export const ownedPage = (task: Pick<Task, 'plugin' | 'modelDesign'>, pages: OwnedPage[] = pluginPages()) => {
  const id = taskPlugin(task)
  return id ? pages.find((p) => p.taskPlugin === id) : undefined
}

/** 归整页管的对话在哪打开：#/plugin/<插件>/<页面>/<对话 id> */
export const ownedPageRoute = (page: OwnedPage, taskId: string) => ({
  page: 'plugin' as const,
  id: page.plugin,
  sub: page.id,
  msg: taskId,
})

/**
 * 对话归插件管（设计模式或插件整页）：Agent 项目的对话列表、Chat 列表都不列它，在插件那边看。
 * 返回判断函数，列表筛选时逐个调
 */
export const useOwnedByPlugin = () => {
  const s = usePlugins()
  const modes = designModes(s)
  const pages = pluginPages(s)
  return (task: Pick<Task, 'plugin' | 'modelDesign'>) => !!ownedDesign(task, modes) || !!ownedPage(task, pages)
}

/** 这个对话右栏多出来的页签 */
export const useTaskTabs = (task: Task | undefined): TaskTab[] => {
  const s = usePlugins()
  return task ? [...s.web.values()].flatMap((p) => p.taskTabs ?? []).filter((x) => x.when(task)) : []
}

/** 开着的插件里能看这个文件的查看器（按扩展名）；没有就照面板原来的规则打开 */
export const fileViewerFor = (path: string, s: State = state) => pickFileViewer(s.web.entries(), path)
