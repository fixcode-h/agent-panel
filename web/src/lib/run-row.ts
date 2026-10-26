/**
 * 运行区里那行「工作流」要不要画、画什么：任务页的运行区（`web/src/components/tasks/Messages.tsx` 的
 * `RunningFooter`）、分隔线和渲染都读这里算出来的同一个值，不各自再判一遍（判空和渲染分叉就会在
 * 总结下面留一根空横线，见模块文档）。
 *
 * 判定放在 lib 而不是组件里，是为了能单独测：工作流任务和「对话里 start_plan 起的计划」共用同一套，
 * 以前只认 `task.mode === 'chat'`，工作流任务自己跑的时候运行区什么也不列。
 */
import type { Task, TaskMessage, TaskStep } from '@shared/schema'
import { currentRun, topSteps } from '@shared/flow'
import { runRunning } from '@shared/task'
import { t } from '@shared/i18n'

/** 运行区那一行要画的工作流运行 */
export interface WorkflowRun {
  /** 还在跑 / 失败 / 被停止（完成不画这一行） */
  status: 'running' | 'failed' | 'stopped'
  /** 第几次运行：进度按它算节点，「打开这次运行的视图」也用它（RunPanel 的 run） */
  run: number
  /** 工作流名字：运行记录里的 → 任务上的 → 「工作流」 */
  name: string
  /** 这次运行已经做完的顶层节点数 */
  done: number
  /** 这次运行的顶层节点数 */
  total: number
  /** 这次运行的开始时间（空字符串表示没有记录，不显示耗时） */
  startedAt: string
  /** 失败的顶层节点：失败 / 被停止时展开看 */
  failed: TaskStep[]
}

/**
 * 这次运行现在的状态：还在跑、失败、被停止；完成或没有运行时是 undefined（那一行就不出现）。
 * 对话里 start_plan 起的运行和工作流任务自己的运行都记在 task.runs 里，两种任务共用这一份判定
 */
export function workflowRunState(task: Task): WorkflowRun | undefined {
  const rec = task.runs?.at(-1)
  const run = rec?.id ?? currentRun(task)
  const steps = topSteps(task, run)
  const failed = steps.filter((s) => s.status === 'failed')
  // 还在跑按 shared/task.ts 的 runRunning 判：启动工作流这个工具调用一下子就会返回，
  // 运行本身在它后面接着跑，拿工具调用来判会把还在跑的工作流当成结束了
  const status = runRunning(task)
    ? 'running'
    : failed.length || rec?.status === 'failed'
      ? 'failed'
      : rec?.status === 'stopped'
        ? 'stopped'
        : undefined
  if (!status) return undefined
  return {
    status,
    run,
    name: rec?.workflowName || task.workflowName || t('工作流'),
    done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: steps.length,
    startedAt: rec?.startedAt ?? '',
    failed,
  }
}

/** 任务里最后一条属于对话的消息的 id（节点的输出不算）：拿来认哪一轮是最新的一轮 */
function lastChatId(msgs: TaskMessage[]) {
  for (let i = msgs.length - 1; i >= 0; i--) if (!msgs[i].step) return msgs[i].id
  return ''
}

/**
 * 运行区里那行工作流要不要画、画什么：没在跑（或没有运行）不画；不是最新的一轮也不画——
 * 工作流在跑时这一轮往往已经收尾，拿不到 last，按「最后一条对话消息在这一轮里」认。
 *
 * 这条兜底只认没有节点的消息：工作流任务的追加要求回复也是没有 step 的（`server/exec/runner.ts`
 * 的 `runAgent` 按 `call.step?.id ?? ''` 取，追加要求不传 step），所以它落在主 Agent 那一轮里、
 * 能命中；真正带 `@main` 的只有旧任务留下的编排器步骤。
 */
export function runRow(task?: Task, msgs: TaskMessage[] = [], last?: boolean): WorkflowRun | undefined {
  if (!task) return undefined
  const info = workflowRunState(task)
  if (!info) return undefined
  if (!last && !msgs.some((m) => m.id === lastChatId(task.messages))) return undefined
  return info
}
