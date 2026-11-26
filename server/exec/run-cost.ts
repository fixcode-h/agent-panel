/**
 * 一轮的费用记多少（2026-11-26 复盘 P1-11，用户定：非 Anthropic 模型由面板按价格表算）。
 * 两个坑：
 * - Claude Code 接 DeepSeek 这类第三方模型时，total_cost_usd 是按 Claude 的单价算的，数是错的：
 *   模型目录认得出是别家模型时不信 CLI 的数，只按用户填的单价折算，没填单价记 0（界面不显示费用）。
 * - total_cost_usd 是「会话」累计，续接会话的新进程里第一次报就带着上次的累计，以前按进程从 0 做差，续接一次就重复记一遍。
 *   改成按会话 id 记住上次的累计（task.usage.sessionCost），新进程接着做差。
 */
import type { ModelCatalogEntry } from '../../shared/models/catalog.ts'
import { priceCost } from '../../shared/models/price.ts'
import type { Task } from '../../shared/schema.ts'
import type { CliEvent } from './parsers.ts'

type UsageEvent = Extract<CliEvent, { type: 'usage' }>

/** 记住的会话个数上限：只为续接时做差，老会话丢了也只是下次续接按进程做差 */
const KEEP_SESSIONS = 50

export function turnCost(task: Task, ev: UsageEvent, entry: ModelCatalogEntry | undefined): number {
  if (entry && entry.vendor.toLowerCase() !== 'anthropic') return priceCost(entry.price, ev)
  if (ev.costTotal === undefined || !ev.costSession) return ev.addCost ?? priceCost(entry?.price, ev)
  const seen = (task.usage.sessionCost ??= {})
  const before = seen[ev.costSession]
  delete seen[ev.costSession]
  seen[ev.costSession] = Math.max(before ?? 0, ev.costTotal)
  for (const k of Object.keys(seen).slice(0, -KEEP_SESSIONS)) delete seen[k]
  return before === undefined ? (ev.addCost ?? 0) : Math.max(0, ev.costTotal - before)
}
