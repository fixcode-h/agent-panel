import { type Task } from '../../../shared/schema.ts'
import { planProgressKey } from '../../../shared/drive.ts'
import { activePlan } from '../../../shared/plan/index.ts'
import type { TasksScope } from '../scope.ts'
import type { MergeCtx } from './context.ts'
import { submitMerge } from './submit.ts'
import { childRequestBuild, parentRequestBuild } from './build.ts'
import { wakeTask } from './wake.ts'
import { peerList } from './peers.ts'
import { childMerged } from './after-merge.ts'
import { finishChild, planKids } from './report.ts'

/** 去掉第一个参数（共享的 sc / ctx）后的参数表：对外的签名和拆分前一样 */
type Rest<F> = F extends (first: never, ...rest: infer R) => unknown ? R : never

/**
 * 子对话收尾：submit_merge 合回父对话分支（评审门禁、合并时编译）、UE 编译请求、就地微改动、finish_child、父计划里等子对话的那一步。
 * 按 ADR 0018 的阶段分文件，这里只建共享状态（MergeCtx）并接线：
 * - submit.ts：子对话请求收尾（submit_merge 的各道校验、提交到分支、交给父对话）
 * - integrate.ts：父对话收下（finish_child 的校验、合回、按失败类别退回）；共用目录的验收
 * - after-merge.ts：合回之后（交给父对话测试队列，或 childMerged 收口）
 * - report.ts：收尾上报（限时回话、刷新父计划、提醒清理模块文档）
 * - build.ts：UE 编译申请；wake.ts：把消息交给对话；peers.ts：同项目的其他父对话
 */
export function createMerge(sc: TasksScope) {
  const ctx: MergeCtx = {
    sc,
    merging: new Set<string>(),
    mergeNudged: new Set<string>(),
    planNudged: new Map<string, string>(),
    wrapRecheckMs: Number(process.env.AGENT_PANEL_WRAP_RECHECK_MS) || 60_000,
  }
  /** 面板已经按这个进度推满了（nudgePlan），它还停在原地 */
  const stuckAfterNudge = (tk: Task) => {
    const plan = activePlan(tk)
    return !!plan && ctx.planNudged.get(tk.id) === planProgressKey(plan)
  }
  /** 一轮结束后等多久再推「接着做计划」：等 CLI 停到等下一句上；测试用环境变量缩短 */
  const PLAN_NUDGE_MS = Number(process.env.AGENT_PANEL_PLAN_NUDGE_MS) || 2000

  return {
    PLAN_NUDGE_MS,
    childRequestBuild: (...a: Rest<typeof childRequestBuild>) => childRequestBuild(sc, ...a),
    finishChild: (...a: Rest<typeof finishChild>) => finishChild(ctx, ...a),
    mergeNudged: ctx.mergeNudged,
    merging: ctx.merging,
    parentRequestBuild: (...a: Rest<typeof parentRequestBuild>) => parentRequestBuild(sc, ...a),
    peerList: (...a: Rest<typeof peerList>) => peerList(sc, ...a),
    planNudged: ctx.planNudged,
    stuckAfterNudge,
    submitMerge: (...a: Rest<typeof submitMerge>) => submitMerge(ctx, ...a),
    wakeTask: (...a: Rest<typeof wakeTask>) => wakeTask(sc, ...a),
    planKids: (...a: Rest<typeof planKids>) => planKids(sc, ...a),
    childMerged: (...a: Rest<typeof childMerged>) => childMerged(ctx, ...a),
  }
}
