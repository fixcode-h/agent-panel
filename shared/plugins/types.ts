import { z } from 'zod'
import type { BuiltinAgent } from '../builtin/agents.ts'
import type { BuiltinWorkflow } from '../builtin/workflows.ts'
import { PluginCommand, PluginHook, PluginTestStep } from './contrib-schema.ts'
import { PluginRuntimeFields } from './runtime-schema.ts'

/**
 * 插件清单（ADR 0059）：插件包根目录的 plugin.json。插件是自包含的包，装在数据目录 plugins/<id>/，
 * 核心代码只通过清单字段和插件 SDK（server/plugins/sdk.ts、web/src/plugins/sdk.ts）认识插件，不按插件 id 写分支，删掉插件面板照常工作。
 * 文案写中文原文，界面上用 t() 取，英文在包里的 locales/en.json。
 */

/**
 * 插件参数的一项：插件页按声明生成表单，值存在 Settings.plugins[id].config[key]。
 * secret（插件接口 18）是令牌、密钥：不进设置，加密存在本机（server/secrets/store.ts），插件用 ctx.secrets 取，
 * 网页只看得到设没设和末 4 位
 */
export const PluginSetting = z.object({
  key: z.string().min(1),
  type: z.enum(['text', 'path', 'number', 'boolean', 'select', 'secret']),
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
  /**
   * 生效方式（插件接口 9）：global 装好就对所有项目生效，项目里没有开关（例如视频截帧）；
   * project 只在项目设置 →「能力」里打开了的项目生效（例如 UE、表格），挂工具、项目工具里的页面都按它。
   * 旧插件没写，按 global 处理，行为和以前一样
   */
  activation: z.enum(['global', 'project']).default('global'),
  /**
   * 依赖的插件和最低版本（插件接口 10）：`{ "comfy": ">=1.0.0" }`。安装、一键更新时缺的或太旧的从插件市场一起装上，
   * 依赖没满足的不加载；被依赖的插件删除、关掉前会拦下（shared/plugins/requires.ts）
   */
  requires: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), z.string()).default({}),
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
  /**
   * 插件构建时实际接到面板的开放模块（插件仓库的构建脚本自动写，键同 shared/plugins/host-modules.json）。
   * 面板安装、启动时逐项核对：这个面板版本没开放的就拒绝，写明要先升级面板，而不是装上后运行到那里才报错
   */
  hostModules: z.object({ web: z.array(z.string()).optional(), server: z.array(z.string()).optional() }).optional(),
  /**
   * 插件接口 11：给 Agent 的环境变量（env，含 PATH 前置）、外部 MCP 服务（mcp）、托管进程（services）、
   * 声明式网页页面（webPages）和包装记录（wrap），格式见 runtime-schema.ts
   */
  ...PluginRuntimeFields,
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
 * 4：插件直接 import 面板开放的模块（shared/plugins/host-modules.json）、设计模式自带侧栏和整页（DesignMode.Sidebar / Page）、
 *    不带面板外壳的独立页（WebPlugin.barePages，无头浏览器截图用）
 * 5：去掉设计模式（WebPlugin.designModes、#/pdesign），设计类插件改用图标栏里的整页；整页可以自己分块（PluginPage.split），
 *    子位置可以带 /（#/plugin/<插件>/<页面>/<a>/<b>）
 * 6：插件认领输入框附件（WebPlugin.attachmentIntakes，例如视频插件把视频换成截好的帧图片）、
 *    这一轮是不是用户在聊的对话（PluginRun.conversation）
 *    另外服务端入口登记面板动作（ServerPlugin.actions）；网页入口在项目设置里加页（WebPlugin.projectSections，
 *    设置存在 project.plugins[<插件 id>]）、在设置 →「组件」里加示例（WebPlugin.specimens）；开放 web/src/lib/assist-conv
 *    （runPromptInProject：在项目里开分析对话跑插件自己的提示词）
 * 7：插件推送通道（PluginServerContext.pages / host.events）
 * 8：工具和动作自己声明作用和使用时机（McpTool.guide、PluginAction.useWhen / avoidWhen），交给 Agent 的说明从它拼出来；
 *    不开对话列出能力的目录（ServerPlugin.catalog），tools(run) 返回服务的 summary / attach 和不挂的原因 skip，
 *    设置 →「MCP」自检时 run.dryRun 为 true（设计稿：MCP能力菜单）。都是可选的，旧插件照常加载
 * 9：插件的生效方式（清单 activation：global / project）。按项目的插件只在项目「能力」里打开了的项目挂工具、
 *    出现在项目工具里（PluginPage.scope = 'project'）；服务端入口可以按目录给出推荐（ServerPlugin.detect）、
 *    说明还缺哪项设置（ServerPlugin.ready），也可以替已经接入的项目打开自己（PluginServerContext.projects.enable）。
 *    设计稿：Agent侧栏与项目管理重设计 第 6 节
 * 10：插件之间的依赖（清单 requires）：安装、一键更新时把缺的依赖从插件市场一起装上，依赖没满足的不加载
 * 11：声明式的运行时字段（清单 env / mcp / services / webPages / wrap，见 runtime-schema.ts）：插件不写代码也能给 Agent
 *    带环境变量和 PATH、外部 MCP 服务，由面板起停托管进程、出网页页面；从 GitHub 链接包装出来的插件靠它接进面板。
 *    设计稿：GitHub项目一键变插件与网页页签 第 5 节，ADR 0068
 * 12：一轮对话的角色参数（PluginRun.params）和续接的会话也带的说明（PluginRunTools.turnNote）；开放模块加了
 *    风格选择和参考图组件、风格约束拼说明（shared/style/rules-text）。设计稿：Blender建模风格 第 8 节
 * 13：插件测试步骤的命令里能用 {dir}（插件包目录）、{data}（插件数据目录），插件可以带自己的脚本当测试步骤
 *    （UE 插件的「蓝图编译」按项目找引擎）；旧面板不换这两个占位符，命令跑不起来，所以加一
 * 14：对话分开存成 chat（Chat 页）和 agent（项目里的对话、子对话），PluginRun.mode 照存的值给；
 *    PluginRun.kind 给对话的统一分类（父对话、子对话、Bug、AI 分析……，shared/conv-mode.ts 的 convKind）
 * 15：PluginServerContext.projects.docRoot（项目的文档根）
 * 16：项目文件索引（设计稿：项目文件索引）：PluginServerContext.files 按名字找文件、按文件夹取、订阅增删，
 *    插件不再各自走目录；ServerPlugin.fileIndexRoots 报项目外要一起收的目录（UE 引擎目录）
 * 17：确认卡可以带「这个对话里一直允许」和改动差异（PluginConfirm.always / diff，结果带 always），
 *    工具调用能取用户在对话里亲口说的话（McpCallContext.userWords）。设计稿：飞书插件 第 8 节
 * 18：参数类型 secret（令牌、密钥加密存本机、网页打码）和 PluginServerContext.secrets
 * 19：PluginServerContext.integrations：设置 →「账号授权」里工具的状态、路径和备用登录信息（飞书插件的登录搬过去）
 */
export const PLUGIN_API = 19

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
  /** 能退回的上一版的版本号（升级时留着旧版），没有为空 */
  rollback: string
}
