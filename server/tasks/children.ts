import { randomUUID } from 'node:crypto'
import { Task, type Agent, type TaskMessage } from '../../shared/schema.ts'
import {
  advanceChild,
  planStalled,
  childFlowOf,
  childHolds,
  childHoldText,
  childFacts,
  childReport,
  convActive,
  convState,
  type ConvState,
  helperRunning,
  runRunning,
  taskDeleted,
  withAttachments,
  type ChildFlowStop,
  type ChildHold,
} from '../../shared/task.ts'
import { cancelWait, steerTask } from '../exec/runner.ts'
import { stopHelper } from '../../shared/engine.ts'
import { hasHeld } from '../exec/delivery.ts'
import {
  abortMerge,
  commitMerge,
  mergeBlocker,
  currentBranch,
  mergeSides,
  mergeSidesText,
  releaseWorktree,
  worktreeStatus,
  trialMerge,
} from '../exec/worktree.ts'
import { reapLostJobs } from '../background.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { activePlan, holdWait, planProgress, openWork, settlePlan } from '../../shared/plan.ts'
import { killTree, taskCliAlive } from '../exec/process.ts'
import { killTaskClis } from '../exec/orphans.ts'
import { RULE_CMD, isolated, HELPER_STOP_TIMEOUT_MS, HELPER_STOP_POLL_MS } from './helpers.ts'
import type { TasksScope } from './scope.ts'

/**
 * 子对话的生命周期：在跑的计数、彻底完成的判定和推进（advanceChildTo，ADR 0003）、合回、上报父对话、一轮结束时推进计划（nudgePlan，ADR 0032）、规则命令、启动子对话。
 */
export function createChildren(sc: TasksScope) {
  /**
   * 子对话还在运行（见 convActive）：在跑、等结果、等回答、正在启动，或者还有交过来的消息要接着处理。
   * 父对话的「子对话在跑」计数、标题和侧栏的转圈、能不能回收都读它
   */
  const childActive = (tk: Task) =>
    sc.startQueue.has(tk.id) ||
    hasHeld(tk.id) ||
    convActive(convState(childFacts(tk, { background: sc.pendingJobs(tk.id) })))

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
  let childScan: { at: number; byParent: Map<string, { working: number; cli: number }> } | null = null
  async function childCountsOf(parentId: string) {
    const now = Date.now()
    if (!childScan || now - childScan.at >= CHILD_COUNT_TTL) {
      const byParent = new Map<string, { working: number; cli: number }>()
      for (const k of await sc.store.list()) {
        if (!k.parentTaskId) continue
        const c = byParent.get(k.parentTaskId) ?? { working: 0, cli: 0 }
        if (taskCliAlive(k.id)) c.cli++
        if (childActive(sc.live.get(k.id)?.task ?? k)) c.working++
        byParent.set(k.parentTaskId, c)
      }
      childScan = { at: now, byParent }
    }
    return childScan.byParent.get(parentId) ?? { working: 0, cli: 0 }
  }

  /** 名下还在运行的子对话数（见 childActive） */
  async function activeChildren(parentId: string) {
    return (await childCountsOf(parentId)).working
  }

  /** 名下 CLI 进程还活着的子对话数：标题流光、侧栏提示用（见 taskCliAlive） */
  async function cliChildren(parentId: string) {
    return (await childCountsOf(parentId)).cli
  }

  /** 交给界面的任务：补上后台命令和还在运行的子对话数，对外的状态（taskState）才算得全 */
  async function withLive(task: Task): Promise<Task> {
    // 面板上次被强杀、崩溃时还没结束的后台命令：记录跟着进程没了，那一行收口成「结果丢失」，不永远转圈
    if (reapLostJobs(task, sc.background.known)) {
      task.updatedAt = new Date().toISOString()
      const e = sc.live.get(task.id)
      if (e) e.rev++
      await sc.store
        .update(task.id, task)
        .catch((err) =>
          log.warn('background', '收口丢失的后台命令失败', { task: task.id, error: (err as Error).message }),
        )
    }
    const t = sc.withJobs(task)
    if (task.parentTaskId) return t
    // 0 也写上：理由同 withJobs
    const kids = await childCountsOf(task.id)
    return { ...t, childrenWorking: kids.working, childrenCli: kids.cli }
  }

  /**
   * 父对话已经收到「子对话已完成」上报的子对话。只在进程里记：重启后把已经置完成（resolved）的当作上报过了，
   * 不重复往父对话里刷同一条「已完成」
   */
  const reportedDone = new Set<string>()

  /** 上次交给父对话的状态（见 reportChild）：同一个状态不重复报 */
  const reportedState = new Map<string, string>()
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
      return `unfinished|${plan ? `${plan.id}:${planProgress(tk, plan).done}` : ''}|${openWork(tk).length}`
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
    if (entry) {
      if (!cancelWait(childId)) sc.stopTask(childId, 'finish')
      await entry.done?.catch(() => {})
    }
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
    // 落到 resolved 之后再核对一次：上面只停得到本进程 live 里的那一轮，
    // 重启前留下的、或某条路径漏停的 CLI 还挂在登记里（任务已经完成了，进程留着没人要）。
    // 日志由 killTaskClis 写，里面带任务和 pid
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

  /** 一次合并：试合并 → 提交；冲突或原目录状态不对就撤回，原目录不变 */
  async function integrate(tk: Task, parent: Task): Promise<{ ok: boolean; info: string }> {
    const wt = tk.worktree!
    const target = await sc.taskDir(parent)
    // 从哪开的分支就合回哪：原目录后来换了分支就不合，免得合到别的分支上
    const now = await currentBranch(target)
    if (wt.baseBranch && now !== wt.baseBranch)
      return {
        ok: false,
        info: `原目录现在在「${now || '分离的 HEAD'}」，不是开分支时的「${wt.baseBranch}」，没有合并。切回「${wt.baseBranch}」后再合。`,
      }
    const blocked = await mergeBlocker(target)
    if (blocked) return { ok: false, info: `${blocked}，没有合并。这不是你的问题，等父对话或用户处理好后再合。` }
    // 两边都改过的文件：git 只在同一处改动上报冲突，同一个文件改不同位置会静默合上。
    // 合并前连同双方的提交记录一起记下来：合进去时一并告诉子对话和父对话「这个文件两边都动过」，
    // 并且让他们能按提交说明和文档看懂各自为什么这么改，而不是只看 diff 拿主意（见 project-vcs 的「合并审查」）
    const sides = await mergeSides(target, wt.branch).catch(() => null)
    const overlap = sides?.overlap ?? []
    const about = sides ? `\n\n${mergeSidesText(sides)}` : ''
    const m = await trialMerge(target, wt.branch)
    if (!m.ok)
      return {
        ok: false,
        info: m.dirty
          ? `原目录里有还没提交的改动和你改的文件重叠，没有合并，原目录没有改动。这不是你的问题，告诉父对话，等那边处理后再合。\n${m.error}${about}`
          : `和「${wt.baseBranch || '原分支'}」上新合进去的改动冲突，已撤回，原目录没有改动。在你的目录里先 git merge ${wt.baseBranch || '原分支'} 把它合进来、解决冲突、重新跑一遍验证并提交，再调用 submit_merge。\n${m.error}${about}`,
      }
    if (m.nothing) return { ok: true, info: '分支上没有新的改动，原分支已经是最新的' }
    try {
      const sha = await commitMerge(target, `Agent 面板：合并「${tk.title}」`)
      const both = overlap.length
        ? `\n两边都改了这些文件：${overlap.slice(0, 20).join('、')}${overlap.length > 20 ? ` 等 ${overlap.length} 个` : ''}。git 已经自动合并，但同一个文件两边都动过：必须逐文件核对有没有盖掉对方的改动，核对结论写进合并结论（见 project-vcs 技能 git.md 的「合并审查」）。`
        : ''
      return {
        ok: true,
        info: `已合进「${wt.baseBranch || '原目录'}」（${sha}），改了 ${m.files.length} 个文件。${both}`,
      }
    } catch (e) {
      await abortMerge(target)
      return { ok: false, info: `合并后提交失败，已撤回：${(e as Error).message}` }
    }
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
    const tk = sc.live.get(childId)?.task ?? (await sc.store.get(childId))
    if (!tk?.parentTaskId) return
    // 父对话正在合并：合并结果出来时再报，这时报「待收尾」「未完成」会让父对话误判
    if (sc.merging.has(childId)) return
    const jobs = sc.background
      .list(childId)
      .filter((j) => j.state === 'queued' || j.state === 'running')
      .map((j) => j.name)
    // 这一轮结束后还要接着做：排队的要求、面板交过来的消息、刚开好独立分支马上在分支目录里接着做的
    const more = sc.startQueue.has(childId) || hasHeld(childId)
    const project = isolated(tk) ? await sc.deps.projects.get(tk.projectId) : null
    const r = childReport(tk, { background: jobs, more, unmerged: await sc.childUnmerged(tk, project ?? null) })
    if (r.settle === 'hold') {
      await holdChildWait(tk, r.why).catch((e) =>
        log.warn('task', '更新父对话计划的等待说明失败', { task: tk.id, error: (e as Error).message }),
      )
      if (!r.notify) return
      // 计划没做完就收尾：由面板推子对话接着做（nudgePlan），不发消息打扰父对话——父对话收到也只能再催一遍。
      // 面板推过一次（同一进度）还停在原地，才告诉父对话一次
      if (r.state === 'unfinished' && openWork(tk).length && !sc.stuckAfterNudge(tk)) return
    }
    // 面板重启时被停下的：不是出错，重启后由恢复流程接着做，不往父对话里报「已中断」
    if (r.state === 'stopped' && tk.stopReason === 'restart') return
    const key = reportKey(tk, r.state)
    if (reportedState.get(childId) === key) return
    reportedState.set(childId, key)
    // 先取最新的回复：task.summary 要等整次执行收尾才更新，这一轮刚报完成（进程还在、或保活等下一句）时
    // 它还是上一轮的，上报会带着上一轮的结果
    const summary = sc.lastReply(tk) || tk.summary
    // 只剩合回却没请收尾：父对话不能直接 finish_child（要等它请求），点明下一步，免得父对话收到了也不知道该做什么
    const next =
      r.state === 'unfinished' && isolated(tk) && !openWork(tk).length
        ? '\n下一步：用 send_to_conversation 让它在自己的分支里跑通验证后调用 submit_merge；它请求收尾后你再 finish_child。'
        : r.state === 'unfinished'
          ? `\n面板已经推过它一次接着做，它仍停在这里。用 send_to_conversation 交回这个子对话（id ${tk.id}），写清下一步要做什么；不要另建一个子对话重做。`
          : r.state === 'failed' || r.state === 'stopped'
            ? `\n要重试就用 send_to_conversation 交回这个子对话（id ${tk.id}），它在原来的会话里接着做；不要另建一个子对话重做。它确实起不来（交回时报错）再另建子对话接着做，并在派单里写明接手的是哪个子对话的活。`
            : ''
    const text = `【子对话状态】「${tk.title}」（id ${tk.id}）${r.why}${next}${summary ? `\n最近的结果：${summary.slice(0, 1500)}` : ''}`
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
    )
  }

  /**
   * 子对话这一轮结束了（CLI 报完成、停在等下一句，或者整次执行结束）：
   * 独立分支里的先试着收口（条件都满足就完成、回收；只差请求收尾时提醒它一次），再统一上报父对话。
   * 放到下一拍：别在 CLI 收尾的回调里结束它
   */
  function settleChildTurn(child: Task) {
    if (!child.parentTaskId) return
    if (isolated(child) && !hasHeld(child.id) && !sc.merging.has(child.id) && !child.resolved) {
      setImmediate(
        () =>
          void settleChildWorktree(child.id).catch((e) => {
            log.warn('task', '子对话一轮结束收口失败', { task: child.id, error: (e as Error).message })
            sc.alertOn(child.id, 'panel', t('这一轮结束后整理独立分支、上报父对话时出错'))(e)
          }),
      )
      return
    }
    void (async () => {
      if (await nudgePlan(child)) return
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
  async function settleChildWorktree(childId: string) {
    const tk = sc.live.get(childId)?.task ?? (await sc.store.get(childId))
    if (!tk?.parentTaskId) return
    if (isolated(tk)) {
      const { holds } = await advanceChildTo(childId)
      if (!holds.length) return
      if (await nudgeMerge(tk)) return
    }
    if (await nudgePlan(tk)) return
    await reportChild(childId)
  }

  /**
   * 对话这一轮说完了，计划却没做完、也没在等任何结果（见 planStalled）：常见于模型只回了一句
   * 「先跑类型检查」「我跑 test:failed」就收尾，那次回应里没有任何工具调用，CLI 照常报这一轮结束（用户报过多次）。
   * 子对话这时父对话只会收到一条状态，它在忙别的就没人推；顶层对话就一直停在等下一句。这里由面板马上推它接着做下一步。
   * 同一个进度只推一次（见 planNudged），推了没动静：子对话照常上报父对话，顶层对话就停在那里等用户。
   * 推出去了（或者已经排好稍后推）返回 true
   */
  async function nudgePlan(conv: Task): Promise<boolean> {
    /** settled：这一轮已经停稳（进程结束，或者停在保活上等下一句）；刚结束那一下 CLI 还没停到等待上，不看这一项 */
    const stalled = async (settled: boolean) => {
      const tk = sc.live.get(conv.id)?.task ?? (await sc.store.get(conv.id))
      if (!tk || tk.imported || taskDeleted(tk) || !planStalled(tk)) return undefined
      // 正常说完的一轮：进程结束了（done），或者还停在保活上等下一句（这时 status 仍是 running）。
      // 失败、被停下的不推：那是出错了或用户让它停，要让用户看到再决定
      if (settled && !(tk.status === 'done' || (tk.status === 'running' && tk.awaitingUser))) return undefined
      // 等用户回答、等确认、还有排队要处理的消息、后台命令还在跑：不是停住了
      if (tk.requests.length || tk.parentAsks?.length || hasHeld(tk.id) || sc.startQueue.has(tk.id)) return undefined
      if (sc.background.list(tk.id).some((j) => j.state === 'queued' || j.state === 'running')) return undefined
      const plan = activePlan(tk)!
      return { tk, plan, p: planProgress(tk, plan) }
    }
    const now = await stalled(false)
    if (!now) return false
    const key = `${now.plan.id}:${now.p.done}`
    if (sc.planNudged.get(conv.id) === key) return false
    sc.planNudged.set(conv.id, key)
    // 稍等一下再推：这一轮刚结束时 CLI 还没停到「等下一句」上；等它停稳了再看一次，还停着才推
    setTimeout(() => {
      void (async () => {
        const again = await stalled(true)
        if (!again || `${again.plan.id}:${again.p.done}` !== key) {
          if (conv.parentTaskId) await reportChild(conv.id)
          return
        }
        const left = openWork(again.tk)
        // 失败的步骤（等的结果没成功、工作流没走完）先处理：不点明的话对话会跳过它往下做，或者干脆停着
        const failed = left.find((s) => s.status === 'failed')
        const next = failed ?? left.find((s) => s.status === 'running') ?? left[0]
        const text =
          `【面板】你的计划才做了 ${again.p.done}/${again.p.total}，也没有在等任何结果，这一轮却结束了。` +
          (failed
            ? `「${failed.title}」失败了${failed.note ? `（${failed.note}）` : ''}，先处理它：查清原因修好后重做（把它标回进行中），确实不做了就标成跳过，然后接着做计划。`
            : next
              ? `接着做「${next.title}」：`
              : '接着做下一步：') +
          '直接调用工具去做，不要只回一句打算就结束；做完一步就用 set_plan 标完成，再做下一步，直到计划做完。' +
          '确实卡住了就说明卡在哪一步、需要什么才能继续。'
        const ok = again.tk.parentTaskId
          ? (await sc.sendToChild(again.tk.parentTaskId, again.tk.id, text, 'build')).ok
          : await sc.wakeConv(again.tk.id, text, { panel: 'build' }).then(
              () => true,
              () => false,
            )
        if (ok)
          log.info('task', '对话计划没做完就收尾，已推它接着做', {
            task: conv.id,
            done: again.p.done,
            total: again.p.total,
          })
        else if (conv.parentTaskId) await reportChild(conv.id)
      })().catch((e) => log.warn('task', '推对话接着做计划失败', { task: conv.id, error: (e as Error).message }))
    }, sc.PLAN_NUDGE_MS).unref?.()
    return true
  }

  /**
   * 子对话这一轮做完了，除了合回之外都做完了，却没请父对话收尾：推一条面板消息提醒它跑通验证后调用 submit_merge。
   * 只提醒一次，再结束还没请就照常上报父对话（未完成），由父对话决定。提醒发出去了返回 true
   */
  async function nudgeMerge(child: Task): Promise<boolean> {
    if (!child.parentTaskId || sc.mergeNudged.has(child.id) || child.wrapRequest) return false
    if (child.status !== 'done' || child.working) return false
    if (child.requests.length || child.parentAsks?.length || openWork(child).length) return false
    if (sc.background.list(child.id).some((j) => j.state === 'queued' || j.state === 'running')) return false
    const project = await sc.deps.projects.get(child.projectId)
    const st = project ? await worktreeStatus(project.path, child.worktree!).catch(() => null) : null
    if (!st) return false
    // 分支已经在原分支里了（子对话或它派的子任务自己 git merge 过去），计划却还停在「合回」这一步：
    // 不提醒的话没人会去调用 submit_merge，计划一直卡在收尾、子对话也一直不算完成
    const wrapOpen = !!activePlan(child)?.steps.some((s) => s.wrapUp === 'merge' && s.status !== 'done')
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
    reportToParent,
    reportedDone,
    reportedState,
    ruleCommand,
    settleChildTurn,
    startChild,
    withLive,
    settleChildWorktree,
    reportKey,
    integrate,
  }
}
