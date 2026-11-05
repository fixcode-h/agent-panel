import type { AgentUsage } from './schema.ts'

/**
 * 会话栏「模型响应」一块的数：首包等待（每次请求从交出去到第一段输出）和输出速度。
 * 一个对话里可能有几个 Agent（换过角色、CLI），合在一起算：用户关心的是「这个对话等模型等了多久」。
 * 数据来自 runner 记的 AgentUsage.firstToken（server/exec/cli-trace.ts 算好的），旧记录没有就返回 null
 */
export interface FirstTokenSummary {
  /** 记过几次请求 */
  n: number
  /** 全部请求的平均首包（毫秒） */
  avgMs: number
  /** 最近几次的平均：刚换了链路、上下文变大时看得出变化 */
  recentAvgMs: number
  /** 最近几次各是多少（会话栏画成一排小条） */
  recent: number[]
  /** 最长的一次 */
  maxMs: number
  /** 首包合计占了多少时间（毫秒）：和「这一轮用了多久」放在一起看，知道大头是不是在等模型 */
  sumMs: number
  /** 平均输出速度（token/秒）：累计输出除以生成时间，没有生成时间时为 0 */
  tps: number
}

export function firstTokenSummary(agents: Record<string, AgentUsage> | undefined): FirstTokenSummary | null {
  const list = Object.values(agents ?? {})
  const fts = list.map((a) => a.firstToken).filter((x): x is NonNullable<AgentUsage['firstToken']> => !!x && x.n > 0)
  if (!fts.length) return null
  const n = fts.reduce((s, x) => s + x.n, 0)
  const sumMs = fts.reduce((s, x) => s + x.sumMs, 0)
  // 几个 Agent 的「最近」拼起来只取最后几次：顺序按 Agent 排，不是严格的时间序，够看趋势
  const recent = fts.flatMap((x) => x.recent).slice(-20)
  const out = list.reduce((s, a) => s + (a.outputTokens ?? 0), 0)
  const gen = list.reduce((s, a) => s + (a.genMs ?? 0), 0)
  return {
    n,
    sumMs,
    avgMs: sumMs / n,
    recentAvgMs: recent.length ? recent.reduce((s, x) => s + x, 0) / recent.length : sumMs / n,
    recent,
    maxMs: Math.max(...fts.map((x) => x.maxMs)),
    tps: gen > 0 ? out / (gen / 1000) : 0,
  }
}

/** 首包算慢的门槛：超过它在会话栏标黄、提示可以去 API 设置测速换链路（同样的请求直连一般在 2 秒内） */
export const SLOW_FIRST_TOKEN_MS = 5000
