import { Task, type StopReason } from '../../shared/schema.ts'
import { keepAliveHolding } from '../../shared/task.ts'
import { getSettings } from '../settings.ts'
import { dropHeld, hasHeld, markHeld } from '../exec/delivery.ts'
import { worktreeStatus } from '../exec/worktree.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import type { TaskProcess } from '../../shared/schema.ts'
import { subtreeTaskIds } from '../../shared/run-usage.ts'
import { killTaskClis, trackedClis, untrackCliProcess } from '../exec/orphans.ts'
import { commandSummary, ownedEntries, processSnapshot, subtree, sumRss, trackedStatus } from '../exec/proc-stats.ts'
import { HARD_STOP } from '../exec/invoke.ts'
import type { TasksScope } from './scope.ts'
import type { Live } from './types.ts'
import { cancelWait } from '../exec/steering.ts'
import { settleReclaimed } from '../exec/reclaim.ts'
import { taskLog } from './log.ts'
import { killTree, killTreeDeep, taskCliAlive } from '../exec/process.ts'
import { settleStopped } from '../../shared/tasks/settle.ts'
import { STOP_GIVE_UP_MS, TaskBusyError } from './helpers.ts'

/**
 * 停止对话、保活与回收（还在运行的对话不回收，见 ADR 0012）、对话名下的进程面板。
 */
/** 取消等下一句后等进程自己退出的时长，过了就强制停止（见 endLive）。比 invoke 的 EXIT_GRACE_MS 长：常驻协议的 CLI 先按正常退出收掉 */
export const END_LIVE_GRACE_MS = 20_000
/**
 * 用户停止后盯着这份执行的间隔：进程没了就是停下了，连着这么多次看不到它名下的 CLI 进程就直接收口，
 * 不再等引擎自己走完收尾（以前收尾卡在别处时，停止按钮要连点好几次）
 */
export const STOP_WATCH_MS = 1000
const STOP_GONE_TICKS = 3
/** 用户停止后进程还在的话，过了这么久直接杀掉（正常情况下停止当时就已经杀过一遍） */
export const STOP_KILL_MS = 8000

/** 用户意图的停止（暂停、随父对话停、归档、删除）：这些才盯着进程、到点直接收口 */
const WATCHED_STOPS = new Set<StopReason>(['user', 'parent', 'archive', 'delete']) // 模块状态：常量，加载后不改

export function createKeepAlive(s: TasksScope) {
  const stopTask = (id: string, reason: StopReason) => {
    // 只有用户自己停止、归档时名下子对话才一起结束（原因记成 parent，不是用户暂停）。
    // 父对话自己的 CLI 已经退了（这一轮说完、只剩子对话在跑）也要停：在这里先做，不受下面「没在跑」的提前返回影响。
    // 闲置回收、换 CLI、打断重发、CLI 卡住重开只是父对话自己这一轮的事：子对话有自己的进程和状态，
    // 还在跑的不能跟着被杀，做完结果照样推回父对话（见 ADR 0012）
    if (reason === 'user' || reason === 'archive') void s.closeChildren(id)
    const e = s.live.get(id)
    taskLog(id, '停止', { reason, live: !!e, already: e?.stop || undefined })
    s.noteStop(id, reason)
    if (!e) return
    // 已经在停了（停止按钮连点、closeChildren 先停一次再补一次）：别再推一条一模一样的提示
    const firstStop = !e.stop
    e.stop = true
    if (firstStop) e.stopAt = Date.now()
    // 只有用户按的暂停才标成 'user'，其余调用点必须传清是谁结束的，界面才能不把它说成「已暂停」。
    // 连带停（父对话停了、整棵树超了用量）不改已经在停的原因：用户刚单独停掉的子对话还没收完时父对话也停了，
    // closeChildren 再补一次 parent，覆盖掉的话「用户停的」就变成「随父对话停的」，父对话继续时又被拉起来（实测报告问题 3）
    if (firstStop || (reason !== 'parent' && reason !== 'budget')) e.stopReason = reason
    // CLI 卡住了（没有响应、换人接手）：不理会中断，直接结束进程，别让用户的新消息再等上几秒
    e.abort.abort(reason === 'stalled' || reason === 'replaced' ? HARD_STOP : undefined)
    // 用户要停的：进程没了就算停下了，不等引擎慢慢收尾；进程迟迟不退就直接杀（见 watchStop）
    if (WATCHED_STOPS.has(reason)) watchStop(id, e)
    // 用户按的暂停、父对话收尾、打断并重发：独立分支里没提交的改动会留在那儿，
    // 现在就在父对话里点明，不留到用户自己发现
    // 随父对话停（parent）的不说：停是父对话自己做的，再往它对话里发一条「子对话停止」只是噪音（用户报过）
    if (firstStop && (reason === 'user' || reason === 'supersede')) void stopWorktreeNote(e.task, reason)
  }

  /** 正在盯着的停止：同一份执行只盯一次（停止按钮连点、closeChildren 补停） */
  const watching = new WeakSet<Live>()

  /**
   * 停止后盯着这份执行名下的 CLI 进程：进程没了就是停下了，连着几次看不到进程就直接收口（abandonLive），
   * 不再等引擎把收尾走完；进程过了 STOP_KILL_MS 还在就杀掉，过了 STOP_GIVE_UP_MS 无论如何都收口。
   * 正常情况下引擎在进程退出后几十毫秒就收完了，这里只兜「收尾卡在别处」的那一类
   */
  function watchStop(id: string, e: Live) {
    if (watching.has(e)) return
    watching.add(e)
    const started = Date.now()
    let gone = 0
    let killed = false
    const tick = async () => {
      if (s.live.get(id) !== e || e.orphaned) return
      const elapsed = Date.now() - started
      gone = taskCliAlive(id) ? 0 : gone + 1
      if (gone >= STOP_GONE_TICKS) return void abandonLive(id, e, e.stopReason ?? 'parent', '停止后进程已经结束')
      if (elapsed >= STOP_GIVE_UP_MS) return void abandonLive(id, e, e.stopReason ?? 'parent', '停止后一直没收完')
      if (!killed && elapsed >= STOP_KILL_MS) {
        killed = true
        taskLog(id, '停止后进程还在，直接结束', { ms: elapsed })
        await killTaskClis(id, (pid) => void killTreeDeep(pid)).catch(() => [])
      }
      setTimeout(() => void tick(), STOP_WATCH_MS).unref?.()
    }
    setTimeout(() => void tick(), STOP_WATCH_MS).unref?.()
  }

  /**
   * 放弃这份执行：杀掉它名下的 CLI 进程，按停止（收尾的按正常结束）落盘，让出执行位，done 跟着结束。
   * 用在「进程已经没了引擎还没收完」「收尾卡住等不到」这两类：以前执行位一直占着，
   * 父对话再把任务交给这个子对话时消息被交进这份已经没人在跑的执行里，子对话一直停在「等待模型」，
   * 用户停止再继续，新的一轮也不知道那条任务（用户报过）。
   * 之后引擎就算收完了也不再写盘（Live.orphaned），不会盖掉新的一轮
   */
  async function abandonLive(id: string, e: Live, reason: StopReason, why: string): Promise<boolean> {
    if (s.live.get(id) !== e || e.orphaned) return false
    e.orphaned = true
    if (!e.stop || !e.stopReason) e.stopReason = reason
    e.stop = true
    e.abort.abort(HARD_STOP)
    cancelWait(id)
    const killed = await killTaskClis(id, (pid) => void killTreeDeep(pid)).catch(() => [] as number[])
    const how = e.stopReason ?? reason
    const tk = e.task
    // 收尾结束的（finish）这一轮已经答完：按正常结束落，排着的消息由收尾后的新一轮接着处理；
    // 别的按停止落（和启动迁移、页面回收同一份写法），排着的消息标成没送出去，用户知道要重发
    if (how === 'finish') {
      if (tk.status === 'running') tk.status = 'done'
      tk.working = false
      tk.awaitingUser = false
      tk.prewarming = false
    } else if (tk.status === 'running') Object.assign(tk, settleStopped(tk, how))
    else {
      tk.working = false
      tk.awaitingUser = false
      tk.prewarming = false
    }
    tk.apiWait = undefined
    for (const st of tk.steps) st.apiWait = undefined
    if (how !== 'finish') {
      const lost = dropHeld(id)
      if (lost.length) markHeld(tk.messages, lost, 'lost')
    }
    tk.updatedAt = new Date().toISOString()
    s.release(e)
    e.rev++
    e.abandon?.()
    taskLog(id, '放弃这份执行：进程已结束，直接收口', { reason: how, why, killed: killed.length || undefined })
    log.warn('task', '执行没有自己收完，面板直接收口并让出执行位', { task: id, reason: how, why })
    await s.store
      .update(id, tk)
      .catch((err) => log.warn('task', '收口放弃的执行时写盘失败', { task: id, error: (err as Error).message }))
    // 收尾时交来的新任务：这时执行位已经空了，接着开新的一轮（等着它的 wakeConv 也会试，撞上了就算了）
    if (how === 'finish' && hasHeld(id) && !s.shuttingDown)
      void s.followUp(id).catch((err) => {
        if (err instanceof TaskBusyError) return
        log.error('task', '放弃卡住的执行后没能接着处理排着的消息', { task: id, error: (err as Error).message })
        s.alertOn(id, 'delivery', t('收尾后没能接着处理排着的消息'))(err)
      })
    // 停下的子对话：父对话那边照常收到状态（引擎的收尾不会再报了）
    else if (tk.parentTaskId && how !== 'finish') void s.reportToParent(tk).catch(() => {})
    return true
  }

  /**
   * 停掉整棵对话树，自上而下一级一级停：先停发起的这个对话，再停它的子对话，再往下。每一层停的是对话本身，
   * 它派出的子任务和跑着的工作流跟着它的中断信号一起停，记成「被打断」（继续时能接着做）；不另用它们各自的终止开关，
   * 那样会记成「已终止」，工作流的计划会收口、子任务继续时也不会再接上。先停上面的，它就不会再处理下面停下时的消息、也不会重派新活
   * （自下而上的话父对话还在跑，收到子对话停下又去重派，用户报过）。停止标记全打完后再一起结束各自名下的 CLI 进程，不等各自收尾。
   * 子树里的都记成「随父对话停」（parent）：父对话继续时由面板拉起，也不再往父对话里发「已停止」——停是父对话自己做的。
   * 进程没了引擎马上就收完，收不完的由 watchStop 收口。用户停止时用（reason user）
   */
  async function stopTree(id: string, reason: StopReason = 'user') {
    const all = await s.store.list()
    const root = s.live.get(id)?.task ?? all.find((x) => x.id === id)
    if (!root) return
    const ids = subtreeTaskIds(all, id)
    const parentOf = new Map(all.map((x) => [x.id, x.parentTaskId]))
    const depth = (x: string) => {
      let d = 0
      for (let p = parentOf.get(x); p && d < 64; p = parentOf.get(p)) d++
      return d
    }
    // 发起的这个对话在最前，往下一层层排
    const order = [...ids].sort((a, b) => depth(a) - depth(b))
    for (const tid of order) {
      if (tid === id) {
        stopTask(id, reason)
        continue
      }
      if (!s.live.has(tid)) continue
      // 这一轮已经正常说完、停在等下一句（awaitingUser）的：取消等待让它照常结束，状态还是完成，
      // 标成停止的话父对话继续时会被白拉起来一轮（awaitingUser 和等下一句的等待者是 runner 的 listen 里一起设上的）
      if (s.live.get(tid)?.task.awaitingUser) {
        cancelWait(tid)
        continue
      }
      // 别的（在执行、在等子任务）一律按「随父对话停」：只取消等待的话等子任务的并没有停、也没记原因，
      // 收口时会被当成用户亲手停的，父对话继续时不拉起（用户报过）
      stopTask(tid, 'parent')
      cancelWait(tid)
    }
    // 名下的工作流运行（不是子对话，不在这棵树里）一起暂停，父对话继续时接着跑（design.md D4）
    const runs = s.flowRuns.pauseRunsOf(ids)
    let killed = 0
    for (const tid of [...order, ...runs])
      killed += (await killTaskClis(tid, (pid) => void killTreeDeep(pid)).catch(() => [])).length
    taskLog(id, '停止整棵对话树', { tasks: ids.size, killed: killed || undefined })
  }

  /** 已完成、CLI 还留着的子对话：id → 保留期到了结束它的定时器（见 keepDoneChild） */
  const doneKeep = new Map<string, ReturnType<typeof setTimeout>>()
  /** 已完成的子对话 CLI 还在保留期里：兜底回收不能把它当成收口后的遗留进程 */
  const keepingDone = (id: string) => doneKeep.has(id)

  /**
   * 子对话彻底完成后 CLI 先别结束：停在等下一句上再留设置里的「子对话完成后保留」这么久，
   * 父对话或用户这段时间里接着交代，消息直接交给同一个进程，不用冷启动；到点还没人用就结束它。
   * 只在 CLI 确实停在等下一句上时留（没人看着、早已退出的不用留）。返回 false 时由调用方马上结束
   */
  async function keepDoneChild(id: string, e: Live): Promise<boolean> {
    const minutes = (await getSettings()).childDoneKeepMinutes
    // awaitingUser：runner 停在等下一句上时置的（见 runner.ts 的 listen），等子任务时不算
    if (!minutes || s.live.get(id) !== e || !e.task.awaitingUser) return false
    clearTimeout(doneKeep.get(id))
    const timer = setTimeout(() => {
      doneKeep.delete(id)
      // 保留期里又接着做了（父对话交代了新任务、用户发了消息）：这一轮由它自己的收尾管，不在这里结束
      if (s.live.get(id) !== e || !e.task.resolved) return
      taskLog(id, '子对话完成后的保留期到了，结束 CLI', { minutes })
      void endLive(id, e, 'finish')
        .then(() => killTaskClis(id, killTree))
        .catch((err) =>
          log.warn('task', '保留期到了结束子对话的 CLI 失败', { task: id, error: (err as Error).message }),
        )
    }, minutes * 60_000)
    timer.unref?.()
    doneKeep.set(id, timer)
    taskLog(id, '子对话完成，CLI 再保留一段', { minutes })
    return true
  }

  /**
   * 这个对话还在运行，不能回收、失活（ADR 0012）：回收宽限先问它，页面开着还是切到后台都一样。
   * 判定就是 convActive（自己在跑、在等子任务 / 子对话 / 后台命令 / 工作流，有没回复的提问和请求），
   * 再加上这一轮没收尾、在预热、还有排队的消息。只有停在等下一句、什么都没挂着的才是空闲会话。
   * 名下子对话只算还在运行的（childActive）：父对话被回收不会再连带停掉子对话，闲着的子对话不用护着它
   * 没有执行位（这一轮结束、进程已退出）的对话也问一句：名下的子对话、后台命令还没回来时它在等结果，
   * 不是空闲会话
   */
  function keepAliveBusy(id: string): boolean {
    const entry = s.live.get(id)
    return keepAliveHolding({
      live: !!entry,
      task: entry?.task,
      more: s.startQueue.has(id) || hasHeld(id),
      background: s.pendingJobs(id),
      children: s.childrenRunning(id),
    })
  }

  /**
   * 停下时独立分支里还有没提交的改动：在父对话里点明几个文件没提交、改动在哪个目录，带着「继续」入口。
   * 不自动提交、也不清理目录（那是用户和子对话的改动），只把事实说清楚，接着做还是合并由用户定。
   * reason：被打断重发（supersede）紧接着就会开新的一轮，不能说成「已停下」，否则父对话会以为还要点「继续」
   */
  async function stopWorktreeNote(tk: Task, reason: StopReason) {
    const wt = tk.worktree
    if (!tk.parentTaskId || !tk.projectId || wt?.state !== 'active') return
    const project = await s.deps.projects.get(tk.projectId)
    if (!project) return
    // 和 /children 的同一个查询一样走并发闸：父对话停止时 closeChildren 会给每个子对话各触发一次
    const st = await s.gitGate(() => worktreeStatus(project.path, wt)).catch(() => null)
    if (!st?.dirty) return
    const how = { title: tk.title, id: tk.id, branch: wt.branch, n: st.dirty, path: wt.path }
    const text =
      reason === 'supersede'
        ? t(
            '【子对话被打断】「{title}」（id {id}）被新消息打断、马上接着做，独立分支「{branch}」里还有 {n} 个文件没有提交，目录：{path}。这些改动都还在。',
            how,
          )
        : t(
            '【子对话停止】「{title}」（id {id}）已停下，独立分支「{branch}」里还有 {n} 个文件没有提交，目录：{path}。这些改动都还在：可以让它继续接着做，或者合并、删除这个独立分支。',
            how,
          )
    await s
      .noteParent(
        tk.parentTaskId,
        tk,
        text,
        text,
        undefined,
        // 被打断的那条马上就在跑下一轮，不要说成「已中断」
        { id: tk.id, title: tk.title, state: reason === 'supersede' ? 'running' : 'stopped' },
        undefined,
        { dirty: st.dirty, path: wt.path, branch: wt.branch },
      )
      .catch((e) => log.warn('task', '子对话停止时没能提示父对话', { task: tk.id, error: (e as Error).message }))
  }

  // ---- 进程与内存：标题栏下拉里的进程列表、关闭、清理、内存曲线 ----

  /** 这个对话及它下面的全部任务（子对话、子对话的子对话、工作流节点所在的子对话） */
  const subtreeIdsOf = async (tk: Task) => subtreeTaskIds(await s.store.list(), tk.id)

  /** 进程面板判断「任务还活着」：还在内存里执行、保活等下一句，或者正在启动 */
  const taskAlive = (id: string) => s.live.has(id) || s.startQueue.has(id)

  /**
   * 这个对话（含附属的任务）的进程树（登记的主进程 + 它起的子进程，MCP 服务都算进去）和内存合计。
   * 只算自己这一支：打开子对话时看不到父对话和兄弟的进程
   */
  async function processPanel(tk: Task) {
    const ids = await subtreeIdsOf(tk)
    const entries = ownedEntries(trackedClis(), ids)
    const map = await processSnapshot()
    const now = Date.now()
    const processes: TaskProcess[] = []
    const pids = new Set<number>()
    for (const e of entries) {
      // 进程已经结束、登记还留着：顺手清掉，别让列表一直挂着一个不存在的 pid
      if (map && !map.has(e.pid)) {
        untrackCliProcess(e.pid)
        continue
      }
      const status = trackedStatus(e, taskAlive, now)
      for (const pid of map ? subtree(e.pid, map) : [e.pid]) {
        if (pids.has(pid)) continue
        pids.add(pid)
        const node = map?.get(pid)
        const startedAt = node?.startedAt ?? (pid === e.pid ? e.startedAt : null)
        processes.push({
          pid,
          parentPid: node && pid !== e.pid ? node.ppid : null,
          command: commandSummary(node?.argv ?? (pid === e.pid ? e.argv : '')),
          ownerTaskId: e.owner?.taskId ?? '',
          ownerTitle: e.owner?.title ?? '',
          startedAt,
          durationMs: startedAt ? Math.max(0, now - startedAt) : null,
          rss: node?.rss ?? null,
          status,
          kind: pid === e.pid ? 'cli' : 'child',
        })
      }
    }
    // 没有进程时是 0（这个对话确实没在跑），系统信息取不到时是 null（界面显示「未知」）
    const cliMemory = !map ? null : pids.size ? sumRss(pids, map) : 0
    const serverMemory = process.memoryUsage().rss
    return {
      sampledAt: now,
      processes: processes.sort((a, b) => (a.kind === b.kind ? a.pid - b.pid : a.kind === 'cli' ? -1 : 1)),
      cliMemory,
      serverMemory,
      // 面板自己的内存不属于这个对话：合计只算子树里的 CLI 进程，serverMemory 单独给出
      totalMemory: cliMemory,
      unavailable: map ? '' : t('取不到系统进程信息（权限不足或命令不可用）'),
    }
  }

  /** 这个对话子树能动的 pid：这些任务登记的进程和它们的整棵子树 */
  async function allowedPids(ids: Set<string>) {
    const entries = ownedEntries(trackedClis(), ids)
    const map = await processSnapshot()
    const out = new Set<number>()
    for (const e of entries) for (const pid of map ? subtree(e.pid, map) : [e.pid]) out.add(pid)
    return out
  }

  /** 结束停在等下一句的 CLI 进程（下一轮续接会话）：「关闭 Agent」和压缩会话共用 */
  /**
   * 让对话的 CLI 结束、等它这一份执行真的收完（执行位释放）。停在等下一句的先取消等待，让它自己退出；
   * 一会儿还没收完（CLI 关了输入也不退、收尾卡住）就按 reason 停掉，不能无限等：
   * 以前子对话收尾在这里等一个不退出的 CLI，执行位一直占着，父对话再交代任务时一直卡在「收尾那一刻」
   */
  async function endLive(id: string, e: Live, reason: StopReason, graceMs = END_LIVE_GRACE_MS) {
    const canceled = cancelWait(id)
    taskLog(id, '结束等下一句的进程', { canceled, reason })
    if (!canceled) stopTask(id, reason)
    const done = e.done?.catch(() => {})
    if (!done) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = await Promise.race([
      done.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), graceMs)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    if (!late) return
    taskLog(id, '取消等待后进程没在限时内结束，强制停止', { reason, graceMs })
    stopTask(id, reason)
    // 强制停止后也只再等一段：这一份执行的收尾卡在别处（等落盘、等别的对话）时不能把调用方一起拖住，
    // 收尾（completeChild）拖住就永远落不到「已完成」，completing 也永远不删
    const stuck = await Promise.race([
      done.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), graceMs)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    // 强制停止后还没收完：直接收口、让出执行位。只是「不再等它」的话执行位一直占着，
    // 父对话再交代任务时消息会被交进这份已经没有进程的执行里，子对话一直停在「等待模型」（用户报过）
    if (stuck) await abandonLive(id, e, reason, '强制停止后执行仍没收完')
  }

  async function closeWaiting(id: string, e: Live) {
    await endLive(id, e, 'close')
    // 计划没做完、落盘还写着执行中的，和页面宽限回收一样收口成已停止，界面不会一直转圈
    if (!s.live.has(id)) await settleReclaimed(s.store, id, 'close')
  }

  return {
    abandonLive,
    keepDoneChild,
    keepingDone,
    stopTree,
    allowedPids,
    processPanel,
    stopTask,
    subtreeIdsOf,
    taskAlive,
    keepAliveBusy,
    closeWaiting,
    endLive,
  }
}
