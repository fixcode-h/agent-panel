import { z } from 'zod'
import type { BuiltinAgent } from '../builtin/agents.ts'
import type { BuiltinWorkflow } from '../builtin/workflows.ts'
import { PluginCommand, PluginHook, PluginTestStep } from './contrib-schema.ts'

/**
 * 插件清单（ADR 0059）：插件包根目录的 plugin.json。插件是自包含的包，装在数据目录 plugins/<id>/，
 * 核心代码只通过清单字段和插件 SDK（server/plugins/sdk.ts、web/src/plugins/sdk.ts）认识插件，不按插件 id 写分支，删掉插件面板照常工作。
 * 文案写中文原文，界面上用 t() 取，英文在包里的 locales/en.json。
 */

/** 插件参数的一项：插件页按声明生成表单，值存在 Settings.plugins[id].config[key] */
export const PluginSetting = z.object({
  key: z.string().min(1),
  type: z.enum(['text', 'path', 'number', 'boolean', 'select']),
  label: z.string(),
  desc: z.string().optional(),
  /** 表单里分组的小标题 */
  group: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]),
  /** select 的选项 */
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  /** number 的范围和单位 */
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().optional(),
  placeholder: z.string().optional(),
  /** 对应的环境变量（插件页上作为提示显示，方便排查） */
  env: z.string().optional(),
})
export type PluginSetting = z.infer<typeof PluginSetting>

export type PluginConfigValue = string | number | boolean
export type PluginConfig = Record<string, PluginConfigValue>

/** 角色、工作流按核心内置模板的写法（shared/builtin），角色设定里没写的字段按内置角色的默认值补 */
const BuiltinAgentJson = z
  .object({
    key: z.string().min(1),
    category: z.string(),
    includes: z.array(z.string()).optional(),
    mounts: z.array(z.record(z.string(), z.unknown())).optional(),
    agent: z.object({ name: z.string(), instructions: z.string() }).loose(),
  })
  .loose()
const BuiltinWorkflowJson = z
  .object({
    key: z.string().min(1),
    name: z.string(),
    main: z.string(),
    flows: z.array(z.unknown()),
  })
  .loose()

export const PluginManifest = z.object({
  /** 小写字母、数字和连字符：用作目录名、接口路径和设置里的键 */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().min(1),
  version: z.string().min(1),
  /** lucide 图标名，界面按名字换成组件，没有的用默认图标 */
  icon: z.string().default('puzzle'),
  description: z.string().default(''),
  author: z.string().optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  /** 搬进来的上游项目：名字、链接、版本、许可 */
  source: z.object({ name: z.string(), url: z.string(), version: z.string(), license: z.string() }).optional(),
  /** 要求的面板插件接口版本（PLUGIN_API），不兼容的不加载 */
  api: z.number().int().default(1),
  settings: z.array(PluginSetting).default([]),
  /** 带的技能（文件在包里 skills/<分类>/<名字>/）的触发说明：拼进提示词的「什么时候用」 */
  skillGuide: z.record(z.string(), z.string()).default({}),
  /** 用到这些技能的角色视为这个插件的角色（对话挂插件的工具时参考） */
  agents: z.array(BuiltinAgentJson).default([]),
  workflows: z.array(BuiltinWorkflowJson).default([]),
  /** 给 Agent 的 MCP 服务名（对话里那一行按它认出是这个插件的工具）和工具的显示名 */
  mcpServers: z.array(z.string()).default([]),
  toolNames: z.record(z.string(), z.string()).default({}),
  /**
   * 插件接口 3：钩子、测试步骤、「/」命令（格式见 contrib-schema.ts）。插件打开时装进面板已有的钩子、
   * 测试步骤和命令菜单，关掉、删除时一起撤掉（三处都按开着的插件现取，见 contrib.ts）
   */
  hooks: z.array(PluginHook).max(20).default([]),
  testSteps: z.array(PluginTestStep).max(20).default([]),
  commands: z.array(PluginCommand).max(50).default([]),
  /** 服务端入口、网页入口（相对包根的 ESM 文件），没有就是纯内容插件 */
  server: z.string().optional(),
  web: z.string().optional(),
  /** 网页入口的样式表 */
  css: z.string().optional(),
})
export type PluginManifest = Omit<z.infer<typeof PluginManifest>, 'agents' | 'workflows'> & {
  agents: BuiltinAgent[]
  workflows: BuiltinWorkflow[]
}

/**
 * 面板的插件接口版本：SDK 有新增或不兼容的改动时加一（插件清单的 api 不能大于它）。
 * 2：插件页面进图标栏（WebPlugin.pages）、对话的项目和目录（PluginRun.projectId / cwd / mode）、工具里请用户确认（McpCallContext.confirm）
 * 3：清单的 hooks / testSteps / commands 三段，服务端入口的 hook(id, input)；工具声明对项目做什么（McpTool.effect / targets），结果里报改了哪些文件、验证通过没有（McpResult.changed / verified）
 */
export const PLUGIN_API = 3

/** 插件从哪来 */
export const PluginSource = z.object({
  kind: z.enum(['github', 'zip', 'dir']),
  /** github：owner/repo；zip：上传的文件名；dir：本机目录（开发用，链接不复制） */
  ref: z.string(),
  /** github：分支、标签或 Release 名；仓库里插件所在的子目录 */
  tag: z.string().optional(),
  path: z.string().optional(),
})
export type PluginSource = z.infer<typeof PluginSource>

/** 服务端交给网页的插件信息：清单加上安装和运行状态 */
export interface PluginInfo {
  manifest: PluginManifest
  /** 包里的技能名 */
  skills: string[]
  source: PluginSource
  installedAt: string
  /** 网页入口的地址（带版本号防缓存），没有网页部分时为空 */
  webUrl: string
  cssUrl: string
  /** 加载出错（清单不对、接口版本不兼容、服务端入口报错） */
  error: string
  /** 带不带会在本机运行的代码 */
  hasCode: boolean
}
