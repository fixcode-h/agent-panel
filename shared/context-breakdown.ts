import { z } from 'zod'

/**
 * 会话栏的「上下文」细分（照 Claude Code 的 /context）：一个会话的上下文窗口里各块各占多少。
 *
 * 分类照 Claude Code 自己的 /context（2.1.3xx 起控制协议 get_context_usage 能直接要到，分类 id 见 CLAUDE_CONTEXT_IDS），
 * 各家 CLI 共用同一套分类：
 * - CLI 自己报细分的（Claude Code 的 get_context_usage）：每轮结束要一次快照（ContextSnapshot），各块按它报的，
 *   之后新增的那部分记成「上次细分以来」，直到下一次快照；
 * - 其余 CLI 只报总占用和窗口，各块按来源分三种估：
 * - 面板交给 CLI 的（面板工具、追加的系统提示词）：运行时记下字数，换算成 token，最准；
 * - 本机文件（说明文件、Skill 的名字和描述）：会话栏打开时现读字数换算；
 * - CLI 自己的系统提示词和内置工具：写在 CLI 定义的 context 里的估计值（各版本会变，只求量级对）。
 * 「消息」是总占用减去上面各块剩下的，所以总数永远和 CLI 报的一致。
 */

/** CLI 定义里的上下文基线（token 数，估计值）：CLI 自己带的、面板看不到的那部分 */
export const CliContextBase = z.object({
  /** CLI 自己的系统提示词 */
  systemPrompt: z.number().int().min(0).default(0),
  /** CLI 内置工具（读写文件、跑命令……）的定义 */
  systemTools: z.number().int().min(0).default(0),
  /** CLI 自己的自动压缩留出的余量（token）；面板设置了自动压缩百分比时按设置算，不看这一项 */
  compactReserve: z.number().int().min(0).default(0),
  /** 同上，按窗口的百分比写（Codex 默认到九成压缩）；两项都写时取大的 */
  compactReservePct: z.number().min(0).max(100).default(0),
  /** 说明文件读几个：all 是 docs 里存在的都读，first 是只读第一个存在的（没有 AGENTS.md 才读 CLAUDE.md 这种） */
  docsMode: z.enum(['all', 'first']).default('first'),
  /** 说明文件里单独一行的「@路径」会把那个文件也读进来（Claude Code 的 CLAUDE.md 写 @AGENTS.md） */
  docsImports: z.boolean().default(false),
})
export type CliContextBase = z.infer<typeof CliContextBase>

/** 运行时记下的、面板交给这个会话的内容（字数）：挂在 AgentUsage.parts 上，跟着任务同步到页面 */
export const ContextParts = z.object({
  cli: z.string().default(''),
  /** 面板追加的系统提示词（角色设定 + 语言规则）；没有系统提示词参数的 CLI 放在第一条消息里，算消息 */
  system: z.number().default(0),
  /** 这一轮直接列给 CLI 的面板工具：名字和定义的字数（名字 + 说明 + 参数 JSON） */
  tools: z.array(z.object({ name: z.string(), chars: z.number() })).default([]),
  /** 收进 more_tools 的面板工具：不占上下文，用到时才取 */
  deferred: z.array(z.object({ name: z.string(), chars: z.number() })).default([]),
})
export type ContextParts = z.infer<typeof ContextParts>

/** 会话栏打开时现读的本机文件：说明文件、Skill（字数） */
export interface ContextFiles {
  memory: { path: string; chars: number }[]
  skills: { name: string; chars: number }[]
}

export const CONTEXT_KEYS = [
  'messages',
  'systemTools',
  'mcpTools',
  'mcpInstructions',
  'systemPrompt',
  'agents',
  'skills',
  'memory',
  'since',
  'buffer',
  'free',
  'mcpDeferred',
  'systemDeferred',
] as const
/**
 * 上下文的分类：和 Claude Code /context 的类别一一对应（since 是面板自己加的：快照之后新增、还没细分的）。
 * mcpDeferred、systemDeferred 是按需取用的工具（Claude Code 的 deferred）：不占窗口，单列
 */
export type ContextKey = (typeof CONTEXT_KEYS)[number]

/** Claude Code get_context_usage 的类别 id → 面板的分类（两种压缩余量都算 buffer） */
export const CLAUDE_CONTEXT_IDS: Record<string, ContextKey> = {
  system_prompt: 'systemPrompt',
  system_tools: 'systemTools',
  mcp_tools: 'mcpTools',
  mcp_instructions: 'mcpInstructions',
  mcp_tools_deferred: 'mcpDeferred',
  system_tools_deferred: 'systemDeferred',
  custom_agents: 'agents',
  memory_files: 'memory',
  skills: 'skills',
  messages: 'messages',
  autocompact_buffer: 'buffer',
  compact_buffer: 'buffer',
  free_space: 'free',
}

/**
 * Claude Code get_context_usage 的类别名 → 面板的分类：2.1.3xx 起回复里只有 name，没有早期版本的 id。
 * 名字是界面上显示的那几个（System prompt、MCP tools (deferred)……），两种情况下的压缩余量都算 buffer。
 * 名称要和 CLI 输出逐字一致（认不出的类别会被丢掉）；加类别时两张表一起改
 */
export const CLAUDE_CONTEXT_NAMES: Record<string, ContextKey> = {
  'System prompt': 'systemPrompt',
  'System tools': 'systemTools',
  'MCP tools': 'mcpTools',
  'MCP server instructions': 'mcpInstructions',
  'MCP tools (deferred)': 'mcpDeferred',
  'System tools (deferred)': 'systemDeferred',
  'Custom agents': 'agents',
  'Memory files': 'memory',
  Skills: 'skills',
  Messages: 'messages',
  'Autocompact buffer': 'buffer',
  'Compact buffer': 'buffer',
  'Free space': 'free',
}

const Named = z.object({ name: z.string(), tokens: z.number() })
/**
 * CLI 自己报的一次细分（快照）：只有报得出来的 CLI 才有，挂在 AgentUsage.snapshot 上。
 * used 是这次快照里占窗口的各块之和；之后 CLI 报的总占用比它多出来的就是「上次细分以来」
 */
export const ContextSnapshot = z.object({
  at: z.string(),
  used: z.number(),
  window: z.number(),
  rows: z.array(z.object({ key: z.enum(CONTEXT_KEYS), tokens: z.number() })),
  tools: z.array(Named.extend({ deferred: z.boolean().default(false) })).default([]),
  memory: z.array(z.object({ path: z.string(), tokens: z.number() })).default([]),
  skills: z.array(Named).default([]),
  agents: z.array(Named).default([]),
})
export type ContextSnapshot = z.infer<typeof ContextSnapshot>

export interface ContextRow {
  key: ContextKey
  tokens: number
  /** 估算的（不是 CLI 报的、也不是面板按字数换算的）：界面上标出来 */
  estimated?: boolean
}

/** 占窗口的块：按需取用的（deferred）不占 */
const DEFERRED_KEYS: ContextKey[] = ['mcpDeferred', 'systemDeferred']

export interface ContextBreakdown {
  used: number
  window: number
  /** 占窗口的比例（0–100）：已用 */
  percent: number
  /** 按窗口画的几块：消息、系统工具、MCP 工具、系统提示词、Skill、说明文件、自动压缩余量、空闲 */
  rows: ContextRow[]
  /** 不占上下文、用到才取的工具（Claude Code 的 deferred）：列出来但不画进条里 */
  deferred: ContextRow[]
  tools: { name: string; tokens: number }[]
  deferredTools: { name: string; tokens: number }[]
  memory: { path: string; tokens: number }[]
  skills: { name: string; tokens: number }[]
  /** 自定义 Agent（子 Agent 的名字和用途说明）：只有 CLI 报细分时才有 */
  agents: { name: string; tokens: number }[]
  /** reported：各块是 CLI 自己报的（at 是快照时间）；estimated：面板按来源估的 */
  source: 'reported' | 'estimated'
  at?: string
}

/** 快照之后总占用又涨了多少才单列「上次细分以来」：差几百是两边计数口径不同，不算新增 */
const SINCE_MIN = 500

/**
 * 用 CLI 报的快照画细分。总占用比快照时少了一截（压缩过、清过对话）时快照已经作废，返回 null 退回估算
 */
function fromSnapshot(snap: ContextSnapshot, used: number, window: number, pct: number): ContextBreakdown | null {
  if (!window || used < snap.used * 0.9) return null
  const inWindow = snap.rows.filter((r) => !DEFERRED_KEYS.includes(r.key) && r.key !== 'free' && r.key !== 'buffer')
  const sum = inWindow.reduce((n, r) => n + r.tokens, 0)
  const since = used - sum > SINCE_MIN ? used - sum : 0
  // 设置里定了自动压缩百分比时余量按设置算：面板把它交给了 CLI（环境变量 / 配置 / 面板自己压缩），
  // CLI 报的余量是它自己的默认值（Claude Code 固定报三万多），照抄的话「距自动压缩」和设置对不上（用户报过）
  const reserve =
    pct > 0
      ? (window * (100 - pct)) / 100
      : snap.rows.filter((r) => r.key === 'buffer').reduce((n, r) => n + r.tokens, 0)
  const buffer = Math.round(Math.max(0, Math.min(reserve, window - sum - since)))
  const total = sum + since
  const order = (k: ContextKey) => CONTEXT_KEYS.indexOf(k)
  const rows: ContextRow[] = [
    ...inWindow.filter((r) => r.tokens > 0).sort((a, b) => order(a.key) - order(b.key)),
    ...(since ? [{ key: 'since' as const, tokens: since }] : []),
    ...(buffer ? [{ key: 'buffer' as const, tokens: buffer }] : []),
    { key: 'free', tokens: Math.max(0, window - total - buffer) },
  ]
  if (!rows.some((r) => r.key === 'messages')) rows.unshift({ key: 'messages', tokens: 0 })
  const tools = snap.tools.filter((x) => !x.deferred).map(({ name, tokens }) => ({ name, tokens }))
  const deferredTools = snap.tools.filter((x) => x.deferred).map(({ name, tokens }) => ({ name, tokens }))
  return {
    used: total,
    window,
    percent: Math.min(100, (total / window) * 100),
    rows,
    deferred: snap.rows.filter((r) => DEFERRED_KEYS.includes(r.key) && r.tokens > 0),
    tools,
    deferredTools,
    memory: snap.memory,
    skills: snap.skills,
    agents: snap.agents,
    source: 'reported',
    at: snap.at,
  }
}

export const tokensOfChars = (n: number) => Math.round(n / 3)

/**
 * 算细分：used / window 是 CLI 报的；autoCompactPct 是面板设置的自动压缩百分比（0 = 按 CLI 自己的规则），CLI 报了细分时余量也按它算。
 * 估出来的几块加起来超过总占用时（刚开会话、CLI 还没报用量），按比例缩到总占用以内，消息记 0
 */
export function contextBreakdown(o: {
  used: number
  window: number
  base?: Partial<CliContextBase>
  parts?: Partial<ContextParts>
  files?: ContextFiles
  autoCompactPct?: number
  /** CLI 自己报的细分（有就优先用，作废了才退回估算） */
  snapshot?: ContextSnapshot
}): ContextBreakdown {
  const window = Math.max(0, o.window)
  const used = Math.max(0, Math.min(o.used, window || o.used))
  const reported = o.snapshot && fromSnapshot(o.snapshot, used, window, o.autoCompactPct ?? 0)
  if (reported) return reported
  const base = CliContextBase.parse(o.base ?? {})
  const tools = (o.parts?.tools ?? []).map((x) => ({ name: x.name, tokens: tokensOfChars(x.chars) }))
  const deferredTools = (o.parts?.deferred ?? []).map((x) => ({ name: x.name, tokens: tokensOfChars(x.chars) }))
  const memory = (o.files?.memory ?? []).map((x) => ({ path: x.path, tokens: tokensOfChars(x.chars) }))
  const skills = (o.files?.skills ?? []).map((x) => ({ name: x.name, tokens: tokensOfChars(x.chars) }))
  const sum = (xs: { tokens: number }[]) => xs.reduce((n, x) => n + x.tokens, 0)
  const fixed: ContextRow[] = [
    { key: 'systemTools', tokens: base.systemTools, estimated: true },
    { key: 'mcpTools', tokens: sum(tools) },
    { key: 'systemPrompt', tokens: base.systemPrompt + tokensOfChars(o.parts?.system ?? 0), estimated: true },
    { key: 'skills', tokens: sum(skills) },
    { key: 'memory', tokens: sum(memory) },
  ]
  const known = fixed.reduce((n, r) => n + r.tokens, 0)
  // 估的比 CLI 报的总数还多：按比例缩，保证各块加起来就是总占用
  if (known > used && known > 0) for (const r of fixed) r.tokens = Math.floor((r.tokens * used) / known)
  const messages = Math.max(0, used - fixed.reduce((n, r) => n + r.tokens, 0))
  const pct = o.autoCompactPct ?? 0
  const reserve =
    pct > 0 ? (window * (100 - pct)) / 100 : Math.max(base.compactReserve, (window * base.compactReservePct) / 100)
  const buffer = Math.round(Math.max(0, Math.min(reserve, window - used)))
  const free = Math.max(0, window - used - buffer)
  return {
    used,
    window,
    percent: window ? Math.min(100, (used / window) * 100) : 0,
    rows: (
      [
        { key: 'messages', tokens: messages },
        ...fixed,
        { key: 'buffer', tokens: buffer, estimated: pct <= 0 },
        { key: 'free', tokens: free },
      ] as ContextRow[]
    ).filter((r) => r.tokens > 0 || r.key === 'messages' || r.key === 'free'),
    deferred: deferredTools.length ? [{ key: 'mcpDeferred', tokens: sum(deferredTools) }] : [],
    tools,
    deferredTools,
    memory,
    skills,
    agents: [],
    source: 'estimated',
  }
}
