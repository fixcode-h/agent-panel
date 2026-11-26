/**
 * CLI 的确认请求进对话之前：命中这个对话记下的放行规则就直接允许（审批卡上点过「一直允许」，见 shared/allow-rules.ts），
 * 否则整理成审批卡要的请求。从 runner.ts 拆出（runner.ts 到了行数上限）
 */
import type { Task, TaskRequest } from '../../shared/schema.ts'
import { ruleAllowed, ruleText } from '../../shared/allow-rules.ts'
import { t } from '../../shared/i18n.ts'
import type { CliEvent } from './parsers.ts'
import { awayPicked } from './away-pick.ts'
import { readOnlyCommand } from './redirect.ts'
import { commandNeedle, recordGrant } from '../grants/record.ts'

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
  /** changed：认工具行晚了一步、过一会儿才挂上小标时推送一次 */
  meta: { id: string; step: string; agentId: string; changed?: () => void },
  /** 不确认的那一档权限的名字（CLI 定义里 autoAllow 的权限）；不是这一档时为空 */
  skipAll = '',
): boolean {
  // 提问不按放行规则走；只有「我不在」开着、问题标了能反悔和推荐项时由面板替用户选（away-pick.ts）
  if (ev.kind === 'question') return awayPicked(task, ev, meta)
  const byRule = ruleAllowed(task.allowRules ?? [], ev.rule)
  const safe = byRule ? '' : safeCommand(task, ev)
  if (!byRule && !safe && !skipAll) return false
  const via = byRule ? 'rule' : safe || 'mode'
  const label = byRule ? ruleText(ev.rule!) : via === 'mode' ? skipAll : ''
  // 放行小标挂到这次调用的工具卡片上（server/grants/record.ts）：命令按开头认，改文件、其他工具按标题认
  const needle = commandNeedle(ev.command || ev.title)
  recordGrant(
    { task, newId: () => meta.id, changed: meta.changed ?? (() => {}) },
    {
      id: meta.id,
      agentId: meta.agentId,
      step: meta.step,
      text: byRule
        ? t('按这个对话的放行规则自动允许（{rule}）：{title}', { rule: label, title: ev.title })
        : safe === 'readonly'
          ? t('整条都是只读命令，自动允许：{title}', { title: ev.title })
          : safe === 'test'
            ? t('是这个项目的测试步骤命令，自动允许：{title}', { title: ev.title })
            : t('权限是「{mode}」，自动允许：{title}', { mode: skipAll, title: ev.title }),
      grant: { via, label, title: ev.command || ev.title, ...(byRule ? { rule: ev.rule } : {}) },
      match: { kinds: ev.kind === 'file' ? ['edit'] : ev.kind === 'command' ? ['run', 'search'] : ['other'], needle },
    },
  )
  ev.reply({ allow: true })
  return true
}

/**
 * 不用人点的命令（DeepSeek 实跑：45 分钟弹了 106 次，几乎都是 `ls`、`git status`、`rg … | head` 这类）：
 * - readonly：拆段后每段都是只读命令（redirect.ts 的 readOnlyCommand）；扔掉输出的 `2>/dev/null`、`2>&1` 不算写；
 *   带命令替换、变量、进程替换、`rg --pre` 这类能藏别的命令的不算
 * - test：和项目测试步骤里的某条命令一字不差（用户在项目设置里写的，本来就要跑）
 */
export function safeCommand(
  task: Pick<Task, 'testSteps'>,
  ev: Pick<AskEvent, 'kind' | 'command'>,
): '' | 'readonly' | 'test' {
  const cmd = ev.kind === 'command' ? (ev.command ?? '').trim() : ''
  if (!cmd) return ''
  if ((task.testSteps ?? []).some((s) => s.command.trim() === cmd)) return 'test'
  // 变量和家目录（`$HOME`、`~/.ssh`）多半在读项目外的东西，照常问
  if (/[`$~]|[<>]\(|--pre\b/.test(cmd)) return ''
  const bare = cmd.replace(/\s*(?:\d?>\s*\/dev\/null|\d?>&\d)/g, '')
  return readOnlyCommand(bare) ? 'readonly' : ''
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
