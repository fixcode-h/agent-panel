import { z } from 'zod'

/**
 * 会话栏的「上下文」细分（照 Claude Code 的 /context）：一个会话的上下文窗口里各块各占多少。
 *
 * CLI 能报出来的只有总占用和窗口（各家都一样，没有一家按块报），其余按来源分三种：
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

export type ContextKey =
  | 'messages'
  | 'systemTools'
  | 'mcpTools'
  | 'systemPrompt'
  | 'skills'
  | 'memory'
  | 'buffer'
  | 'free'
  | 'mcpDeferred'

export interface ContextRow {
  key: ContextKey
  tokens: number
  /** 估算的（不是 CLI 报的、也不是面板按字数换算的）：界面上标出来 */
  estimated?: boolean
}

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
}

/**
 * 字数换算 token：中日韩字符约一个字一个 token，其余约四个字符一个（和 runner 的 estTokens 同一口径）。
 * 只有字数时（面板记的 chars）按中英混合的平均 3 个字符一个估
 */
export function tokensOfText(s: string) {
  const cjk = s.match(/[぀-ヿ㐀-鿿가-힯＀-￯]/g)?.length ?? 0
  return Math.round(cjk + (s.length - cjk) / 4)
}
export const tokensOfChars = (n: number) => Math.round(n / 3)

/**
 * 算细分：used / window 是 CLI 报的；autoCompactPct 是面板设置的自动压缩百分比（0 = 按 CLI 自己的规则）。
 * 估出来的几块加起来超过总占用时（刚开会话、CLI 还没报用量），按比例缩到总占用以内，消息记 0
 */
export function contextBreakdown(o: {
  used: number
  window: number
  base?: Partial<CliContextBase>
  parts?: Partial<ContextParts>
  files?: ContextFiles
  autoCompactPct?: number
}): ContextBreakdown {
  const window = Math.max(0, o.window)
  const used = Math.max(0, Math.min(o.used, window || o.used))
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
  }
}
