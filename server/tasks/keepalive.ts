import { Task, type StopReason } from '../../shared/schema.ts'
import { keepAliveHolding, keepAliveVictims } from '../../shared/task.ts'
import { getSettings } from '../settings.ts'
import { hasHeld } from '../exec/delivery.ts'
import { isViewing } from '../presence.ts'
import { worktreeStatus } from '../exec/worktree.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import type { TaskProcess } from '../../shared/schema.ts'
import { subtreeTaskIds } from '../../shared/run-usage.ts'
import { trackedClis, untrackCliProcess } from '../exec/orphans.ts'
import { commandSummary, ownedEntries, processSnapshot, subtree, sumRss, trackedStatus } from '../exec/proc-stats.ts'
import { HARD_STOP } from '../exec/invoke.ts'
import type { TasksScope } from './scope.ts'
import type { Live } from './types.ts'
import { cancelWait } from '../exec/runner.ts'
import { settleReclaimed } from '../exec/reclaim.ts'

/**
 * 停止对话、保活上限与回收（还在运行的对话不回收，见 ADR 0012）、对话名下的进程面板。
 */
export function createKeepAlive(s: TasksScope) {
  const stopTask = (id: string, reason: StopReason) => {
    // 只有用户自己停止、归档时名下子对话才一起结束（原因记成 parent，不是用户暂停）。
    // 父对话自己的 CLI 已经退了（这一轮说完、只剩子对话在跑）也要停：在这里先做，不受下面「没在跑」的提前返回影响。
    // 闲置回收、换 CLI、打断重发、CLI 卡住重开只是父对话自己这一轮的事：子对话有自己的进程和状态，
    // 还在跑的不能跟着被杀，做完结果照样推回父对话（见 ADR 0012）
    if (reason === 'user' || reason === 'archive') void s.closeChildren(id)
    const e = s.live.get(id)
    if (!e) return
    // 已经在停了（停止按钮连点、closeChildren 先停一次再补一次）：别再推一条一模一样的提示
    const firstStop = !e.stop
    e.stop = true
    // 只有用户按的暂停才标成 'user'，其余调用点必须传清是谁结束的，界面才能不把它说成「已暂停」
    e.stopReason = reason
    // CLI 卡住了（没有响应）：不理会中断，直接结束进程，别让用户的新消息再等上几秒
    e.abort.abort(reason === 'stalled' ? HARD_STOP : undefined)
    // 用户按的暂停、父对话收尾、打断并重发：独立分支里没提交的改动会留在那儿，
    // 现在就在父对话里点明，不留到用户自己发现
    if (firstStop && (reason === 'user' || reason === 'parent' || reason === 'supersede'))
      void stopWorktreeNote(e.task, reason)
  }

  /**
   * 这个对话还在运行，不能回收、失活（ADR 0012）：两个回收时长、保活上限都先问它，页面开着还是切到后台都一样。
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

  /**
   * 保活会话的全局上限：CLI 回复完停在等下一句时会留一个进程，页面开着的不算（用户马上回来）。
   * 没人在看又超过设置里的上限时，结束最久没用的那个（reason='idle'），
   * 下次打开靠 --resume 续接，代价是冷启动一次。
   * 只收空闲会话：正在跑的对话（不管页面开着还是切到后台）不占名额也不被选走
   */
  async function enforceKeepAlive(selfId = '') {
    const { keepAliveLimit } = await getSettings()
    if (!keepAliveLimit) return
    // 还在运行的对话（自己或名下子对话、子任务、后台命令没完，提问没回复）不回收：只收真闲着的。
    // 判定和宽限到期时是同一个（keepAliveBusy → convActive）
    const pool = [...s.live.values()].map((e) => e.task).filter((t) => !keepAliveBusy(t.id))
    // 只放过前台正开着的页面：切走后还在宽限期里的也算进上限（hasViewer 会把它们都当成有人在看，
    // 一小时内点开过的对话全部豁免，上限形同虚设）。这里排掉的只有 running 的，见 keepAliveVictims
    // 刚进入保活的那个也算进上限（+1）；它其实是 busy（后台命令还在跑）时不占名额，别多收一个空闲会话
    const exceptId = selfId && !keepAliveBusy(selfId) ? selfId : ''
    const victims = keepAliveVictims(pool, keepAliveLimit, exceptId, isViewing)
    for (const id of victims) {
      log.info('task', '保活的会话超过上限，结束最久没用的', { task: id, limit: keepAliveLimit })
      stopTask(id, 'idle')
    }
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
  async function closeWaiting(id: string, e: Live) {
    if (!cancelWait(id)) stopTask(id, 'close')
    await e.done?.catch(() => {})
    // 计划没做完、落盘还写着执行中的，和页面宽限回收一样收口成已停止，界面不会一直转圈
    if (!s.live.has(id)) await settleReclaimed(s.store, id, 'close')
  }

  return { allowedPids, processPanel, stopTask, subtreeIdsOf, taskAlive, keepAliveBusy, enforceKeepAlive, closeWaiting }
}
