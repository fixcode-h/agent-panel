/**
 * Agent 流程的数据（扩展 4）：Bug 流程有 shared/bug/stats.ts，普通 Agent 流程原来没有同口径的数字——
 * 一个对话被面板推了几次、交代结束时说做完还是卡住、评审退回几轮、子对话合回失败几次、等用户等了多久、哪个角色返工最多。
 * 这些事实面板都记了（Task.driveCount、turnEnds、评审和收尾的返工、trackWait），这里只汇总，不改任何流程行为；
 * 只看面板记录和工具调用，不看回复文字（ADR 0041、0049）。
 *
 * 这个文件只放精简行的形状和汇总（界面、评测脚本都用）；从完整任务裁精简行在 agent-flow-briefs.ts，
 * 免得界面为了算几个平均数把导出那一大块也打包进来
 */

/** 一个 Agent 模式对话（项目里的顶层对话或子对话）的流程数据：总览页和评测脚本都按这个形状算 */
export interface FlowBrief {
  id: string
  title: string
  projectId: string
  parentTaskId: string
  /** 点一行要打开的顶层对话；自己就是顶层对话时为空 */
  rootId: string
  /** 顶层对话右栏里要打开的子对话：自己，或它在顶层对话名下的那个祖先 */
  paneId: string
  /** 对话的角色；没选角色为空 */
  agentId: string
  createdAt: string
  updatedAt: string
  /** 用户报的 Bug：它另有一套统计（bug-stats），这里照算，只是界面上能分开看 */
  bug: boolean
  /** 面板推它「接着做」的累计次数（Task.driveCount.total） */
  drives: number
  /** 跑了几轮（一次 CLI 调用一轮） */
  turns: number
  /** 用 end_turn 交代的结束：做完几次、卡住几次（面板只留最近 50 条） */
  ends: { done: number; blocked: number }
  /** 评审退回：工作流节点验收不通过重做，加上派出去的评审、测试子任务给了不通过 */
  reviewRejects: number
  /** 子对话请父对话收尾、没能合回原分支被退回来的次数 */
  mergeFails: number
  /** 子对话已经被父对话合回 / 收下 */
  merged: boolean
  /** 等用户确认、回答问题的累计毫秒数（含正在等的这一段）；答完后等下一句不算 */
  waitMs: number
  /** 输入加输出 token */
  tokens: number
  costUsd: number
}

/** 按角色的一行：哪个角色推得最多、返工最多 */
export interface FlowRole {
  agentId: string
  convs: number
  drives: number
  reviewRejects: number
  mergeFails: number
  waitMs: number
  tokens: number
}

/** 汇总。比例和平均值没有样本时是 undefined，界面画成「—」，不写 0 让人误会 */
export interface FlowSummary {
  total: number
  tops: number
  children: number
  drives: number
  /** 每个对话平均被推几次 */
  avgDrives?: number
  turns: number
  endDone: number
  endBlocked: number
  /** 交代结束时说卡住的占比（0–1）：只算交代过结束的 */
  blockedRate?: number
  reviewRejects: number
  /** 被评审退回过的对话个数 */
  rejectedConvs: number
  mergeFails: number
  /** 合回过的子对话个数 */
  mergedKids: number
  /** 子对话一次合回的比例（0–1）：只算合回过的，有过合回失败的不算一次 */
  mergeFirstRate?: number
  waitMs: number
  /** 等过你的对话个数，平均等待只按它们算：没问过你的对话拉低平均没意义 */
  waitedConvs: number
  avgWaitMs?: number
  tokens: number
  costUsd: number
  avgTokens?: number
  /** 按角色：返工（评审退回 + 合回失败）多的在前，一样多时推得多的在前 */
  roles: FlowRole[]
}

const avg = (sum: number, n: number) => (n ? sum / n : undefined)
const sum = (xs: FlowBrief[], f: (x: FlowBrief) => number) => xs.reduce((n, x) => n + f(x), 0)

/** 一个对话的返工次数：评审退回加合回失败，「返工最多」按它排 */
export const flowReworks = (x: Pick<FlowBrief, 'reviewRejects' | 'mergeFails'>) => x.reviewRejects + x.mergeFails

/** 一组对话的流程数据汇总；回收站里的由调用方先排掉（agentFlowBriefs 已经排了） */
export function agentStats(list: FlowBrief[]): FlowSummary {
  const total = list.length
  const children = list.filter((x) => x.parentTaskId).length
  const drives = sum(list, (x) => x.drives)
  const endDone = sum(list, (x) => x.ends.done)
  const endBlocked = sum(list, (x) => x.ends.blocked)
  const merged = list.filter((x) => x.parentTaskId && x.merged)
  const waited = list.filter((x) => x.waitMs > 0)
  const waitMs = sum(waited, (x) => x.waitMs)
  const tokens = sum(list, (x) => x.tokens)

  const byRole = new Map<string, FlowRole>()
  for (const x of list) {
    const r = byRole.get(x.agentId) ?? {
      agentId: x.agentId,
      convs: 0,
      drives: 0,
      reviewRejects: 0,
      mergeFails: 0,
      waitMs: 0,
      tokens: 0,
    }
    r.convs++
    r.drives += x.drives
    r.reviewRejects += x.reviewRejects
    r.mergeFails += x.mergeFails
    r.waitMs += x.waitMs
    r.tokens += x.tokens
    byRole.set(x.agentId, r)
  }
  const roles = [...byRole.values()].sort((a, b) => flowReworks(b) - flowReworks(a) || b.drives - a.drives)

  return {
    total,
    tops: total - children,
    children,
    drives,
    avgDrives: avg(drives, total),
    turns: sum(list, (x) => x.turns),
    endDone,
    endBlocked,
    blockedRate: avg(endBlocked, endDone + endBlocked),
    reviewRejects: sum(list, (x) => x.reviewRejects),
    rejectedConvs: list.filter((x) => x.reviewRejects > 0).length,
    mergeFails: sum(list, (x) => x.mergeFails),
    mergedKids: merged.length,
    mergeFirstRate: avg(merged.filter((x) => !x.mergeFails).length, merged.length),
    waitMs,
    waitedConvs: waited.length,
    avgWaitMs: avg(waitMs, waited.length),
    tokens,
    costUsd: sum(list, (x) => x.costUsd),
    avgTokens: avg(tokens, total),
    roles,
  }
}

/** 返工最多的几个对话：一个都没返工、也没被推过的不列，免得列表里全是 0 */
export function flowHotspots(list: FlowBrief[], max = 10): FlowBrief[] {
  return list
    .filter((x) => flowReworks(x) > 0 || x.drives > 0)
    .sort((a, b) => flowReworks(b) - flowReworks(a) || b.drives - a.drives || b.waitMs - a.waitMs)
    .slice(0, max)
}
