import { t } from './i18n.ts'
import { fmtTokens } from './budget.ts'

/**
 * 用量速率提醒（分析稿 A6 ②）：最近 10 分钟烧得比这个对话平时快很多时，在对话里提醒一次。
 * 用量上限只在总量到了 80% 才说话，模型陷进反复读大文件、反复重试这类循环时，等它报警钱已经花出去一大截。
 *
 * 口径（全按整棵对话树算，和用量上限一致）：
 * - 速率 = token / 执行时间（各对话 runMs 相加）。按执行时间而不是墙上时间：几个子对话并行时总量自然翻几倍，
 *   用户离开一晚上再回来也不会把平均速率拉低到一回来就报
 * - 平均速率取「窗口开始之前」的那段（不含最近 10 分钟本身），免得飙升把平均也拉高、永远到不了倍数
 * - 绝对量有下限：最近 10 分钟至少用了 RATE_MIN_TOKENS，窗口之前至少跑过 RATE_MIN_HISTORY_MS，刚开始的对话不报
 * - 只提醒、不停（停是用量上限的事），每个对话只提醒一次（Task.rateNoticeAt），不碰 budgetNotice（通知渠道按它发）
 * 样本在每一轮结束核用量上限时记（server/tasks/budget.ts），只在内存里：面板重启后重新攒，前 10 分钟不报
 */

/** 看最近多久 */
export const RATE_WINDOW_MS = 10 * 60_000
/** 超过平均速率的几倍才提醒 */
export const RATE_FACTOR = 3
/** 最近 10 分钟至少用了这么多 token 才提醒：量小的飙升不值得打断 */
export const RATE_MIN_TOKENS = 300_000
/** 窗口之前至少要跑过这么久，平均速率才有意义 */
export const RATE_MIN_HISTORY_MS = 10 * 60_000
/** 基线样本最旧能到多久以前：中间一轮都没结束、只剩很早的样本时，「最近」已经不是最近了，不判 */
const RATE_BASE_MAX_MS = 3 * RATE_WINDOW_MS

export interface RateSample {
  /** 记样本的时刻（epoch ms） */
  at: number
  /** 整棵树累计的 token（输入 + 输出） */
  tokens: number
  /** 整棵树累计的执行时间（毫秒） */
  runMs: number
}

type RunOf = { id: string; parentTaskId?: string; runMs?: number; runStartedAt?: string }

/** 整棵对话树的执行时间：各对话已累计的 runMs，加上正在跑的这一段 */
export function treeRunMs(rootId: string, tasks: RunOf[], now = Date.now()): number {
  const kids = new Map<string, RunOf[]>()
  for (const tk of tasks) if (tk.parentTaskId) kids.set(tk.parentTaskId, [...(kids.get(tk.parentTaskId) ?? []), tk])
  const root = tasks.find((x) => x.id === rootId)
  let ms = 0
  const seen = new Set<string>()
  const walk = (tk: RunOf) => {
    if (seen.has(tk.id)) return
    seen.add(tk.id)
    ms += tk.runMs ?? 0
    const from = tk.runStartedAt ? Date.parse(tk.runStartedAt) : NaN
    if (Number.isFinite(from) && from < now) ms += now - from
    for (const k of kids.get(tk.id) ?? []) walk(k)
  }
  if (root) walk(root)
  return ms
}

/** 加一个样本并丢掉用不上的旧样本：留到「窗口开始之前最近的那一个」为止 */
export function addSample(list: RateSample[], s: RateSample): RateSample[] {
  const all = [...list.filter((x) => x.at < s.at), s]
  const cut = s.at - RATE_WINDOW_MS
  let keepFrom = 0
  for (let i = 0; i < all.length; i++) if (all[i].at <= cut) keepFrom = i
  return all.slice(keepFrom)
}

export interface RateSpike {
  /** 最近这段用了多少 token */
  tokens: number
  /** 最近这段有多少分钟（墙上时间，至少 10） */
  minutes: number
  /** 是平均速率的几倍 */
  factor: number
}

/** 最后一个样本相对窗口开始前的基线是不是飙升了；不够判断或没飙升返回 undefined */
export function rateSpike(list: RateSample[]): RateSpike | undefined {
  const now = list.at(-1)
  if (!now) return undefined
  const base = [...list].reverse().find((x) => x.at <= now.at - RATE_WINDOW_MS)
  if (!base || now.at - base.at > RATE_BASE_MAX_MS) return undefined
  if (base.runMs < RATE_MIN_HISTORY_MS || base.tokens <= 0) return undefined
  const tokens = now.tokens - base.tokens
  const runMs = now.runMs - base.runMs
  // 这段几乎没在跑（不到一分钟）：除出来的速率没有意义
  if (tokens < RATE_MIN_TOKENS || runMs < 60_000) return undefined
  const factor = tokens / runMs / (base.tokens / base.runMs)
  if (factor < RATE_FACTOR) return undefined
  return { tokens, minutes: Math.round((now.at - base.at) / 60_000), factor }
}

/** 对话里那一条提醒 */
export function rateNote(s: RateSpike): string {
  return t(
    '【用量提醒】最近 {min} 分钟这个对话和名下子对话用了 {tokens} token，速率是它平均的 {x} 倍。面板没有停下它；看一下是不是在反复做同一件事，要限住可以停下它，或调低用量上限。',
    { min: s.minutes, tokens: fmtTokens(s.tokens), x: Math.floor(s.factor) },
  )
}
