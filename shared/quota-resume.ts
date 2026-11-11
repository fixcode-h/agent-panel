/**
 * 额度用完和被限流后自动接上（Agent 模式扩展 1）。两个设置都默认关，由用户事先授权：
 * - 到点自动继续：这一轮因为额度用完 / 被限流失败，且知道什么时候恢复时，对话进入「等额度恢复」，到点由面板继续；
 * - 备用顺序：用户排好「这个模型不行就换哪个」，可以跨 CLI；按顺序换一个接着做。
 * 两条都在对话里写一行说清楚做了什么，不违反「错误一律显示给用户，不悄悄重试」。
 *
 * 只看失败那一行的告警分类（shared/alerts.ts 按 CLI 的报错归类），不看模型回复的文字（ADR 0041、0049）。
 * 这里只放结构和判定（纯函数，有单测）；执行在 server/tasks/quota-resume.ts。
 */
import { z } from 'zod'
import type { AlertKind, CliLimits } from './schema.ts'

/** 备用顺序里的一项：model 为空表示这个 CLI 的默认模型 */
export const QuotaFallback = z.object({
  cli: z.string().trim().min(1).max(40),
  model: z.string().trim().max(200).default(''),
})
export type QuotaFallback = z.infer<typeof QuotaFallback>

export const QuotaResumeSettings = z
  .object({
    /** 到点自动继续：知道恢复时间（或被限流）时等到点再继续 */
    waitReset: z.boolean().catch(false).default(false),
    /** 按备用顺序换模型接着做 */
    fallback: z.boolean().catch(false).default(false),
    order: z.array(QuotaFallback).max(12).catch([]).default([]),
  })
  .prefault({})
export type QuotaResumeSettings = z.infer<typeof QuotaResumeSettings>

/**
 * 对话上的记录：同一条输入（用户最近一条消息）之后自动接了几次、换过哪些模型、在等到什么时候。
 * 用户发了新消息（input 变了）就从头算；until 在新的一轮开始时清掉
 */
export const QuotaResumeState = z.object({
  input: z.string().default(''),
  n: z.number().int().min(0).default(0),
  /** 已经用过的 CLI:模型（含失败时正在用的那个）：换模型时不再换回去 */
  tried: z.array(z.string()).max(30).default([]),
  /** 等到这个时刻自动继续（ISO） */
  until: z.string().optional(),
  reason: z.enum(['quota', 'rate_limit']).optional(),
})
export type QuotaResumeState = z.infer<typeof QuotaResumeState>

/** 同一条输入之后最多自动接几次（换模型和到点继续合计）：兜住反复失败、来回切换 */
export const QUOTA_AUTO_MAX = 6
/** 被限流又不知道什么时候恢复：等这么久再试 */
export const RATE_LIMIT_WAIT_MS = 5 * 60_000
/** 恢复时间太远（超过这么久）就不等了：多半是读错了，或者是要充值的那种 */
export const RESET_WAIT_MAX_MS = 8 * 24 * 3600_000
/** 到点后再多等一会儿：重置时刻服务端那边可能还没刷新 */
export const RESET_SLACK_MS = 60_000

export const fallbackKey = (f: { cli: string; model: string }) => `${f.cli}:${f.model}`

type Msg = { role: string; step?: string; id: string; alert?: { kind: AlertKind; level: string; detail?: string } }

/** 用户最近一条消息的 id：自动接的次数按它分段 */
export function lastInputId(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === 'user' && !messages[i].step) return messages[i].id
  return ''
}

/**
 * 这一轮是不是因为额度用完 / 被限流失败的：从最后往前找到第一条红色告警（到用户最近一条消息为止），看它的分类。
 * 黄色的（CLI 自己在重试）不算：那时候还没失败
 */
export function quotaFailure(messages: Msg[]): { kind: 'quota' | 'rate_limit'; detail: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m.step) return undefined
    if (m.alert?.level !== 'error') continue
    const k = m.alert.kind
    return k === 'quota' || k === 'rate_limit' ? { kind: k, detail: m.alert.detail ?? '' } : undefined
  }
  return undefined
}

/**
 * 报错原文里写的恢复时间（毫秒时间戳），认不出返回 undefined：
 * - Claude Code 老版本：`Claude AI usage limit reached|1736000000`（秒）；
 * - 「try again in 1 hour 37 minutes」「resets in 2 days」这类相对时间；
 * - Claude Code 新版本：`resets 3am`、`resets 3:30pm`（本机时区，取下一个这个时刻）
 */
export function resetFromText(text: string, now: number): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(text)
  if (epoch) return Number(epoch[1]) * 1000
  // 只取「in」后面一小段里的「数字 + 单位」：「in 2 days, upgrade…」后面的字不影响
  const rel = /(?:try again|resets?|available)\s+in\s+([\d\sa-z,]{1,60})/i.exec(text)
  if (rel) {
    let ms = 0
    for (const [, n, u] of rel[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const unit = u.toLowerCase()
      const k = unit.startsWith('d')
        ? 86400_000
        : unit.startsWith('h')
          ? 3600_000
          : unit.startsWith('m')
            ? 60_000
            : unit.startsWith('s')
              ? 1000
              : 0
      ms += Number(n) * k
    }
    if (ms > 0) return now + ms
  }
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)
  if (clock) {
    let h = Number(clock[1]) % 12
    if (clock[3].toLowerCase() === 'pm') h += 12
    const d = new Date(now)
    d.setHours(h, Number(clock[2] ?? 0), 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return undefined
}

/**
 * CLI 推来的额度窗口里的恢复时间：用满的窗口里最晚的那个（几个窗口都满了要等最晚的）；
 * 标着被限流但没有哪个窗口满（只推了部分窗口）时取最早的那个
 */
export function resetFromLimits(limits: CliLimits | null | undefined, now: number): number | undefined {
  const future = (limits?.windows ?? []).filter((w) => w.resetsAt && w.resetsAt > now)
  const full = future.filter((w) => w.usedPercent >= 99)
  if (full.length) return Math.max(...full.map((w) => w.resetsAt!))
  if (limits?.limited && future.length) return Math.min(...future.map((w) => w.resetsAt!))
  return undefined
}

export type QuotaPlan =
  | { type: 'switch'; to: QuotaFallback; state: QuotaResumeState }
  | { type: 'wait'; until: number; known: boolean; state: QuotaResumeState }
  | { type: 'none'; why: 'off' | 'max' | 'unknown' | 'far' | 'exhausted'; state?: QuotaResumeState }

/**
 * 这一轮因为额度 / 限流失败后怎么接：先按备用顺序换一个还没用过的；换完了（或没开）再看能不能等到点。
 * usable：这一项现在能不能用（CLI 启用着、角色固定了 CLI 时只能换同一个 CLI 的模型），由调用方判断
 */
export function planQuotaResume(o: {
  settings: QuotaResumeSettings
  kind: 'quota' | 'rate_limit'
  detail: string
  current: { cli: string; model: string }
  input: string
  state?: QuotaResumeState
  limits?: CliLimits | null
  now: number
  usable: (f: QuotaFallback) => boolean
}): QuotaPlan {
  const { settings: s, now } = o
  if (!s.waitReset && !(s.fallback && s.order.length)) return { type: 'none', why: 'off' }
  const prev = o.state?.input === o.input ? o.state : undefined
  const tried = new Set(prev?.tried ?? [])
  tried.add(fallbackKey(o.current))
  const base: QuotaResumeState = { input: o.input, n: prev?.n ?? 0, tried: [...tried], reason: o.kind }
  if (base.n >= QUOTA_AUTO_MAX) return { type: 'none', why: 'max', state: base }
  const next = { ...base, n: base.n + 1 }
  if (s.fallback) {
    const to = s.order.find((f) => !tried.has(fallbackKey(f)) && o.usable(f))
    if (to) return { type: 'switch', to, state: { ...next, tried: [...tried, fallbackKey(to)] } }
  }
  // 备用的都用过了、又没开到点继续
  if (!s.waitReset) return { type: 'none', why: 'exhausted', state: base }
  const at = resetFromText(o.detail, now) ?? resetFromLimits(o.limits, now)
  if (at === undefined) {
    // 额度用完又不知道什么时候恢复（多半要充值）：等也没用
    if (o.kind === 'quota') return { type: 'none', why: 'unknown', state: base }
    const until = now + RATE_LIMIT_WAIT_MS
    return { type: 'wait', until, known: false, state: { ...next, until: new Date(until).toISOString() } }
  }
  if (at - now > RESET_WAIT_MAX_MS) return { type: 'none', why: 'far', state: base }
  const until = Math.max(at + RESET_SLACK_MS, now + RESET_SLACK_MS)
  return { type: 'wait', until, known: true, state: { ...next, until: new Date(until).toISOString() } }
}

/** 对话里写的恢复时刻：同一天只写时分，否则带上月日（面板跑在用户本机，用本机时区） */
export function untilText(at: number, now: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  return new Date(now).toDateString() === d.toDateString() ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
}
