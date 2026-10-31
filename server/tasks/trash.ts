import { Task, type StopReason } from '../../shared/schema.ts'
import { taskDeleted } from '../../shared/task.ts'
import { forgetNotes } from '../exec/runner.ts'
import { forgetPresence } from '../presence.ts'
import type { TasksScope } from './scope.ts'
import { CHATS_DIR, HANDOFF_DIR, TASK_FILES_DIR } from '../store.ts'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { t } from '../../shared/i18n.ts'

/**
 * 回收站：删除只做标记，过期后物理删除；恢复、永久删除。
 */
export function createTrash(s: TasksScope) {
  /**
   * 彻底删掉一条对话的全部内容：任务记录和对话文件、独立分支、附件、聊天工作目录、节点交接文件。
   * 只有「回收站过期」和「永久删除」会走到这里；删除对话本身只做标记（见 enterTrash），
   * 用户删错了还能在保留期内恢复
   */
  async function purgeTask(tk: Task) {
    await s.store.remove(tk.id)
    forgetPresence(tk.id)
    s.background.forget(tk.id)
    await s.dropWorktree(tk)
    await rm(path.join(HANDOFF_DIR, tk.id), { recursive: true, force: true }).catch(() => {})
    await rm(path.join(TASK_FILES_DIR, tk.id), { recursive: true, force: true }).catch(() => {})
    // 聊天的工作目录、节点交接的文件跟着删掉
    await rm(path.join(CHATS_DIR, tk.id), { recursive: true, force: true }).catch(() => {})
  }

  /** 一组对话一起物理删除（子对话由调用方收进来）；附件最后按「还有没有别的任务在用」决定 */
  async function purgeTasks(tasks: Task[]) {
    for (const tk of tasks) await purgeTask(tk)
    await s.dropUploads(tasks)
  }

  /**
   * 删除对话 = 进回收站：任务记录、对话内容、独立分支、附件、聊天目录都先留着，
   * 保留期内（见 TRASH_RETENTION_DAYS）能完整恢复，过期后才物理删除（见 cleanupTrash）。
   * 进回收站先把它这一轮停下来、后台命令停掉：删除后不该再消耗机器，恢复后发新消息照常接着聊。
   * 已经删过的再删一次不改删除时间（保留期从第一次删开始算）
   */
  async function enterTrash(tk: Task, reason: StopReason = 'delete') {
    if (taskDeleted(tk)) return
    s.stopTask(tk.id, reason)
    forgetNotes(tk.id)
    // 等后台命令的进程真正退出：进程还占着目录时，过期清理在 Windows 上删不掉
    await s.endBackground(tk.id)
    await s.store.updateMeta(tk.id, { deletedAt: new Date().toISOString() })
  }

  // 删除 = 进回收站（物理删除只能从回收站里做，见 DELETE /:id/permanent）
  s.routes.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const task = await s.store.peek(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    // 删父对话时把它的子对话一起带进回收站，不留孤儿（恢复时也一起回来）
    const kids = (await s.store.list()).filter((x) => x.parentTaskId === id)
    await enterTrash(task)
    for (const k of kids) await enterTrash(k, 'parent')
    return c.body(null, 204)
  })

  // 永久删除：不进回收站，直接物理删除（界面先让用户二次确认）
  s.routes.delete('/:id/permanent', async (c) => {
    const id = c.req.param('id')
    // 要用完整对话收集附件目录，不能只拿任务文件里那几条用户消息
    const task = await s.store.get(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    s.stopTask(id, 'archive')
    forgetNotes(id)
    await s.endBackground(id)
    const kids = await Promise.all(
      (await s.store.list()).filter((x) => x.parentTaskId === id).map((x) => s.store.get(x.id)),
    )
    await purgeTasks([task, ...kids.filter((x): x is Task => !!x)])
    return c.body(null, 204)
  })

  // 从回收站恢复：清掉删除标记，对话重新回到列表，恢复后能接着聊。
  // 独立分支所在目录已经被面板回收（sweepStaleWorktrees 或手工删了）时把 worktree 置空并把 `worktreeCleared`
  // 交给界面提示「恢复后需要重新执行」：不能静默留一个指向不存在目录的分支。
  // 不标成 discarded——那会被 taskGone 认成「已收起」，恢复后的对话直接显示「已完成」，和这句提示对不上
  s.routes.post('/:id/restore', async (c) => {
    const id = c.req.param('id')
    const task = await s.store.peek(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    if (!taskDeleted(task)) return c.json({ worktreeCleared: false })
    const cleared = task.worktree?.state === 'active' && !existsSync(task.worktree.path)
    // 父对话恢复时，跟着它一起进回收站的子对话也一起回来
    const kids = (await s.store.list()).filter((x) => x.parentTaskId === id && taskDeleted(x))
    await s.store.updateMeta(id, {
      deletedAt: undefined,
      // 停下来的原因留成「删除时结束」：它确实是删除时结束的，比「已暂停 / 归档时结束」准确
      stopReason: 'delete' as const,
      ...(cleared ? { worktree: null } : {}),
    })
    for (const k of kids) await s.store.updateMeta(k.id, { deletedAt: undefined })
    return c.json({ worktreeCleared: cleared })
  })

  /** 恢复一组对话（删项目时一起进回收站的那些）：只清删除标记，和单条恢复一样 */
  async function restoreTasks(ids: string[]) {
    for (const id of ids) {
      const tk = await s.store.peek(id)
      if (tk && taskDeleted(tk)) await s.store.updateMeta(id, { deletedAt: undefined, stopReason: 'delete' as const })
    }
  }

  return { purgeTasks, enterTrash, restoreTasks }
}
