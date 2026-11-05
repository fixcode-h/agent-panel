/**
 * CLI 的确认请求进对话之前：命中这个对话记下的放行规则就直接允许（审批卡上点过「一直允许」，见 shared/allow-rules.ts），
 * 否则整理成审批卡要的请求。从 runner.ts 拆出（runner.ts 到了行数上限）
 */
import type { Task, TaskRequest } from '../../shared/schema.ts'
import { ruleAllowed, ruleText } from '../../shared/allow-rules.ts'
import { t } from '../../shared/i18n.ts'
import type { CliEvent } from './parsers.ts'

type AskEvent = Extract<CliEvent, { type: 'ask' }>

/**
 * 命中放行规则：直接允许，对话里留一行说明（自动允许的也要看得见，不悄悄放过）。返回 true 表示已经处理
 */
export function autoAllowed(task: Task, ev: AskEvent, meta: { id: string; step: string; agentId: string }): boolean {
  if (ev.kind === 'question' || !ruleAllowed(task.allowRules ?? [], ev.rule)) return false
  task.messages.push({
    id: meta.id,
    role: 'system',
    agentId: meta.agentId,
    step: meta.step,
    text: t('按这个对话的放行规则自动允许（{rule}）：{title}', { rule: ruleText(ev.rule!), title: ev.title }),
    tools: [],
    at: new Date().toISOString(),
  })
  ev.reply({ allow: true })
  return true
}

/** 审批卡要的请求 */
export function requestOf(ev: AskEvent, meta: { id: string; step: string; agentId: string }): TaskRequest {
  return {
    ...meta,
    kind: ev.kind,
    title: ev.title,
    detail: ev.detail,
    options: ev.options ?? [],
    ...(ev.questions ? { questions: ev.questions } : {}),
    ...(ev.diff ? { diff: ev.diff } : {}),
    ...(ev.rule ? { rule: ev.rule } : {}),
    at: new Date().toISOString(),
  }
}
