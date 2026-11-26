/**
 * 工具网关（ADR 0084，设计稿「技能与自建工具按情境加载」第二部分）：每一次工具调用在 tool.before / tool.after 都先过面板，
 * 面板认出这是什么调用（CallClassifier，./classify.ts）、给出决定（pass / rewrite / serve / redirect / deny），并记一条调用记录。
 *
 * 第一期只做观察模式：真实动作永远是现有逻辑的结果（守卫照旧拒绝，其余放行），另外算一个「如果打开改道会改到哪」（wouldRoute），
 * 让用户在「调用记录」里看到真实比例，再决定要不要打开改道。这里放前后端共用的形状，服务端在 server/tool-gateway/
 */
import { z } from 'zod'
import { t } from '../i18n.ts'
import { VerifyRun } from './verify/types.ts'
import { ToolRoute } from '../capability-router/tool-route.ts'

/** 统一的调用类别：由 CLI 定义的 hooks.toolNames 归类，面板工具、别家 MCP 工具另认 */
export const CALL_KINDS = ['read', 'edit', 'shell', 'mcp', 'panel', 'other'] as const
export type CallKind = (typeof CALL_KINDS)[number]

/** 命令类别（./commands.ts 的注册表，一个类别一行）：拿不准的不归类 */
export const COMMAND_CATEGORIES = ['search', 'lint', 'test', 'build', 'vcs', 'read', 'long'] as const
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number]

/** 一条 shell 命令认出来的样子 */
export interface ParsedCommand {
  /** 真正运行的程序名（复用 shared/custom-tools/match.ts 的 programOf，拿不准时退回段首程序名） */
  program: string
  category?: CommandCategory
  /** 管道、&&、; 拆成几段：多段的一律不改道（解析不准，宁可走原命令） */
  segments: number
}

/** 网关认出来的一次调用（设计稿 7.1） */
export interface ToolCall {
  cli: string
  /** CLI 里的工具名 */
  tool: string
  kind: CallKind
  input: Record<string, unknown>
  paths: string[]
  /** shell 才有 */
  command?: ParsedCommand
  /** CLI 自带的搜索工具（定义里 hooks.searchTools 登记的 Grep / Glob 这类） */
  search?: boolean
  /** mcp 才有：服务名和去掉前缀的工具名 */
  server?: string
  mcpTool?: string
  /** 经面板代理的外部工具（Agent 通过 more_tools 调的，ADR 0085） */
  proxied?: boolean
  /** 面板工具去掉前缀的名字 */
  panel?: string
}

/**
 * 网关的决定（设计稿 5.2）：观察模式下真实决定只有 pass / deny，其余三种只出现在 wouldRoute 里；
 * 改道模式（第二期）下查找会真的 rewrite / serve
 */
export const GATEWAY_DECISIONS = ['pass', 'rewrite', 'serve', 'redirect', 'deny'] as const
export type GatewayDecision = (typeof GATEWAY_DECISIONS)[number]

/** 能力（能力路由的 CapabilityId，shared/capability-router/types.ts 的同一份清单） */
export const CAPABILITY_IDS = ['find', 'verify', 'read-asset', 'apply'] as const

/**
 * 网关模式：off 不装钩子也不记；observe 每次调用都过网关、记录、算 wouldRoute，但不真的改道；
 * enforce 真的改道（第二期：搜索命令和 CLI 自带的按内容搜改走 find）。默认仍是 observe：用户要先看一阵调用记录再打开（2026-11-26）
 */
export const GATEWAY_MODES = ['off', 'observe', 'enforce'] as const
export type GatewayMode = (typeof GATEWAY_MODES)[number]
export const DEFAULT_GATEWAY_MODE: GatewayMode = 'observe'

/** 模式的注册表：设置页按它列下拉，available 为 false 的不给选（接口 + 注册表，加模式只加一行） */
export const GATEWAY_MODE_DEFS: { id: GatewayMode; label: () => string; hint: () => string; available: boolean }[] = [
  { id: 'off', label: () => t('关闭'), hint: () => t('不经过网关：不记录，也不算能改到哪'), available: true },
  {
    id: 'observe',
    label: () => t('观察（只记录）'),
    hint: () => t('只记录「能改到哪」，不真的改；看过调用记录再打开'),
    available: true,
  },
  {
    id: 'enforce',
    label: () => t('改道'),
    hint: () => t('搜索命令和自带的按内容搜改走面板的查找，结果是面板和原命令的并集；拿不准的照原样跑'),
    available: true,
  },
]

/** 数据目录 hooks.json 里网关这一段（和内置钩子的开关存在一起，见 shared/hooks/defs.ts 的 HooksData） */
export const GatewaySettings = z.object({
  mode: z.enum(GATEWAY_MODES).default(DEFAULT_GATEWAY_MODE),
  /** 外部 MCP 服务改由面板代理（ADR 0085）：默认开，关掉时外部服务照旧直接挂在 CLI 上 */
  mcpProxy: z.boolean().default(true),
})
export type GatewaySettings = z.infer<typeof GatewaySettings>

/** 打开改道时会改到哪（只是推算，观察模式不执行） */
export const WouldRoute = z.object({
  capability: z.enum(CAPABILITY_IDS),
  decision: z.enum(GATEWAY_DECISIONS),
  /** 会走的那条路（find、custom_tool:Lua 检查、request_build……） */
  to: z.string(),
  /** 按哪条规则认的（rg 命令、Grep、lua_code……） */
  by: z.string(),
})
export type WouldRoute = z.infer<typeof WouldRoute>

/** 调用记录的一条（CallLog）：工具前建、工具后补上执行结果 */
export const CallRecord = z.object({
  id: z.string(),
  /** 工具前到达面板的时间（毫秒） */
  at: z.number(),
  projectId: z.string(),
  taskId: z.string(),
  /** 对话标题（记录时的） */
  taskTitle: z.string(),
  /** 同一次 CLI 调用（一轮）的编号：「本可以并行」只在同一轮里比 */
  turn: z.string(),
  cli: z.string(),
  tool: z.string(),
  kind: z.enum(CALL_KINDS),
  /** 命令或路径（截短） */
  summary: z.string(),
  /** 外部 MCP 工具：服务名、工具名；proxied 是经面板代理调的（ADR 0085），没有是 CLI 直接调的 */
  mcp: z.object({ server: z.string(), tool: z.string(), proxied: z.boolean().optional() }).optional(),
  /** 原调用的输入（JSON，截短），点开一行时看 */
  input: z.string(),
  category: z.enum(COMMAND_CATEGORIES).optional(),
  segments: z.number().optional(),
  /** 这次调用归哪个能力（直接调 find、request_build 也算），筛选用 */
  capability: z.enum(CAPABILITY_IDS).optional(),
  /** 实际的决定：观察模式下只有 pass / deny；改道模式下查找可能是 rewrite / serve */
  decision: z.enum(GATEWAY_DECISIONS),
  wouldRoute: WouldRoute.optional(),
  /** 改写后的输入（JSON，截短）：decision 为 rewrite 时才有，原输入在 input */
  rewritten: z.string().optional(),
  /** 改道时面板实际走的路（和工具卡片上的 ToolUse.route 同一份）；改道模式下拿不准放行的也记走过的路 */
  route: ToolRoute.optional(),
  /** 改道模式下这次为什么照原样放行（拿不准、面板没有多出来的……） */
  takeoverWhy: z.string().optional(),
  /** 哪个守卫或钩子拒绝的（builtin:<id> 或用户钩子 id） */
  denyBy: z.string().optional(),
  /** 这次补充说明来自哪些钩子（builtin:<id> 或用户钩子 id）和字数 */
  pushes: z.array(z.object({ id: z.string(), chars: z.number() })).optional(),
  /** 这次调用前后新推的技能 */
  skills: z.array(z.object({ skill: z.string(), chars: z.number(), tokens: z.number() })).optional(),
  /** 网关自己多花的时间（认调用、推算、记录；毫秒，两位小数） */
  ms: z.number(),
  /** 整个工具前回答（守卫、推送、用户钩子，加上网关自己）用时 */
  hookMs: z.number().optional(),
  /** 工具前到工具后：工具执行用时（含 CLI 自己的开销）；没收到工具后时没有 */
  durMs: z.number().optional(),
  failed: z.boolean().optional(),
  /** 只读调用（读文件、搜索、只读命令、面板的查找类工具，见 classify.ts 的 readOnlyCall） */
  readOnly: z.boolean().optional(),
  /** 本可以并行：同一轮里上一次只读调用结束后才发这一次，中间没有改文件或跑别的命令 */
  serial: z.boolean().optional(),
  /** 网关自己出错（已放行） */
  error: z.string().optional(),
  /** 面板替 Agent 跑的校验（ADR 0086）：改完自动跑的那一行，或改道代答时跑的自建工具 */
  verify: VerifyRun.optional(),
})
export type CallRecord = z.infer<typeof CallRecord>
