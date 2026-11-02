import type { EngineHost } from './engine.ts'
import type { TaskStep } from './schema.ts'
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

/*
 * 被打断的子任务（pending + interrupted）怎么接着做：从 engine.ts 拆出来的两条规则。
 * 续接说明里写过「带 resume 接着跑」，模型照样另派一批「重派」，原来那批一直挂着「已打断」（用户 2026-11-02 报过），
 * 所以由 spawn_agents 强制：要么 resume 它，要么 stop_subtask 终止后再派
 */

/**
 * 这次要另派新的子任务时，还有被打断、没做完、这次也没 resume 的：返回拒绝的说法，没有就是空串。
 * mine 是派出方名下的子任务，fresh 是这次新派的个数，resumed 是这次 resume 的（值是接着的那个子任务）
 */
export function interruptedBlock(mine: TaskStep[], fresh: number, resumed: Map<unknown, TaskStep>) {
  const reused = new Set([...resumed.values()].map((s) => s.id))
  const hanging = mine.filter((s) => s.status === 'pending' && s.interrupted && !reused.has(s.id))
  if (!fresh || !hanging.length) return ''
  const list = hanging.map((s) => `${s.id}｜${s.title}`).join('、')
  return `这些子任务中断了还没做完：${list}。要接着做就在 spawn_agents 里带 resume: <id>，在原来的会话里接着跑，不要另派新的；确实不需要了先用 stop_subtask 终止它们，再派新的。`
}

/**
 * stop_subtask 终止一个被打断、还没重新开始的子任务：它没有在跑的进程可停，直接记成已终止。
 * 不收掉的话它一直挂着「已打断」，也挡着另派新的子任务。返回有没有收掉
 */
export function dropInterrupted(s: TaskStep, why: string) {
  if (s.status !== 'pending' || !s.interrupted) return false
  s.status = 'skipped'
  s.interrupted = false
  s.endedAt = new Date().toISOString()
  if (!s.output) s.output = why
  return true
}
