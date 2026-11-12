/**
 * 子对话栏的一行（`GET /tasks/:id/children`）和父对话的三项子对话计数：正式后端
 * （server/tasks/children-routes.ts、list-routes.ts、children.ts）和演示后端（web/src/lib/demo-*.ts）
 * 都调这里，只把「真进程、真 git」这类只有一边有的东西作为参数传进来。
 * 以前两边各拼一份，演示版漏了字段或口径（例如等孙对话时的 childNeeds、回收站里的子对话）界面检查也看不出来。
 */
import { bugStage } from '../bug/diagnosis.ts'
import { childBugStep, lastToolCall } from '../child-doing.ts'
import { descendantNeeds, pendingRequest } from '../child-needs.ts'
import { openPlan } from '../plan.ts'
import type { Task } from '../schema.ts'
import {
  childActivity,
  childFacts,
  childLastActivity,
  childStartedAt,
  childWait,
  convActive,
  convState,
  diagnosisPending,
  runRunning,
  taskGone,
} from '../task.ts'
import { helpersWorking } from '../task-helpers.ts'
import { pendingAction } from '../user-action.ts'

/** 独立分支的 git 核对结果：没核对过（checked 为 false）时界面不能把「不知道」当成干净或已合回 */
export interface ChildWorktreeRead {
  checked: boolean
  value: { merged: boolean; ahead?: number; dirty: number } | null
}

/** 拼一行要用、但只有调用方知道的东西 */
export interface ChildRowEnv {
  /** 进程还活着（正式版看进程登记，演示版看 live 登记） */
  cliAlive: boolean
  /** 还在跑 / 排队的后台命令数：CLI 在等命令结果时也算还没做完 */
  background: number
  /** 后代对话里在等用户处理的个数（见 descendantNeeds） */
  childNeeds: number
  /** 独立分支的 git 核对结果 */
  worktree: ChildWorktreeRead
  /**
   * 手上是完整对话（在内存里）：只有摘要（store.list 只留用户消息）时算不出准确的「在做什么」，
   * 这两项不给，免得拿摘要猜出一个错的
   */
  full: boolean
  /** 还没生成摘要时的兜底：最后一条回复的开头 */
  lastReply: string
  /** 停下的原因（正式版要按回收规则补，见 server/tasks.ts 的 idle） */
  stopReason: Task['stopReason']
}

/** 子对话栏的一行：字段的含义见 shared/task.ts 的 ChildEntry 和 web 的 ChildSummary */
export function childRow(x: Task, env: ChildRowEnv) {
  const doing = env.full ? childActivity(x) : undefined
  const open = openPlan(x)
  const wt = env.worktree
  return {
    id: x.id,
    title: x.title,
    status: x.status,
    summary: x.summary || env.lastReply,
    working: x.working,
    updatedAt: x.updatedAt,
    // 进程还活着（预热、等下一句、正在执行）：不用 status === 'running' 猜
    cliAlive: env.cliAlive,
    // 排序按本次开启的时间：做完或停下后又接到新任务会开新的一轮，重新排到最前面
    startedAt: childStartedAt(x),
    // 等用户确认的请求数；第一条直接写在行上，给「允许 / 拒绝」，不用点进子对话
    requests: (x.requests ?? []).length,
    request: pendingRequest(x),
    childNeeds: env.childNeeds,
    // 后台命令跑在服务端，CLI 只是在等结果：有这个就还当执行中，不能显示成已完成
    background: env.background,
    // 工作流运行还没跑完：流程图跑着时这一轮的 CLI 可能早就结束了
    workflow: runRunning(x),
    // 等用户确认诊断报告（ADR 0045）、挂着等你操作：算执行中 / 等你处理
    diagnosis: diagnosisPending(x),
    action: !!pendingAction(x),
    // 用户报的 Bug（ADR 0046）：查到哪个阶段、五步里的第几步
    bug: bugStage(x) || undefined,
    bugStep: childBugStep(x),
    // 它派出去的子任务还在跑：结果交回来它还要接着做
    helpers: helpersWorking(x),
    // 计划没做完（如「计划 7/8」）：不算已完成；带上正在做的那一步
    plan: open ? { ...open, step: doing?.plan?.title, child: doing?.plan?.child } : undefined,
    // 没有核对结果时两项都不给（不是 0 / false）：界面不能把「不知道」显示成「干净」或「已合回」
    unmerged: wt.checked ? !!wt.value && !wt.value.merged : undefined,
    dirty: wt.checked ? (wt.value?.dirty ?? 0) : undefined,
    worktreeChecked: wt.checked,
    // 已经请父对话收尾、还没出结果：行上是「待收尾」
    wrapup: !!x.wrapRequest && x.wrapRequest.state !== 'failed',
    // 两处不同就是「做完了还没看」（见 shared/task.ts 的 childDoneDot）
    turnDoneAt: x.turnDoneAt ?? '',
    turnSeenAt: x.turnSeenAt ?? '',
    // 请用户选择、还没人回答的提问数
    asking: x.parentAsks?.length ?? 0,
    branch: x.worktree?.branch ?? '',
    // 独立分支目录：停下时告诉用户改动在哪个目录里
    dir: x.worktree?.path ?? '',
    activity: doing,
    // 最后一次工具调用：行上写「计划这一步 · 改 store.ts」（分析稿 U5）
    lastTool: env.full ? lastToolCall(x) : undefined,
    // 最后有动静的时间：几分钟没有新输出、又不能用等待解释时标黄 / 标红
    lastActivityAt: childLastActivity(x),
    // 面板以父对话的名义自动问过它状态：之后还没有新输出时行上写「已自动询问，等回复」
    autoAsk: x.autoAsk,
    // 在等什么（等用户回答、等后台命令、等子任务、等工作流、等下一句）
    waiting: childWait(x, { background: env.background, cliAlive: env.cliAlive, childNeeds: env.childNeeds }),
    // 用户标记的「解决」：列表归到「已完成」并加标记，和 status / working 都无关
    resolved: x.resolved === true,
    analysis: x.analysis,
    stopReason: env.stopReason ?? ('' as const),
    // 已收起（归档 / 独立分支被删掉）：运行区、子对话栏、执行中计数都读这一处把它排掉
    gone: taskGone(x),
  }
}

/** 子对话栏的一行（正式后端和演示后端同一份形状，见 childRow） */
export type ChildRow = ReturnType<typeof childRow>

/**
 * 子对话按记录算还在不在运行（见 convActive）：在跑、等结果、等回答，或者还有交过来的消息要接着处理。
 * 正式版另外还要算「正在启动、还没取到执行位」的（server/tasks/children.ts 的 childActive），那部分只有它有
 */
export const childRecordActive = (tk: Task, background: number) => convActive(convState(childFacts(tk, { background })))

/** 父对话上的三项子对话计数：侧栏、子对话刷新信号、输入框「在等什么」都读它们 */
export interface ChildCounts {
  childrenWorking: number
  childrenCli: number
  childrenNeeds: number
}

/**
 * 一次扫完所有对话，按父对话算三项计数：还在运行的子对话、CLI 还活着的子对话、后代在等用户处理的个数。
 * 「在不在运行」「CLI 活没活」由调用方给（正式版看执行位和进程登记，演示版看 live 登记）
 */
export function childCountsScan(all: Task[], probe: { active: (k: Task) => boolean; cliAlive: (k: Task) => boolean }) {
  const byParent = new Map<string, { working: number; cli: number }>()
  for (const k of all) {
    if (!k.parentTaskId) continue
    const c = byParent.get(k.parentTaskId) ?? { working: 0, cli: 0 }
    if (probe.cliAlive(k)) c.cli++
    if (probe.active(k)) c.working++
    byParent.set(k.parentTaskId, c)
  }
  // 子对话在等你确认时父对话（以及更上层）也是「等你处理」（见 shared/child-needs.ts）
  const needs = descendantNeeds(all)
  return (parentId: string): ChildCounts => {
    const c = byParent.get(parentId)
    return { childrenWorking: c?.working ?? 0, childrenCli: c?.cli ?? 0, childrenNeeds: needs.get(parentId) ?? 0 }
  }
}
