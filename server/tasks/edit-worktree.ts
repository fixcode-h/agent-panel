import { randomUUID } from 'node:crypto'
import { Task, type Project } from '../../shared/schema.ts'
import { gitHead, gitNumstat } from '../exec/git.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { holdForNextTurn } from '../exec/delivery.ts'
import type { Live } from './types.ts'
import { placedFiles } from '../attachments.ts'
import { createWorktree, ensureWorktree, checkRepo } from '../exec/worktree.ts'
import { existsSync } from 'node:fs'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { isolated } from './helpers.ts'
import type { TasksScope } from './scope.ts'

/**
 * 子对话的独立分支：同一个父分支上的合并排队、恢复和开出 worktree、begin_edit（要改文件时才开）。
 */
export function createEditWorktree(s: TasksScope) {
  /**
   * 父对话的 CLI 结束了（宽限期到、用户停止、切换 CLI/模型、页面离开后被回收）：
   * 它名下子对话的进程一起结束，不留孤儿。子对话已产出的内容和状态都在，下次发消息会重新启动。
   * 统一在这里做，各个路由只管调用它。
   */
  /**
   * 同一个父对话下的合并 + 编译一个一个来：合并改的是原目录，编译也在那里跑，
   * 排成队就不会互相打断，也相当于一把构建锁
   */
  const mergeChains = new Map<string, Promise<unknown>>()
  const mergeWaiting = new Map<string, number>()
  function mergeLock<T>(rootId: string, fn: () => Promise<T>): Promise<T> {
    const prev = mergeChains.get(rootId) ?? Promise.resolve()
    mergeWaiting.set(rootId, (mergeWaiting.get(rootId) ?? 0) + 1)
    const next = prev
      .catch(() => {})
      .then(fn)
      .finally(() => mergeWaiting.set(rootId, (mergeWaiting.get(rootId) ?? 1) - 1))
    mergeChains.set(
      rootId,
      next.catch(() => {}),
    )
    return next
  }

  /**
   * 独立分支的工作区被回收了（合并完、标记完成、用户手动清理），对话又被继续：
   * 按原来的分支名把工作区建回来再执行，而不是直接报「项目目录不存在」。
   * 分支还在就从它接着改，分支也没了就从现在所在的分支重新开同名分支；合并回哪里也按当前目录重算。
   * 返回空字符串：不用重建或重建好了；返回的是给用户看的失败说明（已经尝试重建、怎么重试）。
   * 没开过独立分支、或者用户主动删除（discarded）的对话不受影响，仍在原目录执行。
   */
  async function restoreWorktree(tk: Task, project: Project): Promise<string> {
    const wt = tk.worktree
    if (!wt || (wt.state !== 'active' && wt.state !== 'merged')) return ''
    if (existsSync(wt.path)) return ''
    // 子对话从父对话现在的目录开、合回那里；顶层对话就是项目目录
    const cwd = (tk.parentTaskId ? await s.worktreeHome(tk, project) : '') || project.path
    try {
      const r = await ensureWorktree(cwd, wt, tk.id, tk.title)
      tk.worktree = r.worktree
      // 改动从重建这一刻重新算：之前的改动已经合回原分支了
      tk.baseRef = await gitHead(r.worktree.path).catch(() => tk.baseRef)
      tk.baseline = (await gitNumstat(r.worktree.path, tk.baseRef, placedFiles(tk)).catch(() => null)) ?? {}
      tk.updatedAt = new Date().toISOString()
      await s.store.update(tk.id, tk)
      log.info('task', '重建了独立分支的工作区', {
        task: tk.id,
        branch: r.worktree.branch,
        base: r.worktree.baseBranch,
        path: r.worktree.path,
      })
      return ''
    } catch (e) {
      log.warn('task', '重建独立分支的工作区失败', { task: tk.id, error: (e as Error).message })
      return (e as Error).message
    }
  }

  /** 重建失败时按「执行出错」记进对话：错误留得住，用户能照着里面写的重试 */
  function recordWorktreeError(tk: Task, error: string) {
    tk.status = 'failed'
    tk.working = false
    tk.awaitingUser = false
    tk.updatedAt = new Date().toISOString()
    tk.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: t('执行出错：{error}', { error }),
      tools: [],
      error: true,
      alert: makeAlert('error', error, 'worktree'),
      at: new Date().toISOString(),
    })
  }

  /**
   * 「独立 worktree」模式：子对话第一次执行时只记下「要改文件时开独立分支」，真要改时（begin_edit）
   * 才从父对话所在的目录开，只用来隔离改文件；只是查资料、回答问题的子对话不用开。
   * 不是 Git 仓库（P4、没有版本控制）时退回共用目录，靠认领文件避免冲突
   */
  async function ensureChildWorktree(entry: Live, project: Project | null | undefined) {
    const tk = entry.task
    if (!tk.parentTaskId || !project?.path || tk.worktree || tk.wantsWorktree) return
    if (project.childIsolation !== 'worktree') return
    const base = await s.taskDir({ ...tk, worktree: null })
    try {
      await checkRepo(base)
      entry.task.wantsWorktree = true
      await s.store.update(tk.id, entry.task)
    } catch (e) {
      log.info('task', '子对话不能开独立分支，共用目录', { task: tk.id, reason: (e as Error).message })
    }
  }

  /** 从对话现在的目录开独立分支（开不了时返回原因）。改动从分支开出的那一刻算起：原目录里别人没提交的改动不算这个对话的 */
  async function openWorktree(tk: Task): Promise<string> {
    const base = await s.taskDir({ ...tk, worktree: null })
    try {
      tk.worktree = await createWorktree(base, tk.id, tk.title)
    } catch (e) {
      log.warn('task', '开独立分支失败', { task: tk.id, error: (e as Error).message })
      return (e as Error).message
    }
    tk.wantsWorktree = false
    tk.baseRef = await gitHead(tk.worktree.path).catch(() => tk.baseRef)
    tk.baseline = (await gitNumstat(tk.worktree.path, tk.baseRef, placedFiles(tk)).catch(() => null)) ?? {}
    return ''
  }

  /** 还在执行或正在启动的子对话 */
  async function busyChildren(parentId: string) {
    return (await s.store.list())
      .filter((x) => x.parentTaskId === parentId)
      .map((x) => s.live.get(x.id)?.task ?? x)
      .filter((x) => x.working || s.startQueue.has(x.id))
  }

  /** 对话要改文件了：从它现在的目录开独立分支，这一轮结束后在新目录里开新会话接着做 */
  async function beginEdit(entry: Live, changed: (f?: boolean) => void): Promise<{ ok: boolean; info: string }> {
    const tk = entry.task
    if (isolated(tk)) return { ok: true, info: `已经在独立分支 ${tk.worktree!.branch} 里，直接改` }
    // 父对话的目录是子对话合并、编译的地方：有子对话在跑时父对话自己不改，交给子对话
    const busy = await busyChildren(tk.id)
    if (busy.length)
      return {
        ok: false,
        info: `现在有子对话在执行（${busy.map((k) => `「${k.title}」`).join('、')}），你不能自己改文件：用 send_to_conversation 交给相关的子对话，或者 create_conversation 新建一个。`,
      }
    const err = await openWorktree(tk)
    if (err) return { ok: false, info: `开独立分支失败：${err}\n先不要改文件，把情况告诉用户。` }
    const wt = tk.worktree!
    // 对话里不另记居中提示：begin_edit 这次工具调用本身显示成「开独立分支 分支名」，AI 的回复不被截断。
    // 这一轮结束后马上接着做：这里只登记交给新会话的要求（不记进对话）
    holdForNextTurn(tk.id, {
      id: randomUUID(),
      role: 'user',
      agentId: '',
      step: '',
      text: `（面板）已经开好独立分支 ${wt.branch}，你现在在它的目录里。接着刚才的任务开始修改；已经查清楚的不用重查。`,
      tools: [],
      at: new Date().toISOString(),
    })
    changed(true)
    log.info('task', '对话开了独立分支', { task: tk.id, branch: wt.branch })
    return {
      ok: true,
      info: `已开独立分支 ${wt.branch}（目录 ${wt.path}）。现在用一两句写下已经查到的情况和打算怎么改，然后马上结束这一轮，不要在当前目录改任何文件；面板会在独立分支的目录里开新会话，带上这段对话接着做。`,
    }
  }

  return { beginEdit, ensureChildWorktree, mergeLock, recordWorktreeError, restoreWorktree }
}
