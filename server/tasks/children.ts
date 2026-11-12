import { randomUUID } from 'node:crypto'
import {
  childSelfDrives,
  userWaiting,
  advanceChild,
  childFlowOf,
  childHolds,
  childHoldText,
  childReport,
  type ConvState,
  runRunning,
  withAttachments,
  type ChildFlowStop,
  type ChildHold,
} from '../../shared/task.ts'
import { Task, type Agent, type TaskMessage } from '../../shared/schema.ts'
import { helperRunning, helpersWorking } from '../../shared/tasks/helpers.ts'
import { saveToHandoff } from './inbox-file.ts'
import { createDrive } from './drive.ts'
import { planProgressKey } from '../../shared/drive.ts'
import type { TurnInfo } from '../exec/turn-info.ts'
import { MERGE_STALL_REPORTS, nextMergeStall, turnSettled, type MergeStall } from '../../shared/merge-stall.ts'
import { cancelWait, steerTask } from '../exec/steering.ts'
import { stopHelper } from '../../shared/run-stops.ts'
import { hasHeld } from '../exec/delivery.ts'
import { releaseWorktree, worktreeStatus } from '../exec/worktree.ts'
import { integrateBranch, type IntegrateResult } from '../exec/worktree-integrate.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { childCountsScan, childRecordActive, type ChildCounts } from '../../shared/children/row.ts'
import { activePlan, holdWait, planProgress, openWork, settlePlan } from '../../shared/plan.ts'
import { panelWrap } from '../../shared/wrap-up.ts'
import { killTree, taskCliAlive } from '../exec/process.ts'
import { killTaskClis } from '../exec/orphans.ts'
import { RULE_CMD, isolated, HELPER_STOP_TIMEOUT_MS, HELPER_STOP_POLL_MS } from './helpers.ts'
import type { TasksScope } from './scope.ts'
import { letterResult } from '../../shared/children/letter.ts'
import { childSummaryCards } from '../../shared/summary-card.ts'

/**
 * 子对话的生命周期：在跑的计数、彻底完成的判定和推进（advanceChildTo，ADR 0003）、合回、上报父对话、规则命令、启动子对话。
 * 一轮结束时推进计划（nudgePlan，ADR 0032 / 0041）在 drive.ts。
 */
export function createChildren(sc: TasksScope) {
  // 一轮结束时的推进（自驱，ADR 0041）放在 drive.ts；它要上报子对话、看名下子对话在不在跑，用下面定义的两个函数
  const { nudgePlan, nudgeWrapUp, beforeEnd, nudgeState, resetNudge, noteStop, clearStop } = createDrive(sc, {
    reportChild: (id) => reportChild(id),
    activeChildren: (id) => activeChildren(id),
  })
  /**
   * 子对话还在运行（见 convActive）：在跑、等结果、等回答、正在启动，或者还有交过来的消息要接着处理。
   * 父对话的「子对话在跑」计数、标题和侧栏的转圈、能不能回收都读它
   */
  const childActive = (tk: Task) =>
    sc.startQueue.has(tk.id) || hasHeld(tk.id) || childRecordActive(tk, sc.pendingJobs(tk.id))

  /**
   * 名下有还在运行的子对话（见 childActive）几个：父对话的计数、保活回收都读它，不在各处再拼一遍。
   * 只数执行位里的：闲着的子对话不用护着父对话（回收父对话不会连带停下它，结果也会走 wakeConv 交回）。
   * startQueue 里的子对话不用单独数：startChild 的 add 到 reserve 之间没有 await，外部观察不到那一段
   */
  function childrenRunning(parentId: string): number {
    return [...sc.live.values()].filter((e) => e.task.parentTaskId === parentId && childActive(e.task)).length
  }

  /**
   * 名下子对话的计数（还在跑的、CLI 还活着的）：一次 store.list() 把所有父对话的都算出来，
   * 结果留 1 秒。SSE 对每个打开的对话每秒问一次、执行中的对话每 200ms 就先算一次，
   * 不缓存的话父对话开得越多，每秒扫整份任务列表的次数越多（每个父对话 2 次）
   */
  const CHILD_COUNT_TTL = 1000
  let childScan: { at: number; counts: (parentId: string) => ChildCounts } | null = null
  async function childCountsOf(parentId: string) {
    const now = Date.now()
    if (!childScan || now - childScan.at >= CHILD_COUNT_TTL) {
      // 执行中的对话以内存里那份为准：请求刚弹出来还没落盘时，父对话也要马上变成「等你处理」
      const all = (await sc.store.list()).map((k) => sc.live.get(k.id)?.task ?? k)
      // 和任务列表、演示后端同一份扫法（shared/children/row.ts）
      childScan = {
        at: now,
        counts: childCountsScan(all, { active: childActive, cliAlive: (k) => taskCliAlive(k.id) }),
      }
    }
    const c = childScan.counts(parentId)
    return { working: c.childrenWorking, cli: c.childrenCli, needs: c.childrenNeeds }
  }

  /** 名下还在运行的子对话数（见 childActive） */
  async function activeChildren(parentId: string) {
    return (await childCountsOf(parentId)).working
  }

  /** 名下 CLI 进程还活着的子对话数：标题流光、侧栏提示用（见 taskCliAlive） */
  async function cliChildren(parentId: string) {
    return (await childCountsOf(parentId)).cli
  }

  /**
   * 父对话已经收到「子对话已完成」上报的子对话。只在进程里记：重启后把已经置完成（resolved）的当作上报过了，
   * 不重复往父对话里刷同一条「已完成」
   */
  const reportedDone = new Set<string>()

  /** 上次交给父对话的状态（见 reportChild）：同一个状态不重复报 */
  const reportedState = new Map<string, string>()
  /** 子对话停在「只剩合回、没请收尾」的次数（见 nextMergeStall）：离开这个状态就清掉 */
  const mergeStalls = new Map<string, MergeStall>()
  /** 上报去重的键：收尾请求按请求的时间，别的状态按这一轮结束的时间（每轮结束各报一次） */
  // 不带 status：CLI 报完这一轮（result）时 status 还是 running，进程退出、整次执行收尾时变成 done，
  // 同一轮、同一状态会因为这一个字段不同被当成两次上报，父对话里出现两条一样的「子对话状态」
  /**
   * 上报去重的键：同一个结论只报一次。「未完成」按计划进度算（每轮结束都报的话，一个子对话来回跑几轮
   * 父对话就收到一串「未完成」，用户报过 20 分钟 13 条）；其余按这一轮算（每次失败、中断都要知道）
   */
  const reportKey = (tk: Task, state: ConvState) => {
    if (state === 'wrapup') return `wrapup|${tk.wrapRequest?.at ?? ''}`
    if (state === 'unfinished') {
      const plan = activePlan(tk)
      return `unfinished|${plan ? planProgressKey(plan) : ''}|${openWork(tk).length}`
    }
    return `${state}|${tk.turnDoneAt}`
  }

  /**
   * 正在做的「彻底完成」：删独立分支的目录和分支、清后台命令。
   * 继续执行（追加要求）要等它结束再重建目录：收尾和重建撞在一起时，刚重建起来的分支可能又被这次收尾删掉
   * （测试里表现为刚重建的分支状态又变回「已合并」）。并发的两次收尾共用同一次，不重复删。
   */
  const completing = new Map<string, Promise<void | ChildFlowStop>>()
  function completeChildOnce(childId: string, tk: Task): Promise<void | ChildFlowStop> {
    const running = completing.get(childId)
    if (running) return running
    const p = completeChild(childId, tk).finally(() => {
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
  async function completeChild(childId: string, tk: Task): Promise<void | ChildFlowStop> {
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
    tk.wrapRequest = undefined
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
    childId: string,
    tk: Task,
  ): Promise<{ holds: ChildHold[]; info: string } | undefined> {
    // 这一轮还在执行：先按原样拒，写进去就成了「已解决但还在跑」
    if (tk.working) return { holds: ['working'], info: childHoldText(['working']) }
    // 停不掉的（工作流运行、待回答的提问 / 请求）先判：不能先把在跑的子任务杀了再告诉他解决不了
    const left = childHolds({
      workflow: runRunning(tk),
      asking: tk.parentAsks?.length ?? 0,
      requests: tk.requests.length,
    })
    if (left.length) return { holds: left, info: childHoldText(left) }
    // 派出去的子任务还在跑：用现有的 stopHelper 停掉，等它真的停下后再收口
    const stopped = await stopChildHelpers(childId, tk)
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
   * 停掉这个对话派出去、还在跑的子任务，等它们真的结束（有上限）。
   * 和界面的「终止子任务」走同一条路（stopHelper），不碰对话本身和别的子任务。
   */
  async function stopChildHelpers(childId: string, tk: Task): Promise<{ ok: boolean; info: string }> {
    // 子任务结束时引擎改的是 live 里那份任务：轮询按它判断，不要拿开头的快照一直看到 running
    const running = () => (sc.live.get(childId)?.task ?? tk).steps.filter(helperRunning)
    if (!running().length) return { ok: true, info: '' }
    for (const s of running()) stopHelper(childId, s.id, t('用户点了「解决」：先停掉还在跑的子任务再收口'))
    const until = Date.now() + HELPER_STOP_TIMEOUT_MS
    while (running().length) {
      if (Date.now() >= until)
        return {
          ok: false,
          info: t('这些子任务还没停下来：{list}。等它们结束再点「解决」', {
            list: running()
              .map((s) => `「${s.title}」`)
              .join('、'),
          }),
        }
      await new Promise((r) => setTimeout(r, HELPER_STOP_POLL_MS))
    }
    return { ok: true, info: '' }
  }

  /**
   * 子对话完成状态的唯一入口：按 wrapup → plan → pending → complete → report → list 走一遍（见 advanceChild）。
   * 用户点「解决」、父对话收尾、一轮结束收口、后台命令结束都走这里：父对话侧的动作只是发起这一趟流转，
   * 判定和置完成仍然在子对话这一侧，父对话不直接改子对话的最终状态。
   * 还差什么就原样交回去（原因给用户看），不跳步、不重复置完成、不重复上报。
   * quiet：父对话自己发起的收尾（finish_child），结果已经在工具结果里，不再往父对话里推一条「已完成」
   * fromUser：用户手动点「解决」发起的，先把计划收口（见 settleChildForUser）；别的入口都不传
   */
  async function advanceChildTo(
    childId: string,
    opts: { quiet?: boolean; fromUser?: boolean } = {},
  ): Promise<{ holds: ChildHold[]; info: string }> {
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
      const refused = await settleChildForUser(childId, tk)
      if (refused) return refused
    }
    // 已经置过完成的当作已经上报过：重启后再走一趟时不重复往父对话里刷「已完成」
    const done = tk.resolved === true
    const run = await advanceChild(
      childFlowOf(tk, {
        background: sc.pendingJobs(childId),
        // 合回了、父对话的测试还没跑完或没通过（已退回修复）：都不能标完成、不能删分支（ADR 0018）。
        // 只在还有独立分支时算：分支被丢弃后没有「合回」这回事了，不能再拿它拦完成（评审 R4）
        parentTest: isolated(tk) && (sc.parentTesting(childId, tk) || tk.wrapRequest?.state === 'test-failed'),
        reported: done || reportedDone.has(childId),
      }),
      {
        complete: () => completeChildOnce(childId, tk),
        // 第 5 步：上报父对话，走统一的状态上报（见 reportChild）：说法、计划收口和别的状态变化是同一套
        report: async () => {
          reportedDone.add(childId)
          if (opts.quiet) reportedState.set(childId, reportKey(tk, 'done'))
          else await reportChild(childId)
        },
      },
    )
    // 第 6 步（列表）：父对话列表是从子对话状态派生的，第 5 步已经把父对话推了一版（见 noteParent），
    // 页面收到就重取，不在这里另存一份状态
    return { holds: run.holds, info: run.info }
  }

  /** 一次合并（git 部分在 worktree-integrate.ts）：失败按谁能修分类，冲突写给子对话，挡路写给父对话 */
  async function integrate(tk: Task, parent: Task): Promise<IntegrateResult> {
    return integrateBranch(await sc.taskDir(parent), tk.worktree!, tk.title)
  }

  async function closeChildren(parentId: string) {
    const kids = (await sc.store.list()).filter((x) => x.parentTaskId === parentId && sc.live.has(x.id))
    // 先一起发停止、再一起等：一个一个等的话每个子对话收尾最多要几秒（杀进程树、写盘），
    // 父对话名下十几个子对话时停一次父对话就要卡上一两分钟，期间新的请求也排在后面
    await Promise.all(
      kids.map(async (k) => {
        const entry = sc.live.get(k.id)
        if (!entry) return
        // 正在等下一句的直接结束这一轮；正在执行的按停止处理（输出和状态都保留）。
        // 原因是 parent：父对话收尾停的子对话不能显示成「用户按了暂停」
        if (!cancelWait(k.id)) sc.stopTask(k.id, 'parent')
        if (entry.done) await entry.done.catch(() => {})
        if (sc.live.has(k.id)) sc.stopTask(k.id, 'parent')
      }),
    )
  }

  /**
   * 子对话的状态交给父对话：每轮结束、请求收尾、合并、置完成都走这一个出口（ADR 0005）。
   * 状态只从 childReport（convState）来：父对话收到的说法、父计划里等它那一步的收口、子对话栏是同一个结论。
   * - 还在动（执行中、等结果、等用户回答）：只把父计划那一步的说明改成现在的状态，不刷消息
   * - 未完成、待收尾：那一步继续等，发一条状态（同一状态同一轮只发一次）
   * - 已完成：那一步标完成；失败、中断：那一步退回进行中，都发一条状态
   */
  async function reportChild(childId: string) {
    // 面板正在退出：每个对话都在被停下，这时报「已中断」会在父对话里刷一串、还可能把父对话叫起来；
    // 重启后由恢复流程统一接着做（见 restartUnfinished / 父对话继续时连带恢复子对话）
    if (sc.shuttingDown) return
    // 卡住了、面板正在重启它或找人接手：结论出来前不报中断 / 失败（恢复了照常报，换人接手由那边写信）
    if (sc.childRecovering(childId)) return
    const tk = sc.live.get(childId)?.task ?? (await sc.store.get(childId))
    if (!tk?.parentTaskId) return
    // 它完成、失败、没了都可能影响排在它后面的子对话（shared/children/after.ts）：顺带扫一遍
    void sc
      .releaseAfter(tk.parentTaskId)
      .catch((e) => log.warn('task', '检查排在后面的子对话失败', { task: tk.id, error: (e as Error).message }))
    // 父对话正在合并：合并结果出来时再报，这时报「待收尾」「未完成」会让父对话误判
    if (sc.merging.has(childId)) return
    const jobs = sc.background
      .list(childId)
      .filter((j) => j.state === 'queued' || j.state === 'running')
      .map((j) => j.name)
    // 这一轮结束后还要接着做：排队的要求、面板交过来的消息、刚开好独立分支马上在分支目录里接着做的
    const more = sc.startQueue.has(childId) || hasHeld(childId)
    const project = isolated(tk) ? await sc.deps.projects.get(tk.projectId) : null
    const r = childReport(tk, {
      background: jobs,
      more,
      unmerged: await sc.childUnmerged(tk, project ?? null),
      // 它下面的孙对话在等用户：报「等你处理」并说清是它的子对话，父对话不会当成它卡住了去催
      childNeeds: (await childCountsOf(tk.id)).needs,
    })
    if (r.settle === 'hold') {
      await holdChildWait(tk, r.why).catch((e) =>
        log.warn('task', '更新父对话计划的等待说明失败', { task: tk.id, error: (e as Error).message }),
      )
      if (!r.notify) return
      // 计划没做完就收尾：子对话自己按计划接着做（自驱，nudgePlan），不发消息打扰父对话——父对话收到也只能再催一遍。
      // 同一进度推满了还停在原地，才告诉父对话一次（ADR 0041）
      // 面板会推它的才不报（childSelfDrives）：挂着等待却没东西在跑时不报，它写给父对话的汇报就交不出去
      if (r.state === 'unfinished' && openWork(tk).length && !sc.stuckAfterNudge(tk) && childSelfDrives(tk)) return
    }
    // 面板重启时被停下的：不是出错，重启后由恢复流程接着做，不往父对话里报「已中断」
    if (r.state === 'stopped' && tk.stopReason === 'restart') return
    // 已经换新的子对话接手：换人那封信说过了，不再报「已中断」
    if (r.state === 'stopped' && tk.stopReason === 'replaced') return
    // 还没开始、在等前置子对话合回：父对话派它时就知道，不报「已中断」
    if (r.state === 'stopped' && tk.stopReason === 'after') return
    // 只剩合回却没请收尾：每停一次都要让父对话知道（带第几次），不能按「状态没变」吞掉，见 nextMergeStall
    const mergeOnly = r.state === 'unfinished' && !openWork(tk).length
    let stall: MergeStall | undefined
    if (mergeOnly) {
      const plan = activePlan(tk)
      stall = nextMergeStall(
        mergeStalls.get(childId),
        plan ? `${plan.id}:${planProgress(tk, plan).done}` : '',
        tk.turnDoneAt ?? '',
      )
      mergeStalls.set(childId, stall)
      // 报满了：父对话已经被告知最后一次、按那封信去问用户了，不再叫起它来回催
      if (stall.n > MERGE_STALL_REPORTS) return
    } else mergeStalls.delete(childId)
    const key = reportKey(tk, r.state) + (stall ? `|${stall.n}` : '')
    if (reportedState.get(childId) === key) return
    reportedState.set(childId, key)
    // 先取最新的回复：task.summary 要等整次执行收尾才更新，这一轮刚报完成（进程还在、或保活等下一句）时
    // 它还是上一轮的，上报会带着上一轮的结果
    // 这一轮 AI 自己用 message_parent 写的汇报并进这一封当「结果」（ADR 0034：一轮只交一封），没写才取最后一条回复
    // 只带要点（shared/children/letter.ts）：最后一条回复取全文从里面认总结，lastReply 只有开头 300 字、认不出末尾的总结
    const last = [...tk.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())?.text
    const reply = tk.pendingReport?.trim() || last || tk.summary || ''
    // 结果优先用子对话写进它自己计划的总结（ADR 0041：总结写在各自的计划里，是它明确交的，不靠从回复里认）；
    // 计划还没收尾、没写总结时才退回最后的回复
    const plan = tk.plans?.at(-1)
    const src = (plan?.doneAt && plan.summary.trim()) || reply
    const brief = letterResult(src)
    const summary = brief.text
    // 父对话里由面板自动显示的卡片（父对话不再自己写）：标题取子对话这一轮总结的「类型｜结论」，
    // 点标题跳到子对话里的详细总结；没写总结时为空。卡片只做展示，从回复里画
    const cards = childSummaryCards(reply, tk.id)
    // 用户直接在子对话里交代过新要求：不再单独发消息，这封汇报里带上原话
    const direct = tk.userDirect ? `\n用户在这个子对话里直接交代过：${tk.userDirect}` : ''
    // 只剩合回却没请收尾：父对话不能直接 finish_child（要等它请求），点明下一步，免得父对话收到了也不知道该做什么
    // 停了几次：面板自己提醒过一次 submit_merge 的也算上，父对话据此判断要不要换个说法或去问用户
    const stops = stall ? stall.n + (sc.mergeNudged.has(tk.id) ? 1 : 0) : 0
    // 面板提醒不限次数（2026-11-05）：停在这里是它说了卡住、或者连着几次提醒都没动手（空转保护）
    const nudgeText = sc.stuckAfterNudge(tk)
      ? '面板按它自己的计划提醒过它，它说了卡住或者连着几次都没动手，仍停在这里'
      : '它这一轮结束了，计划里有步骤还挂着等待，但它没有在跑的子任务、子对话或后台命令，面板不会再推它'
    const next = mergeOnly
      ? `\n这是它第 ${stops} 次停在这里没请收尾${sc.mergeNudged.has(tk.id) ? '（面板已经提醒过它一次）' : ''}。` +
        `下一步：用 send_to_conversation 让它${isolated(tk) ? '在自己的分支里' : ''}评审处置完、跑通验证后调用 submit_merge；它请求收尾后你再 finish_child。` +
        (stall!.n >= MERGE_STALL_REPORTS
          ? '这是面板最后一次转告：交回后它仍不调用 submit_merge，就停下来告诉用户它卡在合回前、卡在哪，由用户决定，不要再来回催。'
          : '')
      : r.state === 'unfinished'
        ? `\n下一步：${nudgeText}，看上面的结果判断卡在哪：缺信息就回答它，方向不对就改要求，都用 send_to_conversation 交回这个子对话（id ${tk.id}），写清新的要求或答案；不要只发「继续」（它会自己接着做，催也没用），也不要另建一个子对话重做。确实做不下去就告诉用户。`
        : r.state === 'stopped' && tk.stopReason === 'user'
          ? // 用户亲手停的是「先别动」，不是失败：实测里父对话把它当成中断去交回重试，用户停它的意思就没了
            '\n下一步：这是用户自己停掉的，不是失败。不要自动交回、重派或另建子对话重做；计划里等它的那一步继续等，用户要它接着做时会自己继续，或者交代你再交给它。'
          : r.state === 'failed' || r.state === 'stopped'
            ? `\n下一步：要重试就用 send_to_conversation 交回这个子对话（id ${tk.id}），它在原来的会话里接着做；不要另建一个子对话重做。它确实起不来（交回时报错）再另建子对话接着做，并在派单里写明接手的是哪个子对话的活。`
            : ''
    const text = `【子对话状态】「${tk.title}」（id ${tk.id}）${r.why}${next}${direct}${summary ? `\n最近的结果：${summary}${brief.cut ? `\n（这是摘要。${fullAt(tk.parentTaskId, tk.title, src)}面板会自动给用户显示它的总结卡片，不用转述细节）` : ''}` : ''}`
    await sc.noteParent(
      tk.parentTaskId,
      tk,
      text,
      text,
      r.settle === 'hold' ? undefined : { kind: 'child', ref: tk.id, ok: r.settle === 'ok' },
      { id: tk.id, title: tk.title, state: r.state },
      await sc.peerOf(tk, 'child', 'report', r.why, r.state === 'failed'),
      undefined,
      // 只有「只剩合回却没请收尾」要叫起父对话；失败、中断的重试提示照旧放进收件箱
      !!next && r.state === 'unfinished',
      cards,
    )
    // 并进去的阶段汇报、用户的原话已经交出去了，下一封不再重复带。
    // 随父对话（或用量上限）停下的那次 noteParent 只改计划、不发（见 noteParent 的 cascaded），留到继续后的那一封
    const sent = !(r.state === 'stopped' && (tk.stopReason === 'parent' || tk.stopReason === 'budget'))
    if (sent && (tk.pendingReport || tk.userDirect)) {
      const ce = sc.live.get(tk.id)
      const cur = ce?.task ?? tk
      cur.pendingReport = undefined
      cur.userDirect = undefined
      if (ce) ce.rev++
      else
        await sc.store
          .update(tk.id, cur)
          .catch((e) =>
            log.error('task', '清掉已交出的阶段汇报时写盘失败', { task: tk.id, error: (e as Error).message }),
          )
    }
  }

  /**
   * 子对话这一轮结束了（CLI 报完成、停在等下一句，或者整次执行结束）：
   * 独立分支里的先试着收口（条件都满足就完成、回收；只差请求收尾时提醒它一次），再统一上报父对话。
   * 放到下一拍：别在 CLI 收尾的回调里结束它
   */
  function settleChildTurn(child: Task, turn?: TurnInfo) {
    if (!child.parentTaskId) return
    if (isolated(child) && !hasHeld(child.id) && !sc.merging.has(child.id) && !child.resolved) {
      setImmediate(
        () =>
          void settleChildWorktree(child.id, turn).catch((e) => {
            log.warn('task', '子对话一轮结束收口失败', { task: child.id, error: (e as Error).message })
            sc.alertOn(child.id, 'panel', t('这一轮结束后整理独立分支、上报父对话时出错'))(e)
          }),
      )
      return
    }
    void (async () => {
      // 共用目录的子对话（P4、没有版本管理）改完没请收尾：和独立分支一样提醒一次，评审、验收不因版本管理方式省掉
      if (!isolated(child) && !hasHeld(child.id) && !child.resolved && (await nudgeMerge(child))) return
      if (await nudgePlan(child, turn)) return
      await reportChild(child.id)
    })().catch((e) => {
      log.warn('task', '子对话状态上报失败', { task: child.id, error: (e as Error).message })
      sc.alertOn(child.id, 'delivery', t('这个对话的状态没能报给父对话'))(e)
    })
  }

  /**
   * 一轮结束后收口子对话的独立分支：条件都满足就回收（见 advanceChildTo，会上报「已完成」），
   * 只差「请父对话收尾」却没请的提醒它一次；其余照常上报现在的状态
   */
  async function settleChildWorktree(childId: string, turn?: TurnInfo) {
    const tk = sc.live.get(childId)?.task ?? (await sc.store.get(childId))
    if (!tk?.parentTaskId) return
    if (isolated(tk)) {
      const { holds } = await advanceChildTo(childId)
      if (!holds.length) return
      if (await nudgeMerge(tk)) return
    }
    if (await nudgePlan(tk, turn)) return
    await reportChild(childId)
  }

  /** 摘要截掉的全文存进父对话的交接目录，告诉它去哪读（ADR 0041 第 14 节）；存不了就说在子对话里 */
  const fullAt = (parentId: string, title: string, src: string) => {
    try {
      return `完整总结在文件 ${saveToHandoff(parentId, `子对话「${title}」的总结`, src)}，需要细节时读它；`
    } catch {
      return `完整总结在子对话「${title}」里；`
    }
  }

  /**
   * 子对话这一轮做完了，除了合回之外都做完了，却没请父对话收尾：推一条面板消息提醒它跑通验证后调用 submit_merge。
   * 只提醒一次，再结束还没请就照常上报父对话（未完成），由父对话决定。提醒发出去了返回 true
   */
  async function nudgeMerge(child: Task): Promise<boolean> {
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
    if (!isolated(child)) return nudgeShared(child)
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
  async function nudgeShared(child: Task): Promise<boolean> {
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

  /** 子对话还没交付完：父对话计划里等它的那一步继续等，note 写清它现在的状态 */
  async function holdChildWait(child: Task, why: string) {
    if (!child.parentTaskId) return
    const entry = sc.live.get(child.parentTaskId)
    const parent = entry?.task ?? (await sc.store.get(child.parentTaskId))
    if (!parent) return
    if (!holdWait(parent, 'child', child.id, why).length) return
    parent.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    await sc.store
      .update(parent.id, parent)
      .catch((e) => log.warn('task', '更新父对话计划的等待说明失败', { task: parent.id, error: (e as Error).message }))
  }

  /** 子对话整次执行结束（成功、失败、被停）：和一轮结束走同一个收口（重复的上报会被去掉） */
  async function reportToParent(task: Task) {
    if (!task.parentTaskId) return
    settleChildTurn(task)
  }

  /**
   * 「/rule 内容」发布一条全局规则；「/rule」不带内容列出现有规则；「/rule clear」清空，「/rule -2」删掉第 2 条。
   * 只有项目里的顶层对话能用：规则存在这个对话上，名下所有子对话（连同它们的工作流节点）每次调用都带上，
   * 正在执行的子对话马上收到。不写进项目的 AGENTS.md
   */
  async function ruleCommand(id: string, text: string): Promise<{ task: Task } | { error: string }> {
    const entry = sc.live.get(id)
    const tk = entry?.task ?? (await sc.store.get(id))
    if (!tk) return { error: t('任务不存在') }
    if (!tk.projectId || tk.parentTaskId)
      return { error: t('全局规则只能在项目对话里发布，子对话会自动遵守父对话的规则') }
    const arg = text.replace(RULE_CMD, '').trim()
    const at = new Date().toISOString()
    let note: string
    let fresh = ''
    if (!arg) {
      note = tk.rules.length
        ? t('这个对话的全局规则：\n{list}', { list: tk.rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n') })
        : t('这个对话还没有全局规则。输入「/rule 内容」发布一条，所有子对话都会遵守。')
    } else if (/^(clear|清空)$/i.test(arg)) {
      tk.rules = []
      note = t('已清空全局规则')
    } else if (/^-\d+$/.test(arg)) {
      const n = Number(arg.slice(1))
      const gone = tk.rules[n - 1]
      if (!gone) return { error: t('没有第 {n} 条规则', { n }) }
      tk.rules = tk.rules.filter((_, i) => i !== n - 1)
      note = t('已删除全局规则：{text}', { text: gone.text })
    } else {
      tk.rules = [...tk.rules, { id: randomUUID(), text: arg.slice(0, 2000), at }]
      fresh = arg
      note = t('已发布全局规则：{text}。这个对话下的所有子对话都会遵守，不写进项目的 AGENTS.md。', { text: arg })
    }
    tk.messages.push({ id: randomUUID(), role: 'system', agentId: '', step: '', text: note, tools: [], at })
    tk.updatedAt = at
    if (entry) entry.rev++
    await sc.store.update(tk.id, tk)
    // 正在执行的子对话马上收到新规则；没在执行的下一轮开始时从父对话读
    if (fresh)
      for (const k of [...sc.live.values()].filter((e) => e.task.parentTaskId === tk.id && e.task.working)) {
        const body = `父对话发布了新的全局规则，接下来必须遵守：${fresh}`
        const msg: TaskMessage = {
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: body,
          tools: [],
          peer: await sc.peerOf(tk, 'parent', 'rule', fresh),
          at,
        }
        const how = await steerTask(k.task, body, msg).catch(() => false)
        if (!how) k.task.messages.push(msg)
        k.rev++
      }
    return { task: tk }
  }

  /** 父对话分派的子对话：立刻开始执行，不再按并发上限排队 */
  async function startChild(sub: Task, message: string, agents: Agent[]) {
    try {
      // 启动中：父对话判断「有没有子对话在跑」时也算上；取到执行位就清掉
      sc.startQueue.add(sub.id)
      let got
      try {
        got = sc.reserve(sub)
      } finally {
        sc.startQueue.delete(sub.id)
      }
      // 同一个子对话已经被启动了：复用正在跑的那一轮，不再开第二个进程
      if (!got.fresh) return
      const entry = got.value
      await sc.start(entry, withAttachments(message, []), true, agents)
      await entry.done
    } catch (e) {
      log.error('task', '子对话执行出错', { task: sub.id, error: (e as Error).message })
      sc.alertOn(sub.id, 'panel', t('执行这个子对话时出错'), 'error')(e)
    }
  }

  return {
    activeChildren,
    advanceChildTo,
    childActive,
    childrenRunning,
    cliChildren,
    closeChildren,
    completing,
    nudgePlan,
    nudgeWrapUp,
    beforeEnd,
    nudgeState,
    noteStop,
    clearStop,
    resetNudge,
    reportToParent,
    reportedDone,
    reportedState,
    ruleCommand,
    settleChildTurn,
    startChild,
    childCountsOf,
    settleChildWorktree,
    reportKey,
    integrate,
  }
}
