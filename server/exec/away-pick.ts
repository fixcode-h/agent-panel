/**
 * 「我不在」开着时，CLI 提的问题能不能当场按 Agent 的推荐选掉（判定在 shared/away.ts，只看问题上的字段）。
 * 选了就在对话里留一行（问题和选了什么照回答的样子显示）、记进总览的「自动选过的」，再把答案交回 CLI；
 * 拿不准的返回 false，照旧挂成提问等用户。
 */
import type { AskQuestion, Task } from '../../shared/schema.ts'
import { awayAnswers, awayNote } from '../../shared/away.ts'
import { resumeRun } from '../../shared/task.ts'
import { awayOn, recordAwayPick } from '../away.ts'
import { replies } from './panel-requests.ts'
import type { AskReply, CliEvent } from './parsers.ts'

type AskEvent = Extract<CliEvent, { type: 'ask' }>
type Meta = { id: string; step: string; agentId: string }

/** 对话里留一行、记进总览，返回交回 CLI 的答案 */
function note(task: Task, meta: Meta, questions: AskQuestion[], answers: string[]): AskReply {
  const at = new Date().toISOString()
  const items = questions.map((q, i) => ({ question: q.question, picked: answers[i] }))
  task.messages.push({
    id: meta.id,
    role: 'system',
    agentId: meta.agentId,
    step: meta.step,
    text: awayNote(answers),
    tools: [],
    at,
    answers: items.map((x) => ({ question: x.question, answer: x.picked })),
  })
  recordAwayPick({ id: meta.id, taskId: task.id, projectId: task.projectId, taskTitle: task.title, items, at })
  return { allow: true, answer: answers[0], answers }
}

/** CLI 刚提的问题：能替用户选就选掉并返回 true */
export function awayPicked(task: Task, ev: AskEvent, meta: Meta): boolean {
  if (!awayOn()) return false
  const answers = awayAnswers({ kind: ev.kind, questions: ev.questions })
  if (!answers || !ev.questions) return false
  ev.reply(note(task, meta, ev.questions, answers))
  return true
}

/**
 * 刚打开「我不在」：这个对话里已经挂着的提问，能选的一起选掉（用户正是要走了才开的）。
 * 返回选掉了几个；CLI 那头已经不等了的（找不到回调）不动，照旧留给用户
 */
export function awayPickPending(task: Task): number {
  let n = 0
  for (const req of task.requests) {
    const answers = awayAnswers(req)
    const fn = replies.get(req.id)
    if (!answers || !req.questions || !fn) continue
    replies.delete(req.id)
    task.requests = task.requests.filter((x) => x.id !== req.id)
    fn(note(task, req, req.questions, answers))
    n++
  }
  if (n && !task.requests.length) resumeRun(task)
  return n
}
