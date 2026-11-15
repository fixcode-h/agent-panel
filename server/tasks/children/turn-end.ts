import { userWaiting, runRunning } from '../../../shared/task.ts'
import type { Task } from '../../../shared/schema.ts'
import { haltedTurn } from '../../../shared/stop-reason.ts'
import { helpersWorking } from '../../../shared/tasks/helpers.ts'
import type { TurnInfo } from '../../exec/turn-info.ts'
import { turnSettled } from '../../../shared/merge-stall.ts'
import { hasHeld } from '../../exec/delivery.ts'
import { worktreeStatus } from '../../exec/worktree.ts'
import { log } from '../../log.ts'
import { t } from '../../../shared/i18n.ts'
import { activePlan, openWork } from '../../../shared/plan/index.ts'
import { panelWrap } from '../../../shared/wrap-up.ts'
import { isolated } from '../helpers.ts'
import type { TasksScope } from '../scope.ts'
import { readTask } from '../read.ts'
import type { ChildrenCtx } from './context.ts'
import { advanceChildTo } from './complete.ts'
import { reportChild } from './report.ts'

/**
 * 子对话一轮结束 / 整次执行结束时的收口：独立分支能收就收（advanceChildTo），没请收尾的提醒一次（nudgeMerge），
 * 计划没做完的推它接着做（drive.ts 的 nudgePlan），最后统一上报父对话（report.ts）
 */

/**
 * 子对话这一轮结束了（CLI 报完成、停在等下一句，或者整次执行结束）：
 * 独立分支里的先试着收口（条件都满足就完成、回收；只差请求收尾时提醒它一次），再统一上报父对话。
 * 放到下一拍：别在 CLI 收尾的回调里结束它
 */
export function settleChildTurn(ctx: ChildrenCtx, child: Task, turn?: TurnInfo) {
  const { sc } = ctx
  if (!child.parentTaskId) return
  if (isolated(child) && !hasHeld(child.id) && !sc.merging.has(child.id) && !child.resolved) {
    setImmediate(
      () =>
        void settleChildWorktree(ctx, child.id, turn).catch((e) => {
          log.warn('task', '子对话一轮结束收口失败', { task: child.id, error: (e as Error).message })
          sc.alertOn(child.id, 'panel', t('这一轮结束后整理独立分支、上报父对话时出错'))(e)
        }),
    )
    return
  }
  void (async () => {
    // 共用目录的子对话（P4、没有版本管理）改完没请收尾：和独立分支一样提醒一次，评审、验收不因版本管理方式省掉
    if (!isolated(child) && !hasHeld(child.id) && !child.resolved && (await nudgeMerge(sc, child))) return
    if (await ctx.drive.nudgePlan(child, turn)) return
    await reportChild(ctx, child.id)
  })().catch((e) => {
    log.warn('task', '子对话状态上报失败', { task: child.id, error: (e as Error).message })
    sc.alertOn(child.id, 'delivery', t('这个对话的状态没能报给父对话'))(e)
  })
}

/**
 * 一轮结束后收口子对话的独立分支：条件都满足就回收（见 advanceChildTo，会上报「已完成」），
 * 只差「请父对话收尾」却没请的提醒它一次；其余照常上报现在的状态
 */
export async function settleChildWorktree(ctx: ChildrenCtx, childId: string, turn?: TurnInfo) {
  const { sc } = ctx
  const tk = await readTask(sc, childId)
  if (!tk?.parentTaskId) return
  // 被叫停的（父对话停下、用户暂停……）只上报现在的状态（已中断），不在这时收口成完成、删独立分支：
  // 没开工的子对话按完成条件什么都不缺，会被误判成交付完了（摸底报告第 3 条）。继续时由它接着做
  const live = sc.live.get(childId)
  const halted = haltedTurn(live?.stop ? live.stopReason : tk.status === 'stopped' ? tk.stopReason : undefined)
  if (isolated(tk) && !halted) {
    const { holds } = await advanceChildTo(ctx, childId)
    if (!holds.length) return
    if (await nudgeMerge(sc, tk)) return
  }
  if (await ctx.drive.nudgePlan(tk, turn)) return
  await reportChild(ctx, childId)
}

/**
 * 子对话这一轮做完了，除了合回之外都做完了，却没请父对话收尾：推一条面板消息提醒它跑通验证后调用 submit_merge。
 * 只提醒一次，再结束还没请就照常上报父对话（未完成），由父对话决定。提醒发出去了返回 true
 */
async function nudgeMerge(sc: TasksScope, child: Task): Promise<boolean> {
  if (!child.parentTaskId || sc.mergeNudged.has(child.id) || child.wrapRequest) return false
  // 这一轮说完了就提醒（见 turnSettled）：保活的 CLI 一轮结束后 status 还是 running，只认 done 永远提醒不到
  if (!turnSettled(child)) return false
  // 进程还挂着时派出的子任务、工作流可能还没跑完（done 时不会有）：那是在等结果，不是停在合回前
  if (helpersWorking(child) || runRunning(child)) return false
  // 用户停下、父对话收尾、归档删除这类被叫停的：不能再推它开新一轮，停止键按下去对话又自己跑起来（e2e 保活子对话那段撞到过）。
  // 页面切走、闲置回收只是收掉等下一句的进程，这一轮是正常做完的，照常提醒
  const live = sc.live.get(child.id)
  const why = live?.stop ? live.stopReason : child.stopReason
  if (why && why !== 'presence' && why !== 'idle') return false
  if (userWaiting(child) || openWork(child).length) return false
  if (sc.background.list(child.id).some((j) => j.state === 'queued' || j.state === 'running')) return false
  if (!isolated(child)) return nudgeShared(sc, child)
  const project = await sc.deps.projects.get(child.projectId)
  const st = project ? await worktreeStatus(project.path, child.worktree!).catch(() => null) : null
  if (!st) return false
  // 分支已经在原分支里了（子对话或它派的子任务自己 git merge 过去），计划却还停在「合回」这一步：
  // 不提醒的话没人会去调用 submit_merge，计划一直卡在收尾、子对话也一直不算完成
  const wrapOpen = !!activePlan(child)?.steps.some((s) => panelWrap(s.wrapUp) && s.status !== 'done')
  if (st.merged && !wrapOpen) return false
  sc.mergeNudged.add(child.id)
  const what = [st.ahead ? `${st.ahead} 个提交` : '', st.dirty ? `${st.dirty} 个未提交的文件` : ''].filter(Boolean)
  const r = await sc.sendToChild(
    child.parentTaskId,
    child.id,
    st.merged
      ? '【面板】你的分支已经在父对话的分支里了，但还没请父对话收尾，计划停在「合回父对话所在的分支」。直接调用 submit_merge（tests 写上跑过的验证），父对话确认后面板标完成并删除分支。以后收尾都用 submit_merge，不要自己或派子任务去 git merge。'
      : `【面板】你的独立分支里还有没合回父对话分支的改动（${what.join('、')}），也还没请父对话收尾。按「验证」在你的分支里跑通编译和测试后调用 submit_merge（tests 写上跑了什么、结果如何），父对话会合并、标完成并删除分支；没合回去之前不算做完。验证没过就修好再交，确实不该合并就说明原因。`,
    'build',
  )
  return r.ok
}

/**
 * 共用目录的子对话（P4、没有版本管理、项目设成共用目录）这一轮做完了，改过文件却没请父对话验收：
 * 推一条面板消息提醒它评审、验证后调用 submit_merge。条件和独立分支一样只提醒一次（调用方已查过计划、提问和后台命令）。
 * 计划里还挂着收尾（P4 分 changelist、请验收），或者没列计划但改了文件，都算没交付完
 */
async function nudgeShared(sc: TasksScope, child: Task): Promise<boolean> {
  const plan = activePlan(child)
  const wrapOpen = !!plan?.steps.some((s) => panelWrap(s.wrapUp) && s.status !== 'done')
  // 列了计划的看收尾那一步还挂着没有（只读排查也要 submit_merge 交结果，评审只在改过文件时要求）；没列计划的看改没改文件
  if (plan ? !wrapOpen : !child.changes.length) return false
  sc.mergeNudged.add(child.id)
  const r = await sc.sendToChild(
    child.parentTaskId!,
    child.id,
    `【面板】${child.changes.length ? `你改了 ${child.changes.length} 个文件，` : '计划只剩收尾，'}还没请父对话验收。你和父对话共用目录（P4、没有版本管理或项目设成共用目录），没有分支要合，但收尾的必备步骤一样要做：改了代码先按「收尾前评审」派评审、逐条处置${plan?.steps.some((s) => s.wrapUp === 'p4' && s.status !== 'done') ? '，P4 按文件类型分好 changelist' : ''}，按「验证」跑通编译和测试，再调用 submit_merge（tests 写上跑了什么、结果如何，handoff 写交接要点）。没请父对话验收之前不算做完；确实不该交付就说明原因。`,
    'build',
  )
  return r.ok
}

/** 子对话整次执行结束（成功、失败、被停）：和一轮结束走同一个收口（重复的上报会被去掉） */
export async function reportToParent(ctx: ChildrenCtx, task: Task) {
  if (!task.parentTaskId) return
  settleChildTurn(ctx, task)
}
