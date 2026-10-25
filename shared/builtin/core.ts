import { AgentInput, type Agent, type AgentParam, type ParamValue, type ParamValues, type Project } from '../schema.ts'
import { coerceValue, isEmptyValue } from '../agent-role.ts'
import { t } from '../i18n.ts'
import { BUILTIN_AGENTS, type BuiltinAgent } from './agents.ts'

/**
 * 必备角色：项目对话离不开的八个能力块。启动时自动装好、不能删除，也不能改成别的角色：
 * 名称、角色设定、Skill、能力开关、参数的定义都由面板维护，每次启动按内置定义同步；
 * 用户能改的只有运行配置（CLI、模型、思考强度、权限、额外参数、开场要求、标签）和参数的取值。
 * 这样「统筹把文档交给文档角色」「执行派测试验收去跑」「收尾前派评审、交付前交版本控制收尾」这类约定才靠得住，
 * 不会因为某个角色被改成别的而断掉。
 */
export const CORE_AGENTS = [
  { key: 'orchestrator' },
  { key: 'worker' },
  { key: 'docsync' },
  { key: 'reviewer' },
  { key: 'tester' },
  { key: 'vcs' },
  { key: 'helper' },
  { key: 'analyzer' },
] as const

export type CoreKey = (typeof CORE_AGENTS)[number]['key']

const KEYS = new Set<string>(CORE_AGENTS.map((c) => c.key))

/** 这个角色是哪个必备角色（按来源认）；不是返回 undefined */
export function coreKey(a: Pick<Agent, 'origin'> | undefined): CoreKey | undefined {
  const k = a?.origin.startsWith('builtin:') ? a.origin.slice(8) : ''
  return KEYS.has(k) ? (k as CoreKey) : undefined
}

/** 界面上说明这个必备角色管什么 */
export function coreUse(key: CoreKey) {
  switch (key) {
    case 'orchestrator':
      return t('项目对话默认使用')
    case 'worker':
      return t('子对话默认使用')
    case 'docsync':
      return t('所有项目文档按规则落盘')
    case 'reviewer':
      return t('改动和结论的独立评审')
    case 'tester':
      return t('构建、测试和验收')
    case 'vcs':
      return t('版本控制、合并与交付收尾')
    case 'helper':
      return t('派出的并行子任务默认使用')
    case 'analyzer':
      return t('所有 AI 分析、AI 排查的对话默认使用')
  }
}

export const isCoreAgent = (a: Pick<Agent, 'origin'> | undefined) => !!coreKey(a)

export const coreDefinition = (key: CoreKey) => BUILTIN_AGENTS.find((b) => b.key === key)!

/** 找本机的某个必备角色 */
export const findCore = <A extends Pick<Agent, 'origin'>>(agents: A[], key: CoreKey) =>
  agents.find((a) => a.origin === `builtin:${key}`)

/** 参数定义按内置的来，只把用户填的默认值（合法的）和「对话前先问」带过去 */
export function keepParamValues(defs: AgentParam[], mine: AgentParam[]): AgentParam[] {
  return defs.map((d) => {
    const m = mine.find((x) => x.key === d.key && x.type === d.type)
    if (!m) return d
    const v = coerceValue(d, m.default)
    return { ...d, default: v === undefined || (isEmptyValue(v) && d.type !== 'text') ? d.default : v, ask: m.ask }
  })
}

/**
 * 必备角色改过默认值的参数。参数的取值就存在角色副本的 default 里，分不清「用户关掉的」和「装的时候旧默认就是关」，
 * 所以每条只在启动时做一次：副本还是旧默认值的改成新默认，再把 id 记进 upgrades；之后用户再关掉就不会被改回来。
 */
const DEFAULT_CHANGES: { id: string; core: CoreKey; key: string; from: ParamValue }[] = [
  // 文档角色的「写 Bug 记录」从默认关改成默认开（89dbf5a 只改了定义，已装的副本还是关的）
  { id: 'docsync.bug-on', core: 'docsync', key: 'bug', from: false },
]

/** 对已装的必备角色补做还没做过的默认值升级（幂等） */
export function upgradeParamDefaults(a: AgentInput, key: CoreKey): AgentInput {
  const todo = DEFAULT_CHANGES.filter((c) => c.core === key && !a.upgrades?.includes(c.id))
  if (!todo.length) return a
  const params = a.params.map((p) => {
    const c = todo.find((x) => x.key === p.key)
    const def = c && coreDefinition(key).agent.params.find((d) => d.key === p.key)
    return c && def && p.default === c.from ? { ...p, default: def.default } : p
  })
  return { ...a, params, upgrades: [...(a.upgrades ?? []), ...todo.map((c) => c.id)] }
}

/**
 * 按内置定义改写一个必备角色：定义部分换成内置的，可以改的部分留用户的。
 * 启动同步和保存都走它，所以用户（或 AI 优化）改了不该改的字段也会被纠正回来。
 */
export function syncCore(
  cur: AgentInput,
  def: BuiltinAgent,
  ids: { categoryId: string; includes: string[] },
): AgentInput {
  const a = def.agent
  return {
    ...cur,
    name: a.name,
    description: a.description,
    icon: a.icon,
    instructions: a.instructions,
    skills: a.skills,
    params: keepParamValues(a.params, cur.params),
    common: a.common,
    canDelegate: a.canDelegate,
    canPlan: a.canPlan,
    capsSet: true,
    enabled: true,
    categoryId: ids.categoryId,
    includes: ids.includes,
  }
}

/** 同步后和原来是否一样（一样就不写盘，重复启动不改文件） */
export function sameCore(a: AgentInput, b: AgentInput) {
  // 先按 schema 解析一遍：键的顺序统一了才能直接比 JSON
  const pick = (raw: AgentInput, x = AgentInput.parse(raw)) =>
    JSON.stringify([
      x.name,
      x.description,
      x.icon,
      x.instructions,
      x.skills,
      x.params,
      x.common,
      x.canDelegate,
      x.canPlan,
      x.capsSet,
      x.upgrades,
      x.enabled,
      x.categoryId,
      x.includes,
    ])
  return pick(a) === pick(b)
}

/**
 * 项目里给必备角色填的参数（Project.agentParams）落成这个项目里的默认值：
 * 之后对话、工作流节点、spawn_agents 派出去的都按项目的取值走，节点或对话上另外填的照样优先。
 */
export function withProjectParams<A extends Agent>(
  agents: A[],
  project: Pick<Project, 'agentParams'> | undefined,
): A[] {
  const all = project?.agentParams ?? {}
  if (!Object.keys(all).length) return agents
  return agents.map((a) => {
    const vals: ParamValues | undefined = isCoreAgent(a) ? all[a.id] : undefined
    if (!vals || !Object.keys(vals).length) return a
    return {
      ...a,
      params: a.params.map((p) => {
        const v = coerceValue(p, vals[p.key])
        return v === undefined ? p : { ...p, default: v, ask: false }
      }),
    }
  })
}
