/**
 * 演示版 `/tasks/:id/children` 的每一行：字段和正式后端 `server/tasks/children-routes.ts` 一一对应。
 * 从 demo-backend.ts 拆出来（那边顶到了行数上限），演示里没有真的进程和 git，按演示数据给值。
 */
import { demoJobs } from './demo-jobs'
import { bugStage } from '@shared/bug-diagnosis'
import { childBugStep, lastToolCall } from '@shared/child-doing'
import { descendantNeeds, pendingRequest } from '@shared/child-needs'
import { openPlan } from '@shared/plan'
import type { Task } from '@shared/schema'
import {
  childActivity,
  childLastActivity,
  childStartedAt,
  childWait,
  diagnosisPending,
  helpersWorking,
  runRunning,
  taskGone,
} from '@shared/task'
import { lastReplyText } from '@shared/task-helpers'
import { pendingAction } from '@shared/user-action'

export function demoChildRows(task: Task, tasks: Task[], demoCliAlive: (t: Task) => boolean) {
  // 和正式版一样：孙对话在等你处理时，这一行也显示「等你处理」
  const needs = descendantNeeds(tasks)
  return tasks
    .filter((x) => x.parentTaskId === task.id)
    .map((x) => {
      const doing = childActivity(x)
      const open = openPlan(x)
      // 还在跑 / 排队的后台命令：和正式版一样，CLI 在等命令结果时也算还没做完
      const background = demoJobs(x).filter((j) => j.state === 'running' || j.state === 'queued').length
      return {
        id: x.id,
        title: x.title,
        status: x.status,
        // 和正式后端一致：还没生成摘要时用最后一条回复兜底
        summary: x.summary || lastReplyText(x),
        working: x.working,
        updatedAt: x.updatedAt,
        // 进程还活着：正在跑的一定活着（演示里没有真的进程，就按 working 认）
        cliAlive: demoCliAlive(x),
        startedAt: childStartedAt(x),
        // 和正式版一致：等用户确认的请求数、没回答的提问数，行右边的时长靠它判断停在等你
        requests: (x.requests ?? []).length,
        request: pendingRequest(x),
        childNeeds: needs.get(x.id) ?? 0,
        asking: x.parentAsks?.length ?? 0,
        // 计划没做完：和正式版一致，显示「计划 7/8」、不算已完成；带上正在做的那一步
        plan: open ? { ...open, step: doing?.plan?.title, child: doing?.plan?.child } : undefined,
        // 和正式版一致：父对话的子对话栏靠这两项显示在做什么、多久没新输出
        activity: doing,
        lastActivityAt: childLastActivity(x),
        // 和正式后端对齐：面板自动问过状态、还没回复时行上显示「已自动询问」
        autoAsk: x.autoAsk,
        // 和正式后端对齐：做完没看过 → 子对话行上画未读点（见 shared/task.ts 的 childDoneDot）
        turnDoneAt: x.turnDoneAt ?? '',
        turnSeenAt: x.turnSeenAt ?? '',
        // 和正式后端对齐：运行区、悬浮层都靠这几项判断「还在跑 / 在等什么」
        background,
        workflow: runRunning(x),
        diagnosis: diagnosisPending(x),
        action: !!pendingAction(x),
        bug: bugStage(x) || undefined,
        // 和正式后端对齐：Bug 走到第几步、最后一次工具调用（子对话行的五个点和「在做什么」）
        bugStep: childBugStep(x),
        lastTool: lastToolCall(x),
        helpers: helpersWorking(x),
        unmerged: x.worktree?.state === 'active',
        // 和正式后端对齐：独立分支目录里还有几个文件没提交（没真的 git，按工作区状态给一个固定的数）
        dirty: x.worktree?.state === 'active' ? 1 : 0,
        // 和正式后端对齐：这两项是不是已经用 git 核对过（演示版没有真的 git，给了值就算核对过）
        worktreeChecked: true,
        dir: x.worktree?.path ?? '',
        wrapup: !!x.wrapRequest && x.wrapRequest.state !== 'failed',
        branch: x.worktree?.branch ?? '',
        stopReason: x.stopReason ?? '',
        waiting: childWait(x, { background, cliAlive: demoCliAlive(x) }),
        resolved: x.resolved === true,
        analysis: x.analysis,
        // 和正式后端对齐：归档 / 独立分支被删掉的条目不再算在跑（见 shared/task.ts 的 taskGone）
        gone: taskGone(x),
      }
    })
}
