/**
 * 子对话、父对话计划最后一步的收尾是哪种（从 plan.ts 拆出来）：判定和「谁来标完成」放在一起，
 * 收尾的必备步骤不跟着版本管理方式变（ADR 0035）
 */
import type { PlanStep } from './schema.ts'

/**
 * 收尾步骤的种类，永远是计划的最后一步：merge 子对话的独立分支合回父对话所在的分支，
 * p4 子对话按文件类型分进各自的 pending changelist 再请父对话验收，deliver 共用目录 / 没有版本管理的子对话请父对话验收，
 * push 父对话把当前分支推到远端
 */
export type WrapUpKind = NonNullable<PlanStep['wrapUp']>

/**
 * 这个对话的计划要不要收尾、收哪种（见 ensureWrapUp）：判定和提示词里「授权情况」那段同一套口径，
 * 免得计划里有一步推送、提示词却写着不许推（或者反过来）
 */
export interface WrapUpInput {
  /** 父对话（用户直接对话的那个）还是子对话 */
  child: boolean
  /** 子对话在独立分支里改（或者要改的时候才开分支） */
  isolated?: boolean
  /** P4 工作区 */
  p4?: boolean
  /** Git 仓库：推送收尾只在 Git 里成立 */
  git?: boolean
  /** 项目设置的推送策略 */
  push?: 'ask' | 'allow' | 'deny'
  /** 这个对话里用户对推送做过的选择 */
  answered?: 'allowed' | 'denied'
}

export function wrapUpKind(x: WrapUpInput): WrapUpKind | undefined {
  // 子对话不管用哪种版本管理都要请父对话收尾：评审、测试、交接、父对话验收这些必备的步骤都挂在 submit_merge 上，
  // 以前只有独立分支有这一步，P4、共用目录、没有版本管理的子对话改完就算完成，评审和验收全被跳过（用户 2026-10-31 报的）
  if (x.child) {
    if (x.isolated) return 'merge'
    return x.p4 ? 'p4' : 'deliver'
  }
  // 父对话只在明确授权推送时才有这一步：项目设置「不推送」和用户拒绝过都不加；「第一次问一次」还没回答时也不加，
  // 等这一轮问完、下一轮带上 answered 再加。P4 工作区的改动走 changelist，不推 git（工作区建在 git 仓库目录下时
  // 也认到 .git，推上去的会是旧历史）
  if (x.p4 || x.push === 'deny' || x.answered === 'denied') return undefined
  const allowed = x.answered === 'allowed' || x.push === 'allow'
  return allowed && x.git ? 'push' : undefined
}

/**
 * 子对话的收尾：只由面板在父对话收下之后标完成（合回分支、验收），Agent 自己标完成不算。
 * merge 是独立分支合回，p4 是分好 changelist 后请验收，deliver 是共用目录 / 没有版本管理时请验收
 */
export const PANEL_WRAPS: readonly WrapUpKind[] = ['merge', 'p4', 'deliver']
export const panelWrap = (kind: PlanStep['wrapUp']) => !!kind && PANEL_WRAPS.includes(kind)
