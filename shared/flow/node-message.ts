/**
 * 在流程图里选中一个节点、直接给它发消息（工作流运行，Task.flowRun）：按节点此刻的状态决定这条话怎么交。
 * 正式后端（server/tasks/flow-node-message.ts）和演示后端用同一份判定和改动，输入框上的说明也按它写，
 * 用户发之前就知道这条会插进去、留到节点开始，还是让节点带着意见重跑。
 * - 在跑：只插给这个节点正在做的这一轮（别的并行节点收不到）
 * - 停在等确认：当成「要求修改」回答那张确认卡
 * - 还没开始：记成给这个节点的补充说明，它开始时带上
 * - 做完 / 失败 / 跳过：退回到它，带着这条意见重跑（之后的节点也重跑）
 */
import type { Task, TaskStep } from '../schema.ts'
import { t } from '../i18n.ts'
import { RUN_ENDED, RUN_NO, rewindTo } from './run.ts'
import { topSteps } from './index.ts'

export type NodeMsgKind = 'steer' | 'revise' | 'note' | 'rerun'

type RunTask = Pick<Task, 'steps' | 'flowRun'>

/** 节点此刻收到消息会怎么处理；不能直接发给节点时返回 error（界面上不给选，接口按它拒绝） */
export function nodeMessagePlan(
  task: RunTask,
  nodeId: string,
): { kind: NodeMsgKind; step: TaskStep } | { error: string } {
  const f = task.flowRun
  if (!f) return { error: t('只有工作流运行能直接发给某个节点') }
  if (RUN_ENDED.includes(f.phase)) return { error: t('这次运行已经结束，不再接收消息') }
  const step = topSteps({ steps: task.steps }, RUN_NO).find((s) => s.id === nodeId || s.nodeId === nodeId)
  if (!step) return { error: t('这次运行里没有这个节点') }
  if (step.awaitConfirm) return { kind: 'revise', step }
  if (step.status === 'running') return { kind: 'steer', step }
  if (step.status === 'pending') return { kind: 'note', step }
  return { kind: 'rerun', step }
}

/** 输入框里的提示：发之前说清这条会怎么交给节点 */
export function nodeMessageHint(kind: NodeMsgKind, node: string): string {
  switch (kind) {
    case 'steer':
      return t('发给「{node}」：插进它正在做的这一轮，调整它的方向', { node })
    case 'revise':
      return t('发给「{node}」：按这条意见修改它的结果', { node })
    case 'note':
      return t('发给「{node}」：它开始执行时带上这条', { node })
    case 'rerun':
      return t('发给「{node}」：带着这条意见退回到它重跑，之后的节点也会重跑', { node })
  }
}

/** 发出后的一句回执 */
export function nodeMessageDone(kind: NodeMsgKind, node: string): string {
  switch (kind) {
    case 'steer':
      return t('已插给「{node}」', { node })
    case 'revise':
      return t('已让「{node}」按意见修改', { node })
    case 'note':
      return t('已记下，「{node}」开始时会带上', { node })
    case 'rerun':
      return t('已退回到「{node}」，带着意见重跑', { node })
  }
}

/** 记成给某个节点的补充说明：之后开始的节点按决定记录拿到（见 decisionsText），节点名点明是给谁的 */
export function noteForNode(task: RunTask, step: TaskStep, text: string, at: string) {
  task.flowRun?.decisions.push({ at, node: step.title, kind: 'note', text })
}

/**
 * 退回到这个节点：它和之后的节点改回待执行，意见记成「用户退回」，之后每个节点都看得到。
 * 返回退回了几个节点；调用方负责先停下在跑的运行、改完再接着跑
 */
export function rerunFromNode(task: RunTask & Pick<Task, 'status'>, step: TaskStep, text: string, at: string) {
  const f = task.flowRun
  if (!f) return 0
  const back = rewindTo(task, step.id)
  if (!back.length) return 0
  f.decisions.push({ at, node: step.title, kind: 'back', text })
  f.phase = 'running'
  f.pausedBy = undefined
  f.preAnswer = undefined
  f.told = ''
  task.status = 'stopped'
  return back.length
}
