import { Task, type Project } from '../../shared/schema.ts'
import { childHoldsOf, taskDeleted } from '../../shared/task.ts'
import { childRow } from '../../shared/children/row.ts'
import { log } from '../log.ts'
import { createWorktreeCache, type WorktreeRead } from '../worktree-cache.ts'
import { t } from '../../shared/i18n.ts'
import { createGate } from '../slots.ts'
import { taskCliAlive } from '../exec/process.ts'
import type { TasksScope } from './scope.ts'
import { descendantNeeds } from '../../shared/child-needs.ts'

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
    const all = (await s.store.list()).map((t) => s.live.get(t.id)?.task ?? t)
    const kids = all.filter((t) => t.parentTaskId === parent.id && !taskDeleted(t))
    // 子对话下面的孙对话在等用户处理：这一行也要显示「等你处理」（见 shared/child-needs.ts）
    const needs = descendantNeeds(all)
    let checking = 0
    const items = await Promise.all(
      kids.map(async (t) => {
        const liveTask = t
        // 独立分支的实际情况只问一次 git：既要说「没合回去」，也要说「还有几个文件没提交」。
        // 这里不等它（不让首屏跟着 git 一起慢），没核对过的先按「还不知道」回，界面不当成已合回
        const wt = await childWorktree(liveTask, project, { wait: false })
        if (!wt.checked) checking++
        // 一行的字段和演示后端同一份（shared/children/row.ts），这里只给真进程、真 git 这些只有正式版有的
        return childRow(liveTask, {
          cliAlive: taskCliAlive(liveTask.id),
          background: s.pendingJobs(liveTask.id),
          childNeeds: needs.get(liveTask.id) ?? 0,
          worktree: wt,
          // 不在内存里的子对话只有摘要（store.list 只留用户消息），算不出准确的「在做什么」
          full: s.live.has(liveTask.id),
          lastReply: s.lastReply(liveTask),
          stopReason: s.idle(liveTask).stopReason,
        })
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
    const kids = await s.store.childrenOf(parent.id)
    const before = kids.filter((x) => s.live.has(x.id)).length
    await s.closeChildren(parent.id)
    await Promise.all(kids.map((k) => s.endBackground(k.id)))
    return c.json({ stopped: before })
  })

  return { childUnmerged, gitGate }
}
