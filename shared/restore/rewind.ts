/**
 * 撤回到某条消息、从某条消息分叉：对话本身怎么截、新对话带哪些字段。
 * 正式后端（server/tasks/actions-routes.ts）和演示后端都调这一份（重构文档第 10 条）；
 * 撤回时连文件一起撤、停掉之后开的子对话、分叉时开独立分支这些要碰磁盘和进程的，各自在后端做
 */
import { t } from '../i18n.ts'
import { NO_PUSH_ANSWER, pushAnswerCut } from '../push-auth.ts'
import type { Task } from '../schema.ts'

/** 用户亲手发的那条消息在第几条（工作流节点里的不算）；找不到返回 -1 */
export const userMessageIndex = (task: Pick<Task, 'messages'>, messageId: string | undefined) =>
  task.messages.findIndex((m) => m.id === messageId && m.role === 'user' && !m.step)

/** 第 i 条用户消息之前（不含）最近一条用户消息的那一轮，没有时为 null；latest：那一轮是会话的最后一轮 */
export function turnBefore(task: Pick<Task, 'messages'>, i: number) {
  const prev = [...task.messages.slice(0, i)].reverse().find((m) => m.role === 'user' && !m.step)
  if (!prev?.turn) return { through: null, session: '', latest: false }
  const th = prev.turn
  const at = task.messages.indexOf(prev)
  const latest = !task.messages.slice(at + 1).some((m) => m.turn?.session === th.session)
  return { through: th, session: th.session, latest }
}

/**
 * 撤回到第 i 条（用户消息）之后的对话：这条和之后的都去掉，下一轮从它之前接着聊。
 * 被撤掉那几轮里建的计划作废；推送授权是在被撤掉的那段对话里点的也跟着撤掉，下一轮需要推送时重新问
 */
export function rewoundTask(task: Task, i: number): Task {
  const removed = task.messages[i]
  return {
    ...task,
    messages: task.messages.slice(0, i),
    // 第一条也能撤：前面没有用户消息时 turnBefore 一轮都不留（through 为空），下一轮开新会话
    rewind: { ...turnBefore(task, i), cut: removed.turn ?? null },
    status: 'done',
    todos: [],
    plans: task.plans.filter((p) => p.createdAt < removed.at),
    ...(pushAnswerCut(task, removed.at) ? NO_PUSH_ANSWER : {}),
  }
}

/**
 * 从第 i 条（用户消息）分叉出的新对话：带着到这条消息为止的对话（含它的回复），原对话不动。
 * 不含 id、时间和独立分支：后端各自给（正式后端按项目设置开分支，演示没有）
 */
export function forkedTask(task: Task, i: number, newId: () => string) {
  // 留到下一条用户消息之前：这条消息和它的回复都带上
  const next = task.messages.findIndex((m, k) => k > i && m.role === 'user' && !m.step)
  const kept = task.messages.slice(0, next < 0 ? task.messages.length : next)
  const { through, session, latest } = turnBefore(task, next < 0 ? task.messages.length : next)
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = task
  const agents = Object.fromEntries(
    Object.entries(task.usage.agents).map(([k, v]) => [k, { ...v, tps: 0, lastTps: 0, outputTokens: 0, genMs: 0 }]),
  )
  return {
    ...rest,
    title: t('{title}（分叉）', { title: task.title }).slice(0, 80),
    autoTitle: false,
    // 消息 id 换新的，免得两个任务里的消息 id 相同
    messages: kept.map((m) => ({ ...m, id: newId() })),
    // 下一条用户消息那一轮是丢掉的第一轮：只能分叉到某一轮之前的 CLI 按它截
    rewind: { through, session, latest, cut: next < 0 ? null : (task.messages[next].turn ?? null) },
    status: 'done' as const,
    runMs: 0,
    runStartedAt: '',
    requests: [],
    todos: [],
    archived: undefined,
    // 推送授权只对点它的那个对话有效：分叉出来的是新对话，需要推送时重新问一次
    ...NO_PUSH_ANSWER,
    usage: { agents, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  }
}
