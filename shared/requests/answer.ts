/**
 * 用户在任务页上回答了一个请求（确认、提问、授权）之后对话怎么变：请求收掉、记一行「你确认了 / 你回答了 / 你允许了」、
 * 等待时间结算、「一直允许这类」记成规则。正式后端（server/exec/requests.ts）和演示后端都调这一份（重构文档第 10 条）；
 * 把答案交回还在等的 CLI、连续拒绝的提醒这些只有真进程才有的，在正式后端做
 */
import { requestRuleText } from '../allow-rules.ts'
import { t } from '../i18n.ts'
import type { NoteGrant, Task, TaskRequest } from '../schema.ts'
import { pendingReport, reportChanges, type Picks } from '../flow/stage-report.ts'
import { questionAnswers, resumeRun } from '../task.ts'

/** 用户的回答（server/exec/parsers.ts 的 AskReply 里这里用得到的几项） */
export interface RequestAnswer {
  allow: boolean
  answer?: string
  answers?: string[]
  always?: boolean
  ask?: boolean
  picks?: Picks
}

const stepTitle = (task: Pick<Task, 'steps'>, id: string) => task.steps.find((s) => s.id === id)?.title ?? ''

/** 对话里记的那一行；denied：连续拒绝时正式后端换成的说法（见 server/exec/deny-advice.ts） */
export function answerText(task: Pick<Task, 'steps'>, req: TaskRequest, r: RequestAnswer, denied?: string) {
  // 改了阶段报告里的决策：写清改了哪几项，Agent 会按你的选择重出一版（shared/flow/stage-report.ts）
  const rep = req.kind === 'confirm' && r.allow ? pendingReport(req.reports) : undefined
  const changed = rep ? reportChanges(rep.report, r.picks) : []
  if (changed.length)
    return t('你确认了「{title}」，改了 {n} 项决策：{list}。交给 Agent 按你的选择重出一版', {
      title: stepTitle(task, req.step),
      n: changed.length,
      list: changed.map((c) => `${c.id} ${c.from} → ${c.to}`).join('；'),
    })
  if (req.kind === 'confirm')
    return r.allow
      ? t('你确认了「{title}」的结果，接着往下执行', { title: stepTitle(task, req.step) })
      : r.ask
        ? t('你追问了「{title}」：{answer}', { title: stepTitle(task, req.step), answer: r.answer ?? '' })
        : t('你退回了「{title}」：{answer}', { title: stepTitle(task, req.step), answer: r.answer ?? '' })
  if (req.kind === 'question')
    return req.questions && req.questions.length > 1 && r.answers?.length
      ? t('你回答了：{answers}', {
          answers: req.questions.map((q, i) => `${q.question} → ${r.answers?.[i] ?? ''}`).join('；'),
        })
      : !r.allow
        ? t('你没有回答「{title}」', { title: req.title })
        : t('你回答了「{title}」：{answer}', { title: req.title, answer: r.answers?.[0] ?? r.answer ?? '' })
  // 自建工具的保存弹窗（ADR 0082）：保存了由服务端另记一行存在哪；这里只记取消和「让 Agent 再改」
  if (req.purpose === 'custom-tool')
    return r.allow
      ? t('你确认了：{title}', { title: req.title })
      : r.answer?.trim()
        ? t('你让 Agent 再改：{answer}', { answer: r.answer.trim() })
        : t('你取消了：{title}', { title: req.title })
  if (!r.allow) return denied ?? t('你拒绝了：{title}', { title: req.title })
  return r.always && req.rule
    ? t('你允许了：{title}，这个对话里之后的{rule}都自动允许', { title: req.title, rule: requestRuleText(req) })
    : t('你允许了：{title}', { title: req.title })
}

/**
 * 授权卡（允许 / 拒绝）的回答：对话里画成「你允许了」那一行（web DecisionLine），按结构化字段画、不解析文案。
 * 节点确认、提问、自建工具保存弹窗不算
 */
function decisionGrant(req: TaskRequest, r: RequestAnswer): { grant: NoteGrant } | undefined {
  if (req.kind === 'confirm' || req.kind === 'question' || req.purpose === 'custom-tool') return undefined
  const always = !!(r.allow && r.always && req.rule)
  return {
    grant: {
      via: 'user',
      label: always ? requestRuleText(req) : '',
      title: req.title,
      ...(always ? { rule: req.rule, always: true } : {}),
      ...(r.allow ? {} : { denied: true }),
    },
  }
}

/** 把回答落到对话上（原地改 task）：调用方先确认这个请求还在 */
export function applyAnswer(
  task: Task,
  req: TaskRequest,
  r: RequestAnswer,
  o: { newId: () => string; denied?: string },
) {
  task.requests = task.requests.filter((x) => x.id !== req.id)
  // 回答了问题：问题和答案在对话正文里显示，不再是一行灰色的说明
  const answers = req.kind === 'question' ? questionAnswers(req, r) : undefined
  // 请求处理完就继续执行：等待结算进 waitMs，从这一刻重新算执行时间
  if (!task.requests.length) resumeRun(task)
  // 「一直允许这类」：记下规则，这个对话里之后的同类请求自动允许（server/exec/ask-request.ts）
  if (r.allow && r.always && req.rule && !task.allowRules.includes(req.rule))
    task.allowRules = [...task.allowRules, req.rule]
  task.messages.push({
    id: o.newId(),
    role: 'system',
    agentId: req.agentId,
    step: req.step,
    text: answerText(task, req, r, o.denied),
    tools: [],
    at: new Date().toISOString(),
    ...(answers ? { answers } : {}),
    ...(decisionGrant(req, r) ?? {}),
  })
}
