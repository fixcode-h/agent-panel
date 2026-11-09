import type { Settings } from '../schema.ts'
import { BLENDER_PLUGIN } from './blender/manifest.ts'
import type { PluginConfig, PluginManifest } from './types.ts'

export type { PluginConfig, PluginManifest, PluginSetting } from './types.ts'

/**
 * 随面板发布的插件（ADR 0059）。插件默认全关，用户在设置 →「插件」里打开。
 * 新插件：在 shared/plugins/<id>/ 写清单并加进这里，服务端部分登记到 server/plugins/index.ts，界面部分登记到 web/src/plugins/index.ts。
 */
export const PLUGINS: PluginManifest[] = [BLENDER_PLUGIN]

export const pluginById = (id: string) => PLUGINS.find((p) => p.id === id)

type PluginsSetting = Settings['plugins']

/** 这个插件在设置里开着没有（没记录 = 关） */
export const pluginOn = (plugins: PluginsSetting | undefined, id: string) => !!plugins?.[id]?.enabled

/** 参数：设置里存的值，缺的、类型不对的按声明的默认值补齐 */
export function pluginConfig(plugins: PluginsSetting | undefined, id: string): PluginConfig {
  const m = pluginById(id)
  const saved = plugins?.[id]?.config ?? {}
  const out: PluginConfig = {}
  for (const s of m?.settings() ?? []) {
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
let enabled = new Set<string>()

export function setEnabledPlugins(plugins: PluginsSetting | undefined) {
  enabled = new Set(PLUGINS.filter((p) => pluginOn(plugins, p.id)).map((p) => p.id))
}

export const pluginEnabled = (id: string) => enabled.has(id)
export const activePlugins = () => PLUGINS.filter((p) => enabled.has(p.id))

/** 开着的插件里有没有这个界面入口 */
export const pluginFeature = (feature: string) => activePlugins().some((p) => p.features.includes(feature))

/** 这个技能是哪个插件带来的（核心技能返回 undefined） */
export const skillPlugin = (name: string) => PLUGINS.find((p) => p.skills.includes(name))

/** 这个内置角色 / 工作流 key 是哪个插件带来的 */
export const agentPlugin = (key: string) => PLUGINS.find((p) => p.agents.some((a) => a.key === key))
export const workflowPlugin = (key: string) => PLUGINS.find((p) => p.workflows.some((w) => w.key === key))

/** 所有插件（不论开没开）的技能触发说明：已经装着的技能照样要说清什么时候用 */
export const pluginSkillGuide = (name: string) => PLUGINS.find((p) => p.skillGuide?.[name])?.skillGuide?.[name]

/** MCP 服务名属于哪个插件（对话里工具那一行按它显示中文名） */
export const mcpPlugin = (server: string) => PLUGINS.find((p) => p.mcpServers.includes(server))
