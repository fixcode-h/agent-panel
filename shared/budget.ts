/**
 * 父对话的用量上限：一个顶层对话加上它名下全部子对话（多层）合起来的 token 和费用。
 *
 * 父对话一放开跑，子对话、子任务、面板推它接着做都在花钱，单看某一个对话的用量看不出整件事花了多少；
 * 上限按项目设（Project.budget），对项目里每个顶层对话各算一份。到 80% 在父对话里提醒一次，
 * 到 100% 停下整棵对话树并写明原因（见 server/tasks/budget.ts）。两项都是 0 表示不限（默认）。
 */
import { t } from './i18n.ts'
import type { Task } from './schema.ts'

export type Budget = { tokens: number; costUsd: number }
export type BudgetUse = { tokens: number; costUsd: number }
/** none：没设上限；ok：没到提醒线；warn：过了 80%；over：到了上限 */
export type BudgetLevel = 'none' | 'ok' | 'warn' | 'over'

/** 提醒线：用到上限的这个比例时提醒一次 */
export const BUDGET_WARN = 0.8

type Usage = Pick<Task, 'id' | 'parentTaskId'> & { usage?: Partial<Task['usage']> }

const tokensOf = (tk: Usage) => (tk.usage?.inputTokens ?? 0) + (tk.usage?.outputTokens ?? 0)

/**
 * 按对话树合计用量：返回「给一个对话 id，算它自己加名下全部子对话（多层）的用量」。
 * 父子关系只建一次，总览页一次算几百个顶层对话时不用每个都重扫全表。
 * 进了回收站的子对话照样算：钱已经花出去了，总览页和用量上限必须是同一个数
 */
export function treeUsage(tasks: Usage[]): (rootId: string) => BudgetUse {
  const kids = new Map<string, Usage[]>()
  const byId = new Map<string, Usage>()
  for (const tk of tasks) {
    byId.set(tk.id, tk)
    if (tk.parentTaskId) kids.set(tk.parentTaskId, [...(kids.get(tk.parentTaskId) ?? []), tk])
  }
  return (rootId) => {
    const use: BudgetUse = { tokens: 0, costUsd: 0 }
    const seen = new Set<string>()
    const walk = (tk: Usage) => {
      if (seen.has(tk.id)) return
      seen.add(tk.id)
      use.tokens += tokensOf(tk)
      use.costUsd += tk.usage?.costUsd ?? 0
      for (const k of kids.get(tk.id) ?? []) walk(k)
    }
    const root = byId.get(rootId)
    if (root) walk(root)
    return use
  }
}

/** 一个顶层对话加名下全部子对话（多层）的用量；tasks 里没有的对话不算 */
export const budgetUse = (rootId: string, tasks: Usage[]): BudgetUse => treeUsage(tasks)(rootId)

/** 用到上限的比例：两项里取更高的那个；都没设时是 0 */
export function budgetRatio(use: BudgetUse, budget: Budget | undefined): number {
  if (!budget) return 0
  return Math.max(
    budget.tokens > 0 ? use.tokens / budget.tokens : 0,
    budget.costUsd > 0 ? use.costUsd / budget.costUsd : 0,
  )
}

export function budgetLevel(use: BudgetUse, budget: Budget | undefined): BudgetLevel {
  if (!budget || (budget.tokens <= 0 && budget.costUsd <= 0)) return 'none'
  const r = budgetRatio(use, budget)
  return r >= 1 ? 'over' : r >= BUDGET_WARN ? 'warn' : 'ok'
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

/** 「已用 / 上限」的说法：只列设了的那几项，例如「1.2M / 1.5M token，$3.10 / $5.00」 */
export function budgetSpent(use: BudgetUse, budget: Budget): string {
  const parts: string[] = []
  if (budget.tokens > 0)
    parts.push(t('{used} / {cap} token', { used: fmtTokens(use.tokens), cap: fmtTokens(budget.tokens) }))
  if (budget.costUsd > 0)
    parts.push(t('${used} / ${cap}', { used: use.costUsd.toFixed(2), cap: budget.costUsd.toFixed(2) }))
  return parts.join(' · ')
}

/** 父对话里那一条提醒：过了提醒线 / 到了上限 */
export function budgetNote(level: 'warn' | 'over', use: BudgetUse, budget: Budget): string {
  const spent = budgetSpent(use, budget)
  return level === 'warn'
    ? t(
        '【用量提醒】这个对话和名下子对话合起来已经用到项目设的上限的 {pct}%（{spent}）。到上限时面板会停下整个对话。',
        {
          pct: Math.floor(budgetRatio(use, budget) * 100),
          spent,
        },
      )
    : t(
        '【用量上限】这个对话和名下子对话合起来已经用到项目设的上限（{spent}），面板停下了整个对话。你再发消息时会接着跑一轮，跑完又会停下；要放开跑，在项目设置「用量上限」里调高或清零。',
        { spent },
      )
}
