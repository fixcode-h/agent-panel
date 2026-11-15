import type { Task, Agent } from '../../../shared/schema.ts'
import type { TurnInfo } from '../../exec/turn-info.ts'
import { createDrive } from '../drive.ts'
import type { TasksScope } from '../scope.ts'
import type { ChildrenCtx } from './context.ts'
import { activeChildren, childActive, childCountsOf, childrenRunning, cliChildren } from './count.ts'
import { reportChild, reportKey } from './report.ts'
import { advanceChildTo, integrate } from './complete.ts'
import { closeChildren } from './stop.ts'
import { reportToParent, settleChildTurn, settleChildWorktree } from './turn-end.ts'
import { ruleCommand } from './rule.ts'
import { startChild } from './start.ts'

/**
 * 子对话的生命周期：在跑的计数、彻底完成的判定和推进（advanceChildTo，ADR 0003）、合回、上报父对话、规则命令、启动子对话。
 * 一轮结束时推进计划（nudgePlan，ADR 0032 / 0041）在 drive.ts。
 * 这里只建共享状态（ChildrenCtx，见 context.ts）并接线，各块在同目录：
 * 计数 count.ts、启动 start.ts、上报 report.ts、停止 stop.ts、完成 complete.ts、一轮结束收口 turn-end.ts、规则 rule.ts
 */
export function createChildren(sc: TasksScope) {
  // 一轮结束时的推进（自驱，ADR 0041）放在 drive.ts；它要上报子对话、看名下子对话在不在跑。
  // 这两个回调只在之后的一轮结束时才调，那时 ctx 已经建好
  const drive = createDrive(sc, {
    reportChild: (id) => reportChild(ctx, id),
    activeChildren: (id) => activeChildren(ctx, id),
  })
  const ctx: ChildrenCtx = {
    sc,
    drive,
    reportedDone: new Set<string>(),
    reportedState: new Map<string, string>(),
    mergeStalls: new Map(),
    completing: new Map(),
    counts: { scan: null },
  }
  const { nudgePlan, nudgeWrapUp, beforeEnd, nudgeState, resetNudge, noteStop, clearStop } = drive

  return {
    activeChildren: (parentId: string) => activeChildren(ctx, parentId),
    advanceChildTo: (childId: string, opts?: { quiet?: boolean; fromUser?: boolean }) =>
      advanceChildTo(ctx, childId, opts),
    childActive: (tk: Task) => childActive(sc, tk),
    childrenRunning: (parentId: string) => childrenRunning(sc, parentId),
    cliChildren: (parentId: string) => cliChildren(ctx, parentId),
    closeChildren: (parentId: string) => closeChildren(sc, parentId),
    completing: ctx.completing,
    nudgePlan,
    nudgeWrapUp,
    beforeEnd,
    nudgeState,
    noteStop,
    clearStop,
    resetNudge,
    reportToParent: (task: Task) => reportToParent(ctx, task),
    reportedDone: ctx.reportedDone,
    reportedState: ctx.reportedState,
    ruleCommand: (id: string, text: string) => ruleCommand(sc, id, text),
    settleChildTurn: (child: Task, turn?: TurnInfo) => settleChildTurn(ctx, child, turn),
    startChild: (sub: Task, message: string, agents: Agent[]) => startChild(sc, sub, message, agents),
    childCountsOf: (parentId: string) => childCountsOf(ctx, parentId),
    settleChildWorktree: (childId: string, turn?: TurnInfo) => settleChildWorktree(ctx, childId, turn),
    reportKey,
    integrate: (tk: Task, parent: Task) => integrate(sc, tk, parent),
  }
}
