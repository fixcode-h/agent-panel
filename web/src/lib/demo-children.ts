/**
 * 演示版 `/tasks/:id/children`：一行的字段和正式后端同一份（shared/children/row.ts 的 childRow），
 * 这里只给演示里代替真进程、真 git 的值。
 */
import { childRow } from '@shared/children/row'
import { descendantNeeds } from '@shared/child-needs'
import type { Task } from '@shared/schema'
import { taskDeleted } from '@shared/task'
import { lastReplyText } from '@shared/task-helpers'

/** 还在跑 / 排队的后台命令数（演示里没有服务端的命令表，按任务上记着的算） */
export const demoPendingJobs = (x: Task) =>
  (x.jobs ?? []).filter((j) => j.state === 'running' || j.state === 'queued').length

export function demoChildRows(task: Task, tasks: Task[], demoCliAlive: (t: Task) => boolean) {
  // 和正式版一样：孙对话在等你处理时，这一行也显示「等你处理」
  const needs = descendantNeeds(tasks)
  return tasks
    .filter((x) => x.parentTaskId === task.id && !taskDeleted(x))
    .map((x) =>
      childRow(x, {
        cliAlive: demoCliAlive(x),
        background: demoPendingJobs(x),
        childNeeds: needs.get(x.id) ?? 0,
        // 演示里没有真的 git：给了独立分支就当核对过，按工作区状态给一个固定的未提交数
        worktree: {
          checked: true,
          value: x.worktree?.state === 'active' ? { merged: false, dirty: 1 } : null,
        },
        // 演示的对话都整份在内存里
        full: true,
        lastReply: lastReplyText(x),
        stopReason: x.stopReason,
      }),
    )
}
