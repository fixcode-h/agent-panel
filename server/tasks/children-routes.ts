import { Task, type Project } from '../../shared/schema.ts'
import {
  childActivity,
  childLastActivity,
  childStartedAt,
  childWait,
  childHoldsOf,
  helpersWorking,
  runRunning,
  taskDeleted,
  taskGone,
} from '../../shared/task.ts'
import { log } from '../log.ts'
import { createWorktreeCache, type WorktreeRead } from '../worktree-cache.ts'
import { t } from '../../shared/i18n.ts'
import { openPlan } from '../../shared/plan.ts'
import { createGate } from '../slots.ts'
import { taskCliAlive } from '../exec/process.ts'
import type { TasksScope } from './scope.ts'

/**
 * 子对话列表：独立分支状态的缓存（git 慢时不挡列表）、/children、停止全部子对话。
 */
export function registerChildrenRoutes(s: TasksScope) {
  /** 这次没有 git 要问（没有独立分支、或还轮不到判完成） */
  const NO_WORKTREE: WorktreeRead<{ merged: boolean; ahead: number; dirty: number }> = { value: null, checked: true }
  /**
   * 还在动的子对话：子对话列表在有子对话在跑时 4 秒刷一次、都静止时 15 秒（见 TaskView 的
   * CHILD_POLL_ACTIVE_MS / CHILD_POLL_IDLE_MS），这里按较慢的那档留，免得每次刷新都为
   * 每个子对话新跑几条 git
   */
  const UNMERGED_TTL = 15_000
  /** 停下的子对话不会马上下一次：同一份状态留久一点，父对话页刷几遍时不必一直跑 git */
  const STOPPED_TTL = 60_000
  /** `/children` 慢过这么久就记一笔日志：它已经不等 git 了，再慢就是别的地方（子对话数、序列化） */
  const SLOW_CHILDREN_MS = 500
  /** 子对话栏查 git 的并发上限：几十个子对话时别一下子起上百个 git 进程 */
  const gitGate = createGate(4)
  /**
   * 后台补子对话分支状态的并发上限：和 `gitGate` 分开，它再慢也只排在自己这条队里。
   * 共用一道门的话，几十个子对话的后台刷新（上百条 git）会把判定路径和 `/worktrees` 的同步 git 排到后面
   */
  const backgroundGitGate = createGate(2)
  /**
   * 子对话独立分支状态：子对话 id → 当时的子对话版本、问的时间和结果。
   * 交给界面时不排队等 git（见 worktree-cache.ts），判定「算不算做完」时才等这次的结果
   */
  const worktreeCache = createWorktreeCache<{ merged: boolean; ahead: number; dirty: number }>({
    gate: gitGate,
    background: backgroundGitGate,
  })

  /**
   * 子对话独立分支的实际情况（只问本地 git）：合没合回去、还有几个未提交的文件。
   * 没停的子对话只在「别的条件都满足」时才问：还在跑、计划没做完时本来就轮不到判完成，
   * 每 4 秒为它们多跑几次 git 不值得。
   * 已经停下 / 失败的例外：用户点了停止，最想知道的就是「改的东西还在不在」，
   * 这时候不管计划做没做完都要报出未提交的文件（界面靠它显示「N 个文件未提交 + 继续」）
   *
   * wait 为 false 时只给手上这份、不等 git（界面用）：几十个子对话一起查会把消息和 SSE 首包拖住，
   * 后台补完下一次轮询就到位（见 worktree-cache.ts）。判定完成必须等最新结果的调用方不要传它
   */
  async function childWorktree(
    tk: Task,
    project: Project | null,
    opts?: { wait?: boolean },
  ): Promise<WorktreeRead<{ merged: boolean; ahead: number; dirty: number }>> {
    if (!project || tk.worktree?.state !== 'active') return NO_WORKTREE
    const stopped = tk.status === 'stopped' || tk.status === 'failed'
    if (!stopped && childHoldsOf(tk, { background: s.pendingJobs(tk.id), merged: true }).length) return NO_WORKTREE
    // 子对话没变过就沿用刚问过的结果：父对话页每 4 秒刷一次子对话栏，每个做完的子对话要跑 4 条 git，
    // 子对话一多、再开着两个页面，就是每秒十几个 git 进程抢 CPU 和仓库的锁
    const key = `${tk.updatedAt}|${tk.status}|${tk.worktree.branch}|${tk.worktree.path}`
    const ttl = stopped ? STOPPED_TTL : UNMERGED_TTL
    const load = () => s.worktreeStatusOf(project.path, tk.worktree!)
    if (opts?.wait === false) return worktreeCache.peek(tk.id, key, ttl, load)
    return worktreeCache.read(tk.id, key, ttl, load)
  }

  /**
   * 子对话的独立分支还没合回父对话的分支（见 childHolds 的 unmerged）。
   * 没查到（git 失败、还在核对）时按「还没合回」算：宁可晚一轮收尾，也不能把「不知道」当成
   * 「已经合回」放行——合没合回决定子对话能不能收尾，误判会丢改动（见 skill 的 childHolds 约定）
   */
  async function childUnmerged(tk: Task, project: Project | null) {
    const st = await childWorktree(tk, project)
    if (!st.checked) return true
    return !!st.value && !st.value.merged
  }

  // 父对话的子对话卡片：标题、状态、摘要和最近更新时间
  // 不等独立分支的 git 查询（wait: false）：几十个子对话时同步等 git 会把消息和 SSE 首包一起拖住，
  // 这里先给手上这份，git 结果在后台补，下一次轮询就到位（见 worktree-cache.ts）
  s.routes.get('/:id/children', async (c) => {
    const began = Date.now()
    const parent = await s.current(c.req.param('id'))
    if (!parent) return s.bad(c, t('任务不存在'), 404)
    const project = parent.projectId ? await s.deps.projects.get(parent.projectId) : null
    const kids = (await s.store.list()).filter((t) => t.parentTaskId === parent.id && !taskDeleted(t))
    let checking = 0
    const items = await Promise.all(
      kids.map(async (t) => {
        const liveTask = s.live.get(t.id)?.task ?? t
        // 子对话栏、超时判定、计划面板都读这两份：同一处算出「在做什么」和「在等什么」
        // 不在内存里的子对话只有摘要（store.list 只留用户消息），算不出准确的「在做什么」
        const doing = s.live.has(liveTask.id) ? childActivity(liveTask) : undefined
        const pending = s.pendingJobs(liveTask.id)
        const open = openPlan(liveTask)
        // 独立分支的实际情况只问一次 git：既要说「没合回去」，也要说「还有几个文件没提交」。
        // 这里不等它（不让首屏跟着 git 一起慢），没核对过的先按「还不知道」回，界面不当成已合回
        const wt = await childWorktree(liveTask, project, { wait: false })
        if (!wt.checked) checking++
        return {
          id: liveTask.id,
          title: liveTask.title,
          status: liveTask.status,
          summary: liveTask.summary || s.lastReply(liveTask),
          working: liveTask.working,
          updatedAt: liveTask.updatedAt,
          // 进程还活着（预热、等下一句、正在执行）：列表默认只列这些，不用 status === 'running' 猜。
          // 按真实进程登记算（taskCliAlive），CLI 关了就是 false
          cliAlive: taskCliAlive(liveTask.id),
          // 排序按本次开启的时间：做完或停下后又接到新任务会开新的一轮，重新排到最前面
          startedAt: childStartedAt(liveTask),
          // 总览分组用：等用户确认的请求数、还在跑的后台命令数、独立 worktree 的分支
          requests: liveTask.requests.length,
          // 后台命令跑在服务端，CLI 只是在等结果：有这个就还当执行中，不能显示成已完成
          background: pending,
          // start_plan 启动的工作流运行还没跑完：「启动工作流」那一行工具调用早就返回了，不能凭它当结束
          workflow: runRunning(liveTask),
          // 它派出去的子任务还在跑：结果交回来它还要接着做，也不能算做完了
          helpers: helpersWorking(liveTask),
          // 计划没做完（如「计划 7/8」）：不算已完成，浮层里归「未完成」；带上正在做的那一步
          plan: open ? { ...open, step: doing?.plan?.title, child: doing?.plan?.child } : undefined,
          // 独立分支还没合回父分支：任务看起来做完了也不算完成（见 childWorktree）。
          // 没有核对结果时两个字段都不给（不是 0 / false）：界面不能把「不知道」显示成「干净」或「已合回」
          unmerged: wt.checked ? !!wt.value && !wt.value.merged : undefined,
          // 分支目录里还有几个文件没提交：停下时行上直接写出来，并且给「继续」接着做
          dirty: wt.checked ? (wt.value?.dirty ?? 0) : undefined,
          // 上面两项是不是已经用 git 核对过：false 表示这次先回占位值、后台正在查（或刚查失败）
          worktreeChecked: wt.checked,
          // 已经请父对话收尾、还没出结果：行上是「待收尾」
          wrapup: !!liveTask.wrapRequest && liveTask.wrapRequest.state !== 'failed',
          // 这一轮做完的时间、用户看过的最近一轮完成时间：两处不同就是「做完了还没看」，
          // 子对话行的未读点读它（见 shared/task.ts 的 taskTurnUnread / childDoneDot）。
          // 只多两个时间戳，不为它读整份 .messages.json（/children 是热点，见之前那次性能优化）
          turnDoneAt: liveTask.turnDoneAt,
          turnSeenAt: liveTask.turnSeenAt,
          // 请用户选择、还没人回答的提问数：父对话的子对话栏里显眼地提示
          asking: liveTask.parentAsks?.length ?? 0,
          branch: liveTask.worktree?.branch ?? '',
          // 独立分支目录：停下时告诉用户改动在哪个目录里
          dir: liveTask.worktree?.path ?? '',
          activity: doing,
          // 最后有动静的时间：几分钟没有新输出、又不能用等待解释时，界面上标黄 / 标红
          lastActivityAt: childLastActivity(liveTask),
          // 面板以父对话的名义自动问过它状态：之后还没有新输出时行上写「已自动询问，等回复」
          autoAsk: liveTask.autoAsk,
          // 在等什么（等用户回答、等后台命令、等子任务、等工作流、等下一句）：不是在跑也不是卡住
          waiting: childWait(liveTask, { background: pending, cliAlive: taskCliAlive(liveTask.id) }),
          // 用户标记的「解决」：列表归到「已完成」并加标记，和 status / working 都无关
          resolved: liveTask.resolved === true,
          // AI 分析开出的子对话：列表里标题单独标出来
          analysis: liveTask.analysis,
          // 停下的原因：任务本身就有，页面不用再为每个停下的子对话取一遍完整对话
          stopReason: s.idle(liveTask).stopReason ?? '',
          // 已收起（归档 / 独立分支被用户删掉）：运行区、子对话栏、执行中计数都读这一处把它排掉（见 taskGone）
          gone: taskGone(liveTask),
        }
      }),
    )
    // 子对话栏是热点（打开父对话时每 4~15 秒刷一次）：慢过一截就记一笔，下次排查不必再从头量
    const spent = Date.now() - began
    if (spent >= SLOW_CHILDREN_MS)
      log.warn('children', '子对话栏返回慢（已不包含 git 查询）', { count: kids.length, checking, ms: spent })
    return c.json(items)
  })

  /** 对话设置里的「停止全部子对话」：正在执行的停下（输出和状态保留），等下一句的结束这一轮 */
  s.routes.post('/:id/children/stop', async (c) => {
    const parent = await s.current(c.req.param('id'))
    if (!parent) return s.bad(c, t('任务不存在'), 404)
    const kids = (await s.store.list()).filter((x) => x.parentTaskId === parent.id)
    const before = kids.filter((x) => s.live.has(x.id)).length
    await s.closeChildren(parent.id)
    await Promise.all(kids.map((k) => s.endBackground(k.id)))
    return c.json({ stopped: before })
  })

  return { childUnmerged, gitGate }
}
