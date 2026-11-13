/**
 * MCP 能力目录（设置 →「MCP」，设计稿 designs/MCP能力菜单-设计稿.md）：面板自己和开着的插件交给 Agent 的 MCP 工具，
 * 每个工具做什么、什么时候该用、什么时候别用、会改什么。
 *
 * 说明由面板和插件自己声明（ToolGuide），交给 Agent 的 description 也从同一份拼出来（./describe.ts），
 * 所以设置页上看到的和 Agent 拿到的是一份，不会各写各的。
 */
import { z } from 'zod'

/** 一个工具的声明：给人看，也拼进交给 Agent 的说明 */
export const ToolGuide = z.object({
  /** 显示名（几个字） */
  title: z.string(),
  /** 作用：一句话，也用作 more_tools 列表里的简介 */
  summary: z.string(),
  /** 什么时候该用 */
  useWhen: z.string(),
  /** 什么时候别用、该改用哪个；没有就不写 */
  avoidWhen: z.string().optional(),
  /** 页面上的分组（运行时对象、资源与蓝图……）；不写归「其他」 */
  group: z.string().optional(),
})
export type ToolGuide = z.infer<typeof ToolGuide>

/**
 * 工具对外界做什么，页面上的徽标：
 * read 只读；edit 改文件或项目；verify 验证（结论进完成依据）；dispatch 派出去做（子对话、子任务、后台命令）；
 * ask 等你回答或操作；confirm 执行前会请你确认；danger 做了收不回
 */
export const ToolEffect = z.enum(['read', 'edit', 'verify', 'dispatch', 'ask', 'confirm', 'danger'])
export type ToolEffect = z.infer<typeof ToolEffect>

/** 面板工具给哪几类对话（「给谁」）：父对话（项目里的顶层对话）、子对话、子任务、工作流节点、Chat 页 */
export const AUDIENCES = ['parent', 'child', 'helper', 'node', 'chat'] as const
export const Audience = z.enum(AUDIENCES)
export type Audience = z.infer<typeof Audience>

/** 参数表的一行（从 inputSchema 生成） */
export const CatalogParam = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string(),
  required: z.boolean(),
})
export type CatalogParam = z.infer<typeof CatalogParam>

export const CatalogTool = z.object({
  /** 交给 CLI 的工具名 */
  name: z.string(),
  /** 显示名：声明里的 title，没有时用清单的 toolNames，再没有就是工具名 */
  title: z.string(),
  /** 声明；旧插件没写时没有 */
  guide: ToolGuide.optional(),
  effects: z.array(ToolEffect),
  /** 交给 Agent 的说明原文（已经拼上什么时候用 / 不要用） */
  description: z.string(),
  params: z.array(CatalogParam),
  /** 面板工具：可能拿到它的对话类型（插件工具不写，看服务的「什么时候挂」） */
  audience: z.array(Audience).optional(),
  /** 不直接列出、收进 more_tools 的 */
  deferred: z.boolean().optional(),
})
export type CatalogTool = z.infer<typeof CatalogTool>

/** 面板动作（经 app_actions / app_do 调的） */
export const CatalogAction = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  level: z.enum(['read', 'write', 'danger']),
  useWhen: z.string().optional(),
  avoidWhen: z.string().optional(),
  /** 动作的组（task、project、table……） */
  group: z.string(),
})
export type CatalogAction = z.infer<typeof CatalogAction>

/** 一个 MCP 服务 */
export const CatalogServer = z.object({
  /** MCP 服务名（agent-panel、ue、design……） */
  name: z.string(),
  summary: z.string(),
  /** 什么时候挂（给人看的一句） */
  attach: z.string(),
  /** 新会话开头交给 Agent 的用法说明 */
  hint: z.string().optional(),
  tools: z.array(CatalogTool),
  /** 列不出工具的原因（插件出错、要先启动外部程序） */
  error: z.string().optional(),
})
export type CatalogServer = z.infer<typeof CatalogServer>

/** 一个来源：面板自带的 MCP 服务、操控软件的动作表、一个插件 */
export const CatalogSource = z.object({
  /** panel、app、plugin:<插件 id> */
  id: z.string(),
  kind: z.enum(['panel', 'app', 'plugin']),
  name: z.string(),
  /** 插件版本；面板自带的不写 */
  version: z.string().optional(),
  /** 插件清单里的图标名 */
  icon: z.string().optional(),
  summary: z.string(),
  servers: z.array(CatalogServer),
  actions: z.array(CatalogAction),
  /** 插件没提供目录（插件接口 8 以前），只能从清单的 mcpServers / toolNames 列出名字 */
  legacy: z.boolean().optional(),
  error: z.string().optional(),
})
export type CatalogSource = z.infer<typeof CatalogSource>

export const McpCatalog = z.object({
  sources: z.array(CatalogSource),
  /** 用户自己装的 MCP（图标栏「MCP 工具」页管的）有几个 */
  mine: z.number(),
})
export type McpCatalog = z.infer<typeof McpCatalog>

/** 自检：这样一轮对话，Agent 能拿到什么 */
export const McpCheckInput = z.object({
  projectId: z.string().default(''),
  agentId: z.string().default(''),
  cli: z.string(),
  kind: Audience,
})
export type McpCheckInput = z.infer<typeof McpCheckInput>

export const McpCheckRow = z.object({
  source: z.string(),
  name: z.string(),
  /** MCP 服务名；面板动作是 app_do */
  server: z.string(),
  /** on 挂上；off 不挂；error 插件出错或超时 */
  state: z.enum(['on', 'off', 'error']),
  /** 挂上几个 */
  count: z.number(),
  /** 面板服务：收进 more_tools 的个数 */
  deferred: z.number().optional(),
  /** 不挂的原因、出错原文；挂上时可以是补充说明 */
  reason: z.string(),
})
export type McpCheckRow = z.infer<typeof McpCheckRow>

export const McpCheckResult = z.object({
  cli: z.object({ id: z.string(), name: z.string(), mcp: z.boolean() }),
  rows: z.array(McpCheckRow),
  /** 挂上了但有工具没写「什么时候用」的来源 */
  missing: z.array(z.object({ source: z.string(), name: z.string(), count: z.number() })),
  /** 上一次真实对话：什么时候、哪个对话、拿到几个；面板重启后为空 */
  last: z.object({ at: z.string(), title: z.string(), tools: z.number(), errors: z.array(z.string()) }).optional(),
})
export type McpCheckResult = z.infer<typeof McpCheckResult>
