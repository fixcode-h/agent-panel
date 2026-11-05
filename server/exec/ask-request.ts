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
 * 命中放行规则、或者权限选的是「跳过所有确认」这类不确认的一档（skipAll，CLI 定义里标了 autoAllow）：
 * 直接允许，对话里留一行说明（自动允许的也要看得见，不悄悄放过）。返回 true 表示已经处理。
 * 跳过确认时 CLI 仍会为自带的安全检查发确认（Claude Code 删除工作目录、Windows 路径），用户选了不确认就不该再弹；
 * 真正不可挽回的命令由面板的危险命令守卫在执行前拦下（server/hooks/guards.ts），不靠这张卡
 */
export function autoAllowed(
  task: Task,
  ev: AskEvent,
  meta: { id: string; step: string; agentId: string },
  /** 不确认的那一档权限的名字（CLI 定义里 autoAllow 的权限）；不是这一档时为空 */
  skipAll = '',
): boolean {
  if (ev.kind === 'question') return false
  const byRule = ruleAllowed(task.allowRules ?? [], ev.rule)
  if (!byRule && !skipAll) return false
  task.messages.push({
    id: meta.id,
    role: 'system',
    agentId: meta.agentId,
    step: meta.step,
    text: byRule
      ? t('按这个对话的放行规则自动允许（{rule}）：{title}', { rule: ruleText(ev.rule!), title: ev.title })
      : t('权限是「{mode}」，自动允许：{title}', { mode: skipAll, title: ev.title }),
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
