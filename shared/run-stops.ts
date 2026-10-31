import type { EngineHost } from './engine.ts'
import { clip } from './text.ts'

/*
 * 只停对话的一部分（一个子任务、一次工作流运行）用的开关：对话本身不停。
 * 从 engine.ts 拆出来：界面的终止按钮（服务端路由）、对话的 stop_subtask / 父对话的 stop_workflow 都走这里
 */

/**
 * 正在跑、在排队的子任务：任务 id + 子任务 id → 终止它用的开关。
 * 界面上的终止按钮（服务端的路由）和对话的 stop_subtask 工具都走 stopHelper，只停这一个，不动对话本身
 */
export const helperStops = new Map<string, AbortController>()
export const helperKey = (taskId: string, stepId: string) => `${taskId}\n${stepId}`

/** 终止一个子任务：还在跑就结束它的 CLI，还在排队就不再开始。why 写进交回给对话的结果；没找到返回 false */
export function stopHelper(taskId: string, stepId: string, why: string) {
  const ac = helperStops.get(helperKey(taskId, stepId))
  if (!ac || ac.signal.aborted) return false
  ac.abort(why)
  return true
}

/**
 * 对话里 start_plan 正在跑的工作流：任务 id → 终止它用的开关和所在的宿主。
 * 只停这次运行，不停对话：界面上工作流卡片的「终止」、父对话的 stop_workflow 都走 stopPlan，
 * 停下后运行的结果按「被终止」交回对话，这次运行改了哪些文件一起交回，由对话决定保留还是清理
 */
export const planStops = new Map<string, { ac: AbortController; host: EngineHost }>()

/** 终止这个对话正在跑的工作流；没有在跑的返回 false */
export function stopPlan(taskId: string, why: string) {
  const cur = planStops.get(taskId)
  if (!cur || cur.ac.signal.aborted) return false
  cur.ac.abort(why)
  // 已经排好的下一个节点、下一轮验收都不再开始；startPlan 收尾时会复位，后面的对话照常
  cur.host.halted = true
  // 工作流节点派出的子任务也一起停（对话自己这一轮已经结束，这时在跑的子任务都属于这次运行）
  const prefix = helperKey(taskId, '')
  for (const [k, ac] of helperStops) if (k.startsWith(prefix) && !ac.signal.aborted) ac.abort(why)
  return true
}

/** 父对话终止名下子对话的工作流（stop_workflow）：只认自己的子对话 */
export function stopChildPlan(parentId: string, id: string, why: string) {
  const cur = planStops.get(id.trim())
  if (!cur || cur.host.task.parentTaskId !== parentId) return { ok: false, info: `子对话 ${id} 现在没有在跑的工作流` }
  if (!stopPlan(id.trim(), why)) return { ok: false, info: `子对话 ${id} 的工作流已经结束了` }
  return {
    ok: true,
    info: `已终止子对话 ${id} 的工作流。它会收到「工作流被终止」和这次运行改了哪些文件，由它决定保留还是清理，处理完照常报状态。`,
  }
}

/** 工作流节点调用 CLI 时带上的信号：终止这次运行时结束正在跑的节点 */
export const planSignal = (host: EngineHost) => planStops.get(host.task.id)?.ac.signal

/**
 * 工作流被终止后交回对话的话：改动留不留由对话决定（用户 2026-10-30 定的），
 * 面板不自动撤回，免得把对话还想要的半成品、或者运行前就有的改动一起抹掉
 */
export function stoppedPlanText(s: { why: string; changes: string }) {
  return `### 工作流被终止
原因：${s.why}
${s.changes ? `这次运行改动了这些文件（和运行开始时比）：\n${clip(s.changes, 4000)}` : '这次运行没有留下文件改动（或这里不是 git 仓库，看不出改动）。'}
由你决定这些改动怎么处理：还用得上就保留并说明接下来怎么接着做；不要了就只撤回这次运行改的文件（改过的 git checkout -- <文件>，新加的删掉），运行开始前已有的改动不要动。处理完告诉用户你保留了什么、清理了什么，并更新计划里这一步（不再跑就标跳过并写明原因）。`
}
