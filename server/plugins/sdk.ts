import type { HookInput, HookOutput } from '../../shared/hook-defs.ts'
import type { PluginConfig } from '../../shared/plugins/types.ts'

/**
 * 插件服务端 SDK（ADR 0059）：插件包里 server 入口的约定。只有类型，插件仓库（fixcode-h/agent-plugins）里有一份副本，
 * 改了这里要同步过去，有不兼容的改动时把 PLUGIN_API 加一。
 *
 * 入口是一个 ESM 文件，默认导出 activate(ctx)，返回 ServerPlugin。插件打开时调用一次，关掉、删除、参数要求重启时调 stop。
 * 入口在面板进程里运行，自己的依赖打包进去；node: 内置模块直接用。
 */

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface McpResult {
  content: McpContent[]
  isError?: boolean
  /**
   * 改文件类工具（effect: 'edit'）这次实际改了哪些文件（插件接口 3）：本机路径，绝对路径或相对对话工作目录。
   * 面板据此把它们算进这一轮的改动、完成依据和改动归属；不交给 Agent
   */
  changed?: string[]
  /**
   * 验证类工具（effect: 'verify'）的结论（插件接口 3）：name 是验证的名字（例如「蓝图编译」），files 是验证覆盖的文件，
   * 不写时算覆盖这一轮插件改过的全部文件。isError 为真时按没通过算。不交给 Agent
   */
  verified?: { passed: boolean; name?: string; files?: string[] }
}

/**
 * 工具对项目做什么（插件接口 3）。面板的守卫、完成依据、改动归属都按工具类别判断，
 * 插件工具在解析层一律是「其他」：不声明的话，写入资产绕过只读身份和 Bug 先诊断，改了资产也不算改动、编译通过也不算验证。
 * - read：只读（默认）；
 * - edit：会改项目里的文件。执行前过工具前守卫（targets 给出要改的文件），结果里用 changed 报实际改了哪些；
 * - verify：验证（编译、检查），结果里用 verified 报通过没有。
 * 和 confirm（用户同不同意）不重复：那是问用户，这是让面板的规则看得见
 */
export type McpToolEffect = 'read' | 'edit' | 'verify'

/** 插件工具请用户确认的内容（插件接口 2）：对话里出一张「允许 / 拒绝」卡片 */
export interface PluginConfirm {
  title: string
  /** 卡片正文：改了什么、影响什么（纯文本，换行保留） */
  detail?: string
}

export interface McpCallContext {
  /** 这一轮对话的 id */
  taskId: string
  /** 这次调用的 JSON-RPC id，插件按它区分并发的调用 */
  callId: string
  /**
   * 请用户确认（插件接口 2）：对话里出「允许 / 拒绝」卡片，等用户点了才返回；停止对话、这一轮结束时按拒绝返回。
   * 不在对话里的调用（没有对话可出卡片）没有这个函数，插件按拒绝处理
   */
  confirm?: (req: PluginConfirm) => Promise<{ allow: boolean; message: string }>
  /**
   * 这次调用被取消（插件框架改进 A3）：用户停止对话、这一轮结束、CLI 发了取消、插件关掉、超过工具的 timeoutSec 时触发。
   * 跑得久的工具（编译、导出、渲染）要监听它停掉自己起的进程和请求；取消后返回什么都不会再交给 Agent
   */
  signal?: AbortSignal
}

/** 给 Agent 的一个 MCP 工具：面板负责协议、会话和令牌，插件只给定义和执行函数 */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call: (args: Record<string, unknown>, ctx: McpCallContext) => Promise<McpResult>
  /** 对项目做什么（插件接口 3），不写按只读算 */
  effect?: McpToolEffect
  /** effect 为 edit 时：按参数算出这次要改的文件（本机路径），执行前交给工具前守卫判断；算不出返回空数组 */
  targets?: (args: Record<string, unknown>) => string[]
  /**
   * 这个工具最多跑多少秒（插件框架改进 A3）：到时间面板按出错回给 Agent，并触发 ctx.signal 让插件停下。
   * 不写不限时（编译这类本来就慢的工具由插件自己判断），取消照样生效
   */
  timeoutSec?: number
}

/** 一轮对话的信息：插件据此决定给不给工具、给哪些 */
export interface PluginRun {
  taskId: string
  /** 子对话的父对话 id */
  parentTaskId?: string
  /** 对话归哪个插件的设计模式（新建时写的 task.plugin，例如 'blender.model'），普通对话为空 */
  pluginTask?: string
  /** 对话所在的项目和工作目录（插件接口 2）：按项目挂工具的插件据此决定挂不挂、连哪个项目 */
  projectId?: string
  cwd?: string
  /** 对话的模式：agent（项目里执行）、chat、workflow…（插件接口 2） */
  mode?: string
  /** 角色名、角色（含引入的角色）用到的技能 */
  agentName: string
  skills: string[]
  /** 续接已有会话：提示词里已经说过怎么用工具，不用再说 */
  resume: boolean
}

export interface PluginRunTools {
  /** MCP 服务：名字要写进清单的 mcpServers，对话里的工具行才认得出 */
  servers: { name: string; tools: () => McpTool[] | Promise<McpTool[]> }[]
  /** 新会话时接在用户消息后面的说明（怎么用这些工具） */
  hint?: string
}

export interface PluginServerContext {
  id: string
  version: string
  /** 包的目录（只读：升级、删除时整个换掉） */
  dir: string
  /** 插件自己的数据目录（数据目录 plugin-data/<id>/），删除插件时一起删 */
  dataDir: string
  /**
   * 这一版是从哪个版本升级来的（插件框架改进 B5）：覆盖安装、退回上一版时记下，新装和链接的目录为空。
   * 每次启动都给同一个值，数据迁移做没做过由插件自己记（例如写在 dataDir 里）
   */
  previousVersion: string
  /** 当前参数（按清单声明补齐默认值） */
  config: () => PluginConfig
  log: {
    info: (msg: string, data?: Record<string, unknown>) => void
    warn: (msg: string, data?: Record<string, unknown>) => void
  }
  /** 界面文案（中文原文当键，英文查包里的 locales/en.json） */
  t: (zh: string, vars?: Record<string, string | number>) => string
}

/**
 * 把一版二进制文件转成可读文本（评审看语义差异用）：面板取改动前后两版的内容各调一次，再按行比较交给评审。
 * 和网页 SDK 的 fileViewers 一样按扩展名认领；旧版本只在版本控制里，不在磁盘上，所以给的是内容不是路径。
 * 出错就抛出，面板把错误原样写进评审看到的差异里
 */
export interface Textifier {
  /** 认领的扩展名：小写、不带点（uasset） */
  exts: string[]
  /**
   * file.path 是相对项目根的路径（判断类型、写提示用，那一版不一定在磁盘上），file.cwd 是项目目录，
   * side 说明是改动前（old）还是改动后（new）的那一版。返回的文本按行比较，同一内容要给出同样的文本
   */
  text: (file: { path: string; cwd: string; side: 'old' | 'new'; data: Buffer }) => string | Promise<string>
}

export interface ServerPlugin {
  /** 插件的接口，挂在 /api/plugins/<id>/ 下：收到的请求地址已去掉这个前缀 */
  fetch?: (req: Request) => Response | Promise<Response>
  /** 每轮对话开始时问一次：返回 undefined 表示这轮不挂工具 */
  tools?: (run: PluginRun) => PluginRunTools | undefined | Promise<PluginRunTools | undefined>
  /**
   * 清单 hooks 里没写 script 的钩子触发时调用（插件接口 3）：id 是清单里钩子的 id，输入输出和用户钩子同一套格式
   * （工具后补 context、工具前 deny、结束前 block，都要写 reason）。返回 undefined 表示不表态；
   * 抛错、超时按清单里的 onError 处理。例：写入资产后编译，有错误时用 context 把错误交给模型
   */
  hook?: (id: string, input: HookInput) => HookOutput | undefined | Promise<HookOutput | undefined>
  /** 参数改了：返回 true 表示要重启（面板调 stop 再 activate） */
  onConfig?: (next: PluginConfig, prev: PluginConfig) => boolean | void | Promise<boolean | void>
  /** 插件页上的运行状态（自由的键值，界面原样列出；插件网页部分可以自己画） */
  status?: () => Promise<Record<string, unknown>>
  /** 二进制文件转文本：评审拿到的改动里，认领了扩展名的文件按前后两版文本的差异给（没给就只在文件列表里） */
  textify?: Textifier
  /** 关掉、删除、重启前：停后台进程、清定时器 */
  stop?: () => void | Promise<void>
}

export type ActivateServer = (ctx: PluginServerContext) => ServerPlugin | Promise<ServerPlugin>
