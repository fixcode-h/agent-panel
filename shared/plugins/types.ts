import type { BuiltinAgent } from '../builtin/agents.ts'
import type { BuiltinWorkflow } from '../builtin/workflows.ts'

/**
 * 插件清单（ADR 0059）：一个插件是一组可以整体开关的能力。
 * 清单前后端共用，只放数据和纯函数；服务端部分在 server/plugins/<id>/，界面部分在 web/src/plugins/<id>/，
 * 非代码资产（技能目录、第三方运行时）在仓库根的 plugins/<id>/。
 * 核心代码只通过这里的字段和 server/plugins、web/src/plugins 的扩展点认识插件，不按插件 id 写分支。
 */

/** 插件参数的一项：插件页按声明生成表单，值存在 Settings.plugins[id].config[key] */
export interface PluginSetting {
  key: string
  type: 'text' | 'path' | 'number' | 'boolean' | 'select'
  /** 标题、说明（界面语言，清单里用 t() 写） */
  label: string
  desc?: string
  /** 表单里分组的小标题 */
  group?: string
  default: string | number | boolean
  /** select 的选项 */
  options?: { value: string; label: string }[]
  /** number 的范围和单位 */
  min?: number
  max?: number
  unit?: string
  placeholder?: string
  /** 对应的环境变量（插件页上作为提示显示，也方便排查） */
  env?: string
}

export type PluginConfigValue = string | number | boolean
export type PluginConfig = Record<string, PluginConfigValue>

export interface PluginManifest {
  id: string
  name: string
  version: string
  /** lucide 图标名，界面按名字换成组件 */
  icon: string
  /** 简介（界面语言） */
  description: () => string
  /** 来源：上游名字、链接、版本、许可 */
  source?: { name: string; url: string; version: string; license: string }
  /** 参数声明（标题要按当前界面语言取，所以是函数） */
  settings: () => PluginSetting[]
  /** 带的技能：文件在 plugins/<id>/skills/<分类>/<名字>/ */
  skills: string[]
  /** 技能的触发说明（拼进提示词的「什么时候用」，见 shared/skill-guide.ts） */
  skillGuide?: Record<string, string>
  /** 带的内置角色和工作流：和核心内置模板同一种写法，开着时并进内置列表 */
  agents: BuiltinAgent[]
  workflows: BuiltinWorkflow[]
  /** 给 Agent 的 MCP 服务名（对话里那一行按它认出是这个插件的工具）和工具的显示名 */
  mcpServers: string[]
  toolNames: () => Record<string, string>
  /** 界面入口开关（例如 modelDesign），web/src/plugins 按「插件开着且有这项」显示 */
  features: string[]
}
