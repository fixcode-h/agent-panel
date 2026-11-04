import {
  HookDef,
  type HookDefInput,
  type HookEventName,
  type HookInput,
  isNotifyEvent,
} from '../../shared/hook-defs.ts'
import { CLIS } from '../../shared/clis.ts'
import { supportedEvents } from '../../shared/hooks.ts'
import { t } from '../../shared/i18n.ts'
import { checkSyntax, runHook } from './run.ts'

/**
 * 保存前的校验（设计稿第 6.3 节）：设置页手动保存、AI 创建的提案都走这里，errors 不为空就不能保存。
 * warnings 不挡保存，只提醒（例如范围里有的 CLI 不支持这个事件）
 */
export interface HookCheck {
  def?: HookDef
  errors: string[]
  warnings: string[]
}

/** 疑似真实密钥：和仓库的 secret-check 同一类前缀（脚本里要用凭据就引用环境变量） */
export const SECRET_RES = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bhf_[A-Za-z0-9]{20,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/i,
]

/** 试跑用的示例输入：和真实触发同一个形状 */
export function sampleInput(event: HookEventName): HookInput {
  return {
    event,
    task: { id: 'sample', title: '示例对话', parent: true },
    project: { id: 'sample', path: process.cwd() },
    agent: { id: 'sample', name: '执行' },
    cli: 'claude',
    ...(event.startsWith('tool.')
      ? {
          tool: {
            kind: 'edit' as const,
            name: 'Edit',
            input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          },
        }
      : {}),
    plan: { done: 1, total: 3, current: '改代码' },
    // 只通知的面板事件带的是对话状态、计划任务的结果（ADR 0049 第三期）
    ...(isNotifyEvent(event) ? { notice: { status: 'running', step: '改代码' } } : {}),
    ...(event === 'schedule.finished'
      ? {
          schedule: {
            result: 'run',
            scheduleId: 'sample',
            name: '每日构建',
            projectName: '示例项目',
            at: new Date().toISOString(),
            taskId: 'sample',
            error: '',
          },
        }
      : {}),
  }
}

export async function checkHook(input: HookDefInput, opts: { run?: boolean } = {}): Promise<HookCheck> {
  const parsed = HookDef.safeParse({ ...input, id: input.id || 'check' })
  if (!parsed.success)
    return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || t('钩子')}：${i.message}`), warnings: [] }
  const def = parsed.data
  const errors: string[] = []
  const warnings: string[] = []
  const tool = def.event.startsWith('tool.')
  if (!tool && (def.match.tool !== 'any' || def.match.path || def.match.command))
    errors.push(t('只有工具前、工具后的钩子能按工具、路径、命令匹配'))
  if (def.onError === 'deny' && def.event !== 'tool.before')
    warnings.push(t('出错时拒绝只对工具前的钩子有效，其余事件出错都放行'))
  const text = def.action.type === 'command' ? def.action.script : def.action.url
  if (SECRET_RES.some((re) => re.test(text))) errors.push(t('里面像是写了真实的密钥：要用凭据就从环境变量读'))
  if (def.action.type === 'command') {
    const syntax = await checkSyntax(def.action.script)
    if (syntax) errors.push(t('脚本有语法错误：{error}', { error: syntax.slice(0, 500) }))
  }
  const clis = def.scope.clis.length ? CLIS.filter((c) => def.scope.clis.includes(c.id)) : CLIS
  const no = clis.filter((c) => !supportedEvents(c.hooks).includes(def.event)).map((c) => c.name)
  if (no.length) warnings.push(t('这些 CLI 不支持这个事件，在它们的对话里不会触发：{list}', { list: no.join('、') }))
  if (!errors.length && opts.run) {
    const r = await runHook(
      def,
      sampleInput(def.event),
      process.cwd(),
      def.action.type === 'command' ? def.action.script : undefined,
    )
    if (r.error) errors.push(t('试跑没通过：{error}', { error: r.error }))
  }
  return { def, errors, warnings }
}
