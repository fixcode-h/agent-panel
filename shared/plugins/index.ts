import { base } from '../builtin/agents.ts'
import { t } from '../i18n.ts'
import type { Settings } from '../schema.ts'
import type { PluginConfig, PluginManifest } from './types.ts'

export type { PluginConfig, PluginInfo, PluginManifest, PluginSetting, PluginSource } from './types.ts'

/**
 * 本机装着的插件（ADR 0059）。插件装在数据目录 plugins/<id>/，服务端启动和安装、删除时用 setInstalledPlugins 更新，
 * 网页拿到 /api/plugins 时更新。插件默认关着，在设置 →「插件」里打开。
 * 这里只放按清单就能算的东西（参数默认值、开着的插件带了哪些角色、工作流、技能说明、工具名），前后端共用。
 */
let installed: PluginManifest[] = [] // 模块状态：配置副本，重启时重读
let enabled = new Set<string>() // 模块状态：配置副本，重启时重读

/** 插件清单里的角色只写了和默认值不同的字段：按内置角色的默认值补齐（和核心内置角色同一个 base） */
function normalize(m: PluginManifest): PluginManifest {
  return {
    ...m,
    agents: m.agents.map((a) => {
      const { mounts, ...agent } = a.agent as typeof a.agent & { mounts?: [] }
      return base(a.key, a.category, { ...agent, mounts: a.mounts ?? mounts ?? [] }, a.includes ?? ['rules'])
    }),
  }
}

export function setInstalledPlugins(list: PluginManifest[]) {
  installed = list.map(normalize)
}
export const installedPlugins = () => installed
export const pluginById = (id: string) => installed.find((p) => p.id === id)

type PluginsSetting = Settings['plugins']

/** 这个插件在设置里开着没有（没记录 = 关） */
export const pluginOn = (plugins: PluginsSetting | undefined, id: string) => !!plugins?.[id]?.enabled

/** 参数：设置里存的值，缺的、类型不对的按声明的默认值补齐 */
export function pluginConfig(plugins: PluginsSetting | undefined, id: string): PluginConfig {
  const saved = plugins?.[id]?.config ?? {}
  const out: PluginConfig = {}
  for (const s of pluginById(id)?.settings ?? []) {
    const v = saved[s.key]
    const ok =
      (s.type === 'boolean' && typeof v === 'boolean') ||
      (s.type === 'number' && typeof v === 'number' && Number.isFinite(v)) ||
      ((s.type === 'text' || s.type === 'path' || s.type === 'select') && typeof v === 'string')
    let value = ok ? v : s.default
    if (s.type === 'number' && typeof value === 'number') {
      if (s.min !== undefined) value = Math.max(s.min, value)
      if (s.max !== undefined) value = Math.min(s.max, value)
    }
    if (s.type === 'select' && s.options && !s.options.some((o) => o.value === value)) value = s.default
    out[s.key] = value
  }
  return out
}

/**
 * 当前开着的插件。服务端读设置、存设置时更新，网页拿到设置时更新；
 * 内置角色 / 工作流 / 技能列表、工具显示名都按它取，免得把设置一路传进每个函数。
 */
let lastSetting: PluginsSetting | undefined // 模块状态：配置副本，重启时重读
export function setEnabledPlugins(plugins: PluginsSetting | undefined) {
  lastSetting = plugins
  enabled = new Set(installed.filter((p) => pluginOn(plugins, p.id)).map((p) => p.id))
}
/** 装的插件变了：按上次的设置重算哪些开着 */
export function refreshEnabledPlugins() {
  setEnabledPlugins(lastSetting)
}

export const pluginEnabled = (id: string) => enabled.has(id)
/** 开着的插件现在的参数（按上次拿到的设置算）：插件测试步骤换 {config.xxx} 用 */
export const activePluginConfig = (id: string) => pluginConfig(lastSetting, id)
export const activePlugins = () => installed.filter((p) => enabled.has(p.id))

/** 这个内置角色 / 工作流 key 是哪个插件带来的 */
export const agentPlugin = (key: string) => installed.find((p) => p.agents.some((a) => a.key === key))
export const workflowPlugin = (key: string) => installed.find((p) => p.workflows.some((w) => w.key === key))

/** 装着的插件（不论开没开）的技能触发说明：已经装着的技能照样要说清什么时候用 */
export const pluginSkillGuide = (name: string) => installed.find((p) => p.skillGuide[name])?.skillGuide[name]

/** MCP 服务名属于哪个插件（对话里工具那一行按它显示名字） */
export const mcpPlugin = (server: string) => installed.find((p) => p.mcpServers.includes(server))

/** 所有装着的插件的工具显示名（界面语言） */
export const pluginToolNames = (p?: PluginManifest): Record<string, string> =>
  Object.fromEntries(
    (p ? [p] : installed).flatMap((x) => Object.entries(x.toolNames)).map(([k, v]) => [k, t(v)] as const),
  )
