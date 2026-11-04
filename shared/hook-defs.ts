import { z } from 'zod'
import { t } from './i18n.ts'

/**
 * 钩子的规范（ADR 0049 第二期，设计稿 docs/openspec/changes/agent-hooks 第 6 节）：设置页「钩子」里用户建的、
 * AI 创建的钩子都按这里校验；内置钩子的开关也存在同一份数据里。和 CLI 无关：面板给钩子的输入、钩子回的输出
 * 都是面板自己的统一格式，一个钩子对所有支持这个事件的 CLI 都能用。
 *
 * 硬规则：输入里没有模型回复的文字，钩子也就没法按文字判断状态（AGENTS.md）。
 */

/**
 * 面板事件。前四个是 CLI 的钩子，能影响这一轮：turn.beforeEnd 模型准备结束这一轮；tool.before / tool.after 工具执行前后；
 * context.restored 压缩上下文、续接之后。后面几个（第三期）由面板自己发，只通知、不能改变什么：
 * task.done 对话完成一轮、task.failed 对话失败、task.waitingUser 等你回复或确认、task.wrapRequested 子对话请求收尾、
 * plan.stepDone 计划的某一步做完、schedule.finished 计划任务跑到终态（原来的「计划 Webhook」）
 */
export const HookEventName = z.enum([
  'turn.beforeEnd',
  'tool.before',
  'tool.after',
  'context.restored',
  'task.done',
  'task.failed',
  'task.waitingUser',
  'task.wrapRequested',
  'plan.stepDone',
  'schedule.finished',
])
export type HookEventName = z.infer<typeof HookEventName>

/** 只通知的面板事件：由面板自己发，钩子的输出不看，CLI 也不用支持 */
export const NOTIFY_EVENTS: readonly HookEventName[] = [
  'task.done',
  'task.failed',
  'task.waitingUser',
  'task.wrapRequested',
  'plan.stepDone',
  'schedule.finished',
]
export const isNotifyEvent = (e: HookEventName) => NOTIFY_EVENTS.includes(e)

/** 工具的类别：各家工具名在 CLI 定义的 hooks.toolNames 里对照到这几类，用户钩子按类别匹配才能跨 CLI 通用 */
export const ToolKind = z.enum(['shell', 'edit', 'read', 'any'])
export type ToolKind = z.infer<typeof ToolKind>

const SCRIPT_MAX = 20000

export const HookDef = z.object({
  /** 面板生成；新建时为空 */
  id: z.string().max(40).default(''),
  name: z.string().trim().min(1, t('名称不能为空')).max(60),
  description: z.string().trim().max(300).default(''),
  event: HookEventName,
  /** 只在这些项目 / 角色 / CLI 里触发；都空表示全部 */
  scope: z
    .object({
      projects: z.array(z.string()).max(50).default([]),
      agents: z.array(z.string()).max(50).default([]),
      clis: z.array(z.string()).max(10).default([]),
    })
    .default({ projects: [], agents: [], clis: [] }),
  /** 只对 tool.* 有意义：工具类别、路径通配（相对项目根）、命令前缀（shell） */
  match: z
    .object({
      tool: ToolKind.default('any'),
      path: z.string().trim().max(200).default(''),
      command: z.string().trim().max(200).default(''),
    })
    .default({ tool: 'any', path: '', command: '' }),
  action: z.discriminatedUnion('type', [
    /** 运行一段 Node 脚本：stdin 进统一格式的 JSON，stdout 出统一格式的 JSON 或空 */
    z.object({ type: z.literal('command'), script: z.string().min(1, t('脚本不能为空')).max(SCRIPT_MAX) }),
    /** POST 同样的 JSON 到一个地址；请求头的值只能引用环境变量，不能直接写密钥 */
    z.object({
      type: z.literal('http'),
      url: z.string().trim().url(t('地址不对')),
      headers: z
        .array(z.object({ key: z.string().trim().min(1).max(60), env: z.string().trim().min(1).max(60) }))
        .max(10)
        .default([]),
    }),
  ]),
  timeoutSec: z.number().int().min(1).max(60).default(5),
  /** 钩子出错、超时、返回格式不对时：放行（默认），或者拒绝（只对 tool.before 有意义） */
  onError: z.enum(['allow', 'deny']).default('allow'),
  /** 新建的、AI 生成的都默认关着，用户看过再打开 */
  enabled: z.boolean().default(false),
  createdBy: z.enum(['user', 'ai']).default('user'),
  updatedAt: z.string().default(''),
})
export type HookDef = z.infer<typeof HookDef>
export type HookDefInput = z.input<typeof HookDef>

/** 面板自带的钩子：可以开关、看说明，不能删、不能改逻辑 */
export interface BuiltinHook {
  id: string
  event: HookEventName
  name: () => string
  description: () => string
  defaultOn: boolean
}

export const BUILTIN_HOOKS: BuiltinHook[] = [
  {
    id: 'keep-going',
    event: 'turn.beforeEnd',
    name: () => t('没做完不收尾'),
    description: () =>
      t(
        '计划没做完、子对话请求收尾还没处理、没列计划却做了一半就要结束时，在同一轮里拦住让它接着做（Chat 页一问一答不拦）',
      ),
    defaultOn: true,
  },
  {
    id: 'restore-plan',
    event: 'context.restored',
    name: () => t('压缩后补回计划'),
    description: () => t('压缩上下文之后，把当前计划和进度、派单的目标、在等什么补给模型，免得它忘了做到哪'),
    defaultOn: true,
  },
  {
    id: 'read-only-guard',
    event: 'tool.before',
    name: () => t('只读身份守卫'),
    description: () => t('调研、评审、排查分析这类只读的角色，以及只统筹不动手的父对话，要改文件时直接拒绝并说明原因'),
    defaultOn: true,
  },
  {
    id: 'temp-file-guard',
    event: 'tool.before',
    name: () => t('临时文件位置守卫'),
    description: () => t('往盘符根目录、面板的数据目录里写文件时拒绝，说明临时文件该放到项目的 .tmp/ 或系统临时目录'),
    defaultOn: false,
  },
  {
    id: 'push-lessons',
    event: 'tool.after',
    name: () => t('改文件后推送教训'),
    description: () => t('第一次改到某个文件时，把项目教训里管这个文件的几条补给模型'),
    defaultOn: false,
  },
]

/** 数据目录里 hooks.json 的形状：内置钩子的开关（只记改过默认值的）和用户的钩子 */
export const HooksData = z.object({
  builtins: z.record(z.string(), z.boolean()).default({}),
  hooks: z.array(HookDef).default([]),
  /** 做过的一次性迁移：webhook 是设置里原来的「计划 Webhook」迁成钩子 */
  migrated: z.object({ webhook: z.boolean().default(false) }).default({ webhook: false }),
})
export type HooksData = z.infer<typeof HooksData>

export const builtinOn = (data: Pick<HooksData, 'builtins'>, h: BuiltinHook) => data.builtins[h.id] ?? h.defaultOn

/** 交给用户钩子的输入（统一格式，与 CLI 无关；不含模型回复的文字，也不含凭据） */
export interface HookInput {
  event: HookEventName
  task: { id: string; title: string; parent: boolean }
  project: { id: string; path: string }
  agent: { id: string; name: string }
  cli: string
  tool?: { kind: ToolKind; name: string; input: Record<string, unknown> }
  plan?: { done: number; total: number; current: string }
  /** 只通知的对话事件（task.* / plan.stepDone）：对话现在的状态，做完的那一步（plan.stepDone）或收尾说明（task.wrapRequested） */
  notice?: { status: string; step: string }
  /**
   * schedule.finished：计划这一轮的结果。result 是 run 成功启动 / fail 启动失败 / miss 错过 / blocked 上游没成功，
   * 字段和原来的计划 Webhook 载荷一样（见 server/webhook.ts）
   */
  schedule?: Record<string, string>
}

/** 钩子的输出：block 只对 turn.beforeEnd，deny 只对 tool.before，context 对其余三种 */
export interface HookOutput {
  block?: boolean
  deny?: boolean
  reason?: string
  context?: string
}

/** 按事件检查输出：多出事件不支持的字段算格式错，返回错误说明；空对象（不表态）合法 */
export function checkOutput(event: HookEventName, raw: unknown): { out: HookOutput } | { error: string } {
  // 只通知的事件不看输出：HTTP 钩子收到的多半是对方服务的回执，不当成格式错
  if (raw === undefined || raw === null || raw === '' || isNotifyEvent(event)) return { out: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: t('输出要是一个 JSON 对象') }
  const o = raw as Record<string, unknown>
  const allowed: Partial<Record<HookEventName, string[]>> = {
    'turn.beforeEnd': ['block', 'reason'],
    'tool.before': ['deny', 'reason', 'context'],
    'tool.after': ['context'],
    'context.restored': ['context'],
  }
  const extra = Object.keys(o).filter((k) => !(allowed[event] ?? []).includes(k))
  if (extra.length) return { error: t('{event} 不支持这些字段：{list}', { event, list: extra.join('、') }) }
  for (const k of ['reason', 'context'] as const)
    if (o[k] !== undefined && typeof o[k] !== 'string') return { error: t('{key} 要是字符串', { key: k }) }
  if ((o.block === true || o.deny === true) && !String(o.reason ?? '').trim())
    return { error: t('拦住或拒绝时要写 reason，告诉模型为什么') }
  return {
    out: {
      ...(o.block === true ? { block: true } : {}),
      ...(o.deny === true ? { deny: true } : {}),
      ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
      ...(typeof o.context === 'string' ? { context: o.context } : {}),
    },
  }
}

/** 简单的路径通配：** 跨目录，* 不跨目录，? 一个字符 */
export function globMatch(glob: string, file: string): boolean {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      re += '.*'
      i++
      if (g[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(f)
}

/** 用户钩子在这次触发里管不管：范围、工具类别、路径、命令前缀都对上才跑 */
export function hookApplies(h: HookDef, input: HookInput, rel = ''): boolean {
  if (!h.enabled || h.event !== input.event) return false
  const s = h.scope
  if (s.projects.length && !s.projects.includes(input.project.id)) return false
  if (s.agents.length && !s.agents.includes(input.agent.id)) return false
  if (s.clis.length && !s.clis.includes(input.cli)) return false
  if (!input.event.startsWith('tool.')) return true
  const tool = input.tool
  if (!tool) return false
  if (h.match.tool !== 'any' && h.match.tool !== tool.kind) return false
  if (h.match.path && !(rel && globMatch(h.match.path, rel))) return false
  if (
    h.match.command &&
    !String(tool.input.command ?? '')
      .trim()
      .startsWith(h.match.command)
  )
    return false
  return true
}
