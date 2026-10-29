import { AgentInput, type Agent, type AgentParam, type ParamValue, type ParamValues, type Project } from '../schema.ts'
import { coerceValue, isEmptyValue } from '../agent-role.ts'
import { t } from '../i18n.ts'
import { BUILTIN_AGENTS, type BuiltinAgent } from './agents.ts'
import type { AgentMount } from '../schema.ts'

/**
 * 必备角色：项目对话离不开的八个能力块。启动时自动装好、不能删除，也不能改成别的角色：
 * 名称、角色设定、Skill、能力开关、参数的定义都由面板维护，每次启动按内置定义同步；
 * 用户能改的只有运行配置（CLI、模型、思考强度、权限、额外参数、开场要求、标签）和参数的取值。
 * 这样「主理把文档交给文档角色」「执行派测试验收去跑」「收尾前派评审、交付前交版本控制收尾」这类约定才靠得住，
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

/** 默认子任务角色「子任务」在内置定义里的 key */
export const HELPER_KEY = 'helper'

/**
 * 子任务默认用的必备角色（「子任务」，spawn_agents 不写 agent 时用它）。
 * 它不是用户可选的角色：角色页、内置角色弹窗、选择器都不展示，也不能改名、停用、删除；
 * 定义要留着，删了所有子任务就没有默认角色和提示词了。
 */
export const isHelperAgent = (a: Pick<Agent, 'origin'> | undefined) => coreKey(a) === HELPER_KEY

export const isCoreAgent = (a: Pick<Agent, 'origin'> | undefined) => !!coreKey(a)

/** 界面上可以列出的角色：去掉只由 spawn_agents 兜底使用的默认子任务角色 */
export const listableAgents = <A extends Pick<Agent, 'origin'>>(agents: A[]): A[] =>
  agents.filter((a) => !isHelperAgent(a))

/**
 * 内置角色（必备角色也算）：来源是 builtin:<key> 且这个 key 还有内置定义。
 * 用户 2026-10-25 定的：内置角色和必备角色一样由面板维护，设定只认内置定义，每次启动、每次保存都换成当前版本，
 * 不再按「和历史版本逐字一致才升级」判断（历史版本漏登记一次，副本就永远卡在旧版）。想自己改的复制一份再改。
 * 已合并、下线的角色（MERGED_AGENTS）没有定义，不在这里。
 */
export function builtinKey(a: Pick<Agent, 'origin'> | undefined): string | undefined {
  const k = a?.origin.startsWith('builtin:') ? a.origin.slice(8) : ''
  return k && BUILTIN_AGENTS.some((b) => b.key === k) ? k : undefined
}

export const isBuiltinAgent = (a: Pick<Agent, 'origin'> | undefined) => !!builtinKey(a)

export const builtinDefinition = (key: string) => BUILTIN_AGENTS.find((b) => b.key === key)

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
  // 主理的「大改动先确认」默认打开：拆三个以上子对话、跨模块的派单先给用户看方案（角色分层改造）
  { id: 'orchestrator.confirm-on', core: 'orchestrator', key: 'confirm', from: false },
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
 * 必备角色改了「在哪类对话里启动」的默认值（如「文档」从任意改成只在父对话）。
 * 这个字段用户可以改，而且旧数据里根本不存在（schema 按 any 读），所以同样只在启动时做一次：
 * 没做过这条升级的副本改成新默认并记进 upgrades；之后用户改回 any 不会被再改回来。
 */
const RUN_IN_CHANGES: { id: string; core: CoreKey; runIn: AgentInput['runIn'] }[] = [
  // 补文档会把子对话卡在那儿空耗：默认改成父对话里创建（ADR 0019）
  { id: 'docsync.run-in-parent', core: 'docsync', runIn: 'parent' },
]

/**
 * 就地微改动开关的默认值升级：和 runIn 一样是用户能改的选择，旧副本没有这个字段（按 off 读），
 * 只在启动时做一次，之后用户关掉不会被改回来
 */
const INLINE_EDIT_CHANGES: { id: string; core: CoreKey; inlineEdit: AgentInput['inlineEdit'] }[] = [
  // 主理（原统筹）可以就地做护栏内的微改动：改个文案不用等一个子对话冷启动
  { id: 'orchestrator.inline-edit', core: 'orchestrator', inlineEdit: 'tiny' },
]

/** 对已装的必备角色补做还没做过的启动位置、就地改动升级（幂等） */
export function upgradeRunIn(a: AgentInput, key: CoreKey): AgentInput {
  const todo = RUN_IN_CHANGES.filter((c) => c.core === key && !a.upgrades?.includes(c.id))
  const edits = INLINE_EDIT_CHANGES.filter((c) => c.core === key && !a.upgrades?.includes(c.id))
  if (!todo.length && !edits.length) return a
  return {
    ...a,
    ...(todo.length && { runIn: todo[0].runIn }),
    ...(edits.length && { inlineEdit: edits[0].inlineEdit }),
    upgrades: [...(a.upgrades ?? []), ...todo.map((c) => c.id), ...edits.map((c) => c.id)],
  }
}

/**
 * 内置定义里的挂载换成本机的挂载：key 换成 id（本机没有的能力跳过），没写的字段补默认值。
 * id 由调用方按 key 找（安装时找刚建好的，同步时找本机已有的）
 */
export function builtinMounts(def: Pick<BuiltinAgent, 'mounts'>, idOf: (key: string) => string | undefined) {
  return def.mounts.flatMap(({ key, ...m }): AgentMount[] => {
    const agentId = idOf(key)
    return agentId ? [{ agentId, preload: false, rule: '', params: {}, ...m }] : []
  })
}

/** 内置角色在本机按定义该挂的能力（按来源 builtin:<key> 找本机的 id） */
export const defaultMounts = (def: Pick<BuiltinAgent, 'mounts'>, agents: Pick<Agent, 'id' | 'origin'>[]) =>
  builtinMounts(def, (k) => agents.find((a) => a.origin === `builtin:${k}`)?.id)

/**
 * 同步挂载（用户没接管挂载时）：挂哪些能力、规则、预加载跟内置定义；用户在挂载上改过的用法（mode）和参数取值保留
 * （ADR 0015 的口径：设定归面板，取值归用户）。接管了的见 AgentInput.mountsCustom
 */
function syncMounts(defs: AgentMount[], mine: AgentMount[]): AgentMount[] {
  return defs.map((d) => {
    const m = mine.find((x) => x.agentId === d.agentId)
    return m ? { ...d, mode: m.mode, params: { ...d.params, ...m.params } } : d
  })
}

/**
 * 按内置定义改写一个内置角色（必备角色和其他内置角色都走它）：定义部分换成内置的，可以改的部分留用户的。
 * 启动同步和保存都走它，所以用户（或 AI 优化）改了不该改的字段也会被纠正回来。
 * 必备角色不能停用；其他内置角色的启用开关、分类（由调用方传）留用户的。
 */
export function syncCore(
  cur: AgentInput,
  def: BuiltinAgent,
  /** mounts：定义里的挂载（已换成本机 id）；启动同步按内置定义算，编辑保存时传已装副本上的 */
  ids: { categoryId: string; includes: string[]; mounts?: AgentMount[] },
): AgentInput {
  const a = def.agent
  return {
    ...cur,
    kind: a.kind,
    when: a.when,
    modes: a.modes,
    independent: a.independent,
    // 用户接管了挂载（加了自定义角色、删了默认挂的、改了说明）就整份按用户的，不再跟内置定义
    mounts: cur.mountsCustom ? (cur.mounts ?? []) : syncMounts(ids.mounts ?? [], cur.mounts ?? []),
    mountsCustom: cur.mountsCustom || undefined,
    // 就地微改动和启动位置一样是用户的选择（升级见 upgradeRunIn）
    inlineEdit: cur.inlineEdit ?? a.inlineEdit,
    name: a.name,
    description: a.description,
    icon: a.icon,
    instructions: a.instructions,
    skills: a.skills,
    params: keepParamValues(a.params, cur.params),
    common: a.common,
    canDelegate: a.canDelegate,
    canPlan: a.canPlan,
    // 启动位置不跟内置定义：用户可以改（包括内置角色），升级只在启动时做一次（见 upgradeRunIn）
    runIn: cur.runIn,
    capsSet: true,
    enabled: KEYS.has(def.key) ? true : cur.enabled,
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
      x.runIn,
      x.kind,
      x.when,
      x.modes,
      x.independent,
      x.mounts,
      !!x.mountsCustom,
      x.inlineEdit,
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
