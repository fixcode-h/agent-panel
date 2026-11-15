import { setChild } from '../../../shared/children/task-child.ts'
import {
  advanceChild,
  childFlowOf,
  childHolds,
  childHoldText,
  runRunning,
  type ChildFlowStop,
  type ChildHold,
} from '../../../shared/task.ts'
import type { Task } from '../../../shared/schema.ts'
import { releaseWorktree, worktreeStatus } from '../../exec/worktree.ts'
import { integrateBranch, type IntegrateResult } from '../../exec/worktree-integrate.ts'
import { log } from '../../log.ts'
import { t } from '../../../shared/i18n.ts'
import { settlePlan } from '../../../shared/plan/index.ts'
import { killTree } from '../../exec/process.ts'
import { killTaskClis } from '../../exec/orphans.ts'
import { isolated } from '../helpers.ts'
import type { TasksScope } from '../scope.ts'
import type { ChildrenCtx } from './context.ts'
import { reportChild, reportKey } from './report.ts'
import { stopChildHelpers } from './stop.ts'

/**
 * 子对话的彻底完成（ADR 0003）：完成流转的唯一入口 advanceChildTo、第 4 步置完成（completeChild）、
 * 用户点「解决」时的收口（settleChildForUser），以及合回分支的 git 部分（integrate）
 */

/**
 * 正在做的「彻底完成」只做一次：并发的两次收尾共用同一次，不重复删（见 ChildrenCtx.completing）
 */
function completeChildOnce(ctx: ChildrenCtx, childId: string, tk: Task): Promise<void | ChildFlowStop> {
  const { completing } = ctx
  const running = completing.get(childId)
  if (running) return running
  const p = completeChild(ctx.sc, childId, tk).finally(() => {
    if (completing.get(childId) === p) completing.delete(childId)
  })
  completing.set(childId, p)
  return p
}

/**
 * 第 4 步：子对话这一侧把自己置为完成。
 * 独立分支的目录和分支只在这一步回收（合并成功不等于做完了，别在别处删目录：
 * 还在跑、计划没做完、后台命令还在写目录时删了就把改动一起丢了），
 * 交回原因就停在原地，父对话那边也看不到「已完成」。
 */
async function completeChild(sc: TasksScope, childId: string, tk: Task): Promise<void | ChildFlowStop> {
  const entry = sc.live.get(childId)
  // 这次收尾推进到一半时用户又发消息继续了：live 里已经换成新的一轮（resume 会重新 reserve、克隆新任务），
  // 这次完成作废。否则收尾结束时会把旧快照写回去，刚重建的分支又被标成「已合并」
  if (entry && entry.task !== tk) return { holds: ['working'], info: t('子对话又开始执行了，等这一轮结束再收尾') }
  // 彻底完成就不再留着会话进程：共用父目录的子对话也一样。
  // 以前这一步只在独立分支里做，共用目录的子对话 resolved 之后 CLI 还在等下一句，
  // 只能等 presence 宽限期（未读的连计时都不排）兜底，实测会留下十几个没人用的进程。
  // 原因写 finish：界面和引擎都按「做完后收尾」处理，不显示成「这一轮被中断」
  // 限时：CLI 取消等待后不退出时强制停掉，收尾不能一直卡着（父对话再交代任务会跟着卡住）
  // 共用目录的子对话按设置「子对话完成后保留」再留几分钟：这段时间里父对话接着交代，直接交给同一个进程。
  // 独立分支的不留：下面马上要删它的目录，CLI 的工作目录没了，再交给它也跑不了
  const kept = entry && !isolated(tk) ? await sc.keepDoneChild(childId, entry) : false
  if (entry && !kept) await sc.endLive(childId, entry, 'finish')
  // 后台命令结果推回来还要开新一轮，彻底完成时一起停掉
  await sc.background.stop(childId)
  if (isolated(tk)) {
    const project = await sc.deps.projects.get(tk.projectId)
    const info = project
      ? await releaseWorktree(project.path, tk.worktree!, []).catch((err) => {
          log.warn('task', '彻底完成后删除独立分支失败', { task: childId, error: (err as Error).message })
          sc.alertOn(childId, 'worktree', t('对话完成了，但删除独立分支失败，分支和目录还留着'))(err)
          return ''
        })
      : ''
    // 目录或分支删不掉：仍算没合回去，下次再收一次
    if (info) return { holds: ['unmerged'], info }
    tk.worktree = { ...tk.worktree!, state: 'merged', note: tk.worktree!.baseBranch }
  }
  tk.resolved = true
  setChild(tk, { wrapRequest: undefined })
  tk.updatedAt = new Date().toISOString()
  if (entry) entry.rev++
  await sc.store.update(tk.id, tk)
  // 改动交出去了：共用目录里它名下的认领到这里才放（finish_child、用户点解决、一轮结束收口都经这一步）
  sc.claims.release(tk.parentTaskId!, childId)
  // 落到 resolved 之后再核对一次：上面只停得到本进程 live 里的那一轮，
  // 重启前留下的、或某条路径漏停的 CLI 还挂在登记里（任务已经完成了，进程留着没人要）。
  // 日志由 killTaskClis 写，里面带任务和 pid。保留期里的那个是特意留着的，到点由保留期结束
  if (!kept)
    await killTaskClis(childId, killTree).catch((err) =>
      log.warn('task', '收尾后回收子对话的 CLI 进程失败', { task: childId, error: (err as Error).message }),
    )
}

/**
 * 用户手动点「解决」（PATCH resolved: true）时先把这一侧能停的停掉、把计划收口（见 plan.ts 的 settlePlan）：
 * 用户的预期是「我点解决了，剩下的步骤就算做完」，不该被「计划没做完」挡住。
 * 父对话收尾（finish_child）、一轮结束收口、后台命令结束都不走这里，仍要求计划真做完。
 * 停不掉或不该跟着收口的（这一轮还在跑、工作流运行、待回答的提问与请求）原样交回，不硬标完成。
 */
async function settleChildForUser(
  sc: TasksScope,
  childId: string,
  tk: Task,
): Promise<{ holds: ChildHold[]; info: string } | undefined> {
  // 这一轮还在执行：先按原样拒，写进去就成了「已解决但还在跑」
  if (tk.working) return { holds: ['working'], info: childHoldText(['working']) }
  // 停不掉的（工作流运行、待回答的提问 / 请求）先判：不能先把在跑的子任务杀了再告诉他解决不了
  const left = childHolds({
    workflow: runRunning(tk),
    asking: tk.child?.parentAsks?.length ?? 0,
    requests: tk.requests.length,
  })
  if (left.length) return { holds: left, info: childHoldText(left) }
  // 派出去的子任务还在跑：用现有的 stopHelper 停掉，等它真的停下后再收口
  const stopped = await stopChildHelpers(sc, childId, tk)
  if (!stopped.ok) return { holds: ['helpers'], info: stopped.info }
  // 后台命令同理：还在跑就没法收口，也不该留个孤儿进程
  await sc.background.stop(childId)
  // 停子任务 / 停后台命令都要等一会儿，期间用户可能又发消息继续（resume 会换掉 live 里那一轮的任务对象）：
  // 拿旧快照写回去会把新一轮的消息和状态盖掉（completeChild 有同样的检查）
  const cur = sc.live.get(childId)
  if (cur && cur.task !== tk) return { holds: ['working'], info: t('子对话又开始执行了，等这一轮结束再收尾') }
  const settled = settlePlan(tk)
  if (settled) {
    log.info('task', '用户点「解决」：计划收口成全部完成', { task: childId, settled })
    tk.updatedAt = new Date().toISOString()
    if (cur) cur.rev++
    await sc.store.update(tk.id, tk)
  }
  return undefined
}

/**
 * 子对话完成状态的唯一入口：按 wrapup → plan → pending → complete → report → list 走一遍（见 advanceChild）。
 * 用户点「解决」、父对话收尾、一轮结束收口、后台命令结束都走这里：父对话侧的动作只是发起这一趟流转，
 * 判定和置完成仍然在子对话这一侧，父对话不直接改子对话的最终状态。
 * 还差什么就原样交回去（原因给用户看），不跳步、不重复置完成、不重复上报。
 * quiet：父对话自己发起的收尾（finish_child），结果已经在工具结果里，不再往父对话里推一条「已完成」
 * fromUser：用户手动点「解决」发起的，先把计划收口（见 settleChildForUser）；别的入口都不传
 */
export async function advanceChildTo(
  ctx: ChildrenCtx,
  childId: string,
  opts: { quiet?: boolean; fromUser?: boolean } = {},
): Promise<{ holds: ChildHold[]; info: string }> {
  const { sc, reportedDone, reportedState } = ctx
  const entry = sc.live.get(childId)
  const tk = entry?.task ?? (await sc.store.get(childId))
  if (!tk?.parentTaskId) return { holds: [], info: '' }
  if (isolated(tk)) {
    const project = await sc.deps.projects.get(tk.projectId)
    // 合没合回去要问 git：分支被删、目录被手动清理过时任务上记的 state 不可信
    const st = project ? await worktreeStatus(project.path, tk.worktree!).catch(() => null) : null
    if (!st?.merged) {
      // 分支上还有没合回原分支的改动：不能标完成，也不能删（删了改动就没了）
      if (tk.resolved) {
        tk.resolved = false
        reportedDone.delete(childId)
        tk.updatedAt = new Date().toISOString()
        if (entry) entry.rev++
        await sc.store.update(tk.id, tk)
      }
      return {
        holds: ['unmerged'],
        info: st
          ? t(
              '这个子对话的独立分支还有没合回原分支的改动（{n} 个提交、{d} 个未提交的文件）：先合并或删除分支，再标记完成',
              {
                n: st.ahead,
                d: st.dirty,
              },
            )
          : t('查不到这个子对话独立分支的状态（git 没读出来）：先确认分支已经合并，再标记完成'),
      }
    }
  }
  // 用户手动点「解决」：先把能停的停掉、把计划收口（见 settleChildForUser），再走完成流转
  if (opts.fromUser) {
    const refused = await settleChildForUser(sc, childId, tk)
    if (refused) return refused
  }
  // 已经置过完成的当作已经上报过：重启后再走一趟时不重复往父对话里刷「已完成」
  const done = tk.resolved === true
  const run = await advanceChild(
    childFlowOf(tk, {
      background: sc.pendingJobs(childId),
      // 合回了、父对话的测试还没跑完或没通过（已退回修复）：都不能标完成、不能删分支（ADR 0018）。
      // 只在还有独立分支时算：分支被丢弃后没有「合回」这回事了，不能再拿它拦完成（评审 R4）
      parentTest: isolated(tk) && (sc.parentTesting(childId, tk) || tk.child?.wrapRequest?.state === 'test-failed'),
      reported: done || reportedDone.has(childId),
    }),
    {
      complete: () => completeChildOnce(ctx, childId, tk),
      // 第 5 步：上报父对话，走统一的状态上报（见 reportChild）：说法、计划收口和别的状态变化是同一套
      report: async () => {
        reportedDone.add(childId)
        if (opts.quiet) reportedState.set(childId, reportKey(tk, 'done'))
        else await reportChild(ctx, childId)
      },
    },
  )
  // 第 6 步（列表）：父对话列表是从子对话状态派生的，第 5 步已经把父对话推了一版（见 noteParent），
  // 页面收到就重取，不在这里另存一份状态
  return { holds: run.holds, info: run.info }
}

/** 一次合并（git 部分在 worktree-integrate.ts）：失败按谁能修分类，冲突写给子对话，挡路写给父对话 */
export async function integrate(sc: TasksScope, tk: Task, parent: Task): Promise<IntegrateResult> {
  return integrateBranch(await sc.taskDir(parent), tk.worktree!, tk.title)
}
