import { z } from 'zod'

/**
 * 模型首包的记录（AgentUsage.firstToken）：每次请求从面板交出去（输入、工具结果）到第一段输出等了多久（毫秒，
 * 见 server/exec/cli-trace.ts）。n / sumMs / maxMs 是累计，recent 是最近几次（会话栏按它算「最近平均」，
 * 看得出是链路慢还是一直慢）。单独一个文件：schema.ts 引用它，first-token.ts 再引用 schema 的类型，不绕成环
 */
export const FirstTokenStats = z.object({
  n: z.number().int().default(0),
  sumMs: z.number().default(0),
  maxMs: z.number().default(0),
  recent: z.array(z.number()).default([]),
})
export type FirstTokenStats = z.infer<typeof FirstTokenStats>

/** 会话栏「最近平均」看的次数：太少会被一两次抖动带偏，太多又看不出刚换了链路的变化 */
export const FIRST_TOKEN_RECENT = 20

/** 记一次首包（runner 收到 wait 事件时调）：累计和最近几次一起更新 */
export function addFirstToken(stats: FirstTokenStats | undefined, ms: number): FirstTokenStats {
  const s = stats ?? { n: 0, sumMs: 0, maxMs: 0, recent: [] }
  return {
    n: s.n + 1,
    sumMs: s.sumMs + ms,
    maxMs: Math.max(s.maxMs, ms),
    recent: [...s.recent, ms].slice(-FIRST_TOKEN_RECENT),
  }
}
