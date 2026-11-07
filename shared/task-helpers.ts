/**
 * 子任务（spawn_agents 派出的步骤）的运行状态和排序：运行区、子任务列表、计数和侧栏都读这里，
 * 判定只写这一处，不在界面上各拼一套。shared/task.ts 从这里转出，调用方仍从 @shared/task 引用。
 */
import type { Task, TaskStep } from './schema.ts'

/** 按开始时间倒序：越晚开始的越靠上。旧记录没有开始时间时算最早，交给调用方用 id 兜底 */
export function byStartedDesc(a: { startedAt?: string }, b: { startedAt?: string }) {
  return (b.startedAt || '').localeCompare(a.startedAt || '')
}

/**
 * 列表里「新的在前」：按开始时间倒序，越晚开始的越靠上；时间一样、或者旧记录 / 演示数据没有开始时间时，
 * 用 id 的序号兜底（`@chat/sub/h10` 比 `h2` 新），保证每次渲染顺序一致不抖动。
 * 兜底依赖编号随派出递增（engine 的 spawn 用「现存子任务数 + 1」，见 shared/engine.ts 的 n = have + i + 1），
 * 而删除都是整批的（dropRerun 删父亲下全部 sub、dropNodeSteps 删整棵子树），不会出现「删了 h1、留着 h3」
 * 再派回一个重复编号，所以这个方向成立。
 * 子任务列表（sortHelpers）和运行区的子任务行用它；子对话栏（sortChildren）的时间倒序也走 byStartedDesc，
 * 只是它同一时间按 id 升序兜底（改它会动到子对话列表的既有顺序），别再各处写一遍时间倒序。
 */
export function newestFirst(a: { id: string; startedAt?: string }, b: { id: string; startedAt?: string }) {
  return byStartedDesc(a, b) || b.id.localeCompare(a.id, undefined, { numeric: true })
}

/**
 * 子任务这会儿在跑：输入框上方的计数、弹层「执行中」分组、子对话的「等子任务」都读它。
 * 以前这几处各写一份 `slot === 'sub' && status === 'running'`，口径一变就会有的是 2、有的是 3。
 */
export function helperRunning(s: Pick<TaskStep, 'status' | 'slot'>) {
  return s.slot === 'sub' && s.status === 'running'
}

/**
 * 子任务在列表里的档位：正在跑的、排队的、没做完的、做完的、终止的。
 * 组与组的顺序由它决定（分组见 HelperCards 的 helperGroups），组内再按 newestFirst 让最新的排在前面。
 */
export function helperRank(s: Pick<TaskStep, 'status' | 'slot'>) {
  return helperRunning(s) ? 0 : s.status === 'pending' ? 1 : s.status === 'failed' ? 2 : s.status === 'done' ? 3 : 4
}

/**
 * 子任务列表的顺序：先按档位分（执行中 → 排队中 → 未完成 → 已完成 → 已终止），
 * 同一档里最新的在最上面（见 newestFirst）：用户最后派出的那个就在最上面，不用往下翻。
 * 输入框上方的「子任务」列表和消息流里运行区的子任务行都读这一个函数，别各处再写一份排序。
 */
export function sortHelpers<T extends Pick<TaskStep, 'id' | 'status' | 'slot' | 'startedAt'>>(list: T[]): T[] {
  return list.slice().sort((a, b) => helperRank(a) - helperRank(b) || newestFirst(a, b))
}

/**
 * 子任务还没结束（在跑或在排队）：对话页运行区按这个列子任务行、终止按钮也只在这时出现。
 * 和子对话的 convActive 一个意思——没做完就算在运行，不因为没选中、在后台就不列
 */
export function helperActive(s: Pick<TaskStep, 'status' | 'slot'>) {
  return s.slot === 'sub' && (s.status === 'running' || s.status === 'pending')
}

/**
 * 运行区要不要列这个子任务：在跑的列；还没开始的（排队等启动、被打断后等重新开始，都是 pending）
 * 只在对话在执行时才会开始，对话停着时不算在跑、不列
 * （以前停了父对话，子对话名下被打断的子任务还一排在运行区转圈，用户报过）
 */
export function helperShown(task: Pick<Task, 'status'>, s: Pick<TaskStep, 'status' | 'slot'>) {
  return helperRunning(s) || (helperActive(s) && task.status === 'running')
}

/**
 * 对话派出的子任务（spawn_agents 的步骤）还在跑：CLI 这一轮已经回复完（working 已是 false），
 * 但对话停在那里等它们交回结果，在侧栏和项目首页里也算「还在跑」
 */
export function helpersWorking(t: Pick<Task, 'status' | 'steps'>) {
  return t.status === 'running' && t.steps.some(helperRunning)
}

/** 子对话的摘要兜底：还没生成 summary 时取最近一条 Agent 回复的开头（正式后端和演示版共用，免得两边各写一份） */
export function lastReplyText(task: Pick<Task, 'messages'>) {
  const last = [...task.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())
  return last ? last.text.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
}
