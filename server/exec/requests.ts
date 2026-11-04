/** CLI 提的问题和授权请求：自动作答、作废、回答后交回 CLI。从 runner.ts 拆出 */
import { AUTO_ANSWER } from '../asks.ts'
import type { AskReply } from './parsers.ts'
import type { Task } from '../../shared/schema.ts'
import { denyAdvice } from './deny-advice.ts'
import { noteAnswer, replies } from './panel-requests.ts'
import { questionAnswers, resumeRun } from '../../shared/task.ts'
import { t } from '../../shared/i18n.ts'
import { ruleText } from '../../shared/allow-rules.ts'

const stepTitle = (task: Task, id: string) => task.steps.find((s) => s.id === id)?.title ?? ''

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
  task.requests = task.requests.filter((x) => x.id !== id)
  const deny = denyAdvice(task, req, r)
  const what =
    req.kind === 'confirm'
      ? r.allow
        ? t('你确认了「{title}」的结果，接着往下执行', { title: stepTitle(task, req.step) })
        : t('你退回了「{title}」：{answer}', { title: stepTitle(task, req.step), answer: r.answer ?? '' })
      : req.kind === 'question'
        ? req.questions && req.questions.length > 1 && r.answers?.length
          ? t('你回答了：{answers}', {
              answers: req.questions.map((q, i) => `${q.question} → ${r.answers?.[i] ?? ''}`).join('；'),
            })
          : !r.allow
            ? t('你没有回答「{title}」', { title: req.title })
            : t('你回答了「{title}」：{answer}', { title: req.title, answer: r.answers?.[0] ?? r.answer ?? '' })
        : r.allow
          ? r.always && req.rule
            ? t('你允许了：{title}，这个对话里之后的{rule}都自动允许', { title: req.title, rule: ruleText(req.rule) })
            : t('你允许了：{title}', { title: req.title })
          : (deny.what ?? t('你拒绝了：{title}', { title: req.title }))
  // 回答了问题：问题和答案在对话正文里显示，不再是一行灰色的说明
  const answers = req.kind === 'question' ? questionAnswers(req, r) : undefined
  // 请求处理完就继续执行：等待结算进 waitMs，从这一刻重新算执行时间
  if (!task.requests.length) resumeRun(task)
  noteAnswer(task, req, r)
  // 「一直允许这类」：记下规则，这个对话里之后的同类请求自动允许（server/exec/ask-request.ts）
  if (r.allow && r.always && req.rule && !task.allowRules.includes(req.rule))
    task.allowRules = [...task.allowRules, req.rule]
  task.messages.push({
    id: newId(),
    role: 'system',
    agentId: req.agentId,
    step: req.step,
    text: what,
    tools: [],
    at: new Date().toISOString(),
    ...(answers ? { answers } : {}),
  })
  fn(deny.reply)
  return true
}
