/** CLI 提的问题和授权请求：自动作答、作废、回答后交回 CLI。从 runner.ts 拆出 */
import { AUTO_ANSWER } from '../asks.ts'
import type { AskReply } from './parsers.ts'
import type { Task } from '../../shared/schema.ts'
import { denyAdvice } from './deny-advice.ts'
import { noteAnswer, replies } from './panel-requests.ts'
import { applyAnswer } from '../../shared/requests/answer.ts'

/** 「提问」开关关掉了：还在等回答的问题让 CLI 自己选 */
export function autoAnswerQuestions(task: Task) {
  for (const req of task.requests.filter((x) => x.kind === 'question')) {
    const fn = replies.get(req.id)
    if (!fn) continue
    replies.delete(req.id)
    task.requests = task.requests.filter((x) => x.id !== req.id)
    fn(AUTO_ANSWER)
  }
}

/**
 * 用户停止对话（提问窗口的关闭就是不回答、终止对话）：还在等回答的请求马上作废，页面上的提问立刻收起。
 * 不能等这一轮的进程结束再清：保活的 CLI 卡在等回答时这一轮不会结束，提问就一直关不掉。
 * 工作流节点的确认不在这里处理：它跟着停止信号自己收掉，继续执行时重新确认
 */
export function dropRequests(task: Task) {
  const drop = task.requests.filter((x) => x.kind !== 'confirm')
  if (!drop.length) return false
  task.requests = task.requests.filter((x) => x.kind === 'confirm')
  for (const req of drop) {
    const fn = replies.get(req.id)
    replies.delete(req.id)
    fn?.({ allow: false, message: '用户不回答这个问题，终止了对话：先不要继续，等用户的下一条消息。' })
  }
  return true
}

/** 用户在任务页上回答了请求；找不到（已经结束、已回答过）时返回 false */
export function answerRequest(task: Task, id: string, r: AskReply, newId: () => string) {
  const fn = replies.get(id)
  const req = task.requests.find((x) => x.id === id)
  if (!fn || !req) return false
  replies.delete(id)
  const deny = denyAdvice(task, req, r)
  // 对话上怎么记、等待怎么结算：和演示后端同一份（shared/requests/answer.ts）
  applyAnswer(task, req, r, { newId, denied: deny.what })
  noteAnswer(task, req, r)
  fn(deny.reply)
  return true
}
