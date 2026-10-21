import { type Agent, type AgentParam, type NodeTier, type ParamValue, type ParamValues } from './schema.ts'
import { t } from './i18n.ts'
import { tierOf } from './settings.ts'
import { fillSkills } from './expose.ts'
import { skillLine } from './skill-guide.ts'

/**
 * Agent 的角色设定：引入其他 Agent、参数和条件分支、要用的 Skill，最后拼成交给 CLI 的一段说明。
 * 真实执行（server/exec/runner.ts）和在线演示都用这里，界面上的预览也用它，三边看到的一样。
 */

/** 引入最多几层：A 引入 B、B 再引入 C……再深就不展开了，免得提示词无限长；配置页超过这个深度时提醒 */
export const MAX_INCLUDE_DEPTH = 3

/** 参数显示的名字 */
export const paramLabel = (p: AgentParam) => p.label || p.key

/** 参数没有值时的空值（按类型） */
export function emptyValue(p: AgentParam): ParamValue {
  return p.type === 'multi' ? [] : p.type === 'bool' ? false : p.type === 'number' ? 0 : ''
}

/** 值是不是空的：开关的 false、数字的 0 都算有值 */
export function isEmptyValue(v: ParamValue | undefined) {
  return v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

/** 值转成文字：多选用顿号连起来，开关是「是 / 否」 */
export function valueText(v: ParamValue | undefined) {
  if (v === undefined) return ''
  if (Array.isArray(v)) return v.join('、')
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}

/** 把存下来的值规整成参数的类型（参数改过类型、选项删掉了时，旧值不合适就丢掉） */
export function coerceValue(p: AgentParam, v: ParamValue | undefined): ParamValue | undefined {
  if (v === undefined) return undefined
  switch (p.type) {
    case 'bool':
      return typeof v === 'boolean' ? v : v === 'true' || v === '是'
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    case 'multi': {
      const arr = Array.isArray(v) ? v : String(v) ? [String(v)] : []
      const ok = p.options.length ? arr.filter((x) => p.options.includes(x)) : arr
      return ok
    }
    case 'select': {
      const s = Array.isArray(v) ? (v[0] ?? '') : String(v)
      return !p.options.length || p.options.includes(s) ? s : undefined
    }
    default:
      return Array.isArray(v) ? v.join('、') : String(v)
  }
}

/**
 * 参数实际用的值：给了就用给的，否则用默认值；要问用户（ask）又没给的列进 missing。
 * 只有一层：节点上的值 / 对话里选的值 覆盖 Agent 的默认值。
 */
export function resolveParams(params: AgentParam[], given: ParamValues = {}) {
  const values: ParamValues = {}
  const missing: AgentParam[] = []
  for (const p of params) {
    const g = coerceValue(p, given[p.key])
    if (!isEmptyValue(g) || (g !== undefined && (p.type === 'bool' || p.type === 'number'))) {
      values[p.key] = g!
      continue
    }
    const d = p.ask ? undefined : coerceValue(p, p.default)
    if (d !== undefined) values[p.key] = d
    else if (p.ask) missing.push(p)
    else values[p.key] = emptyValue(p)
  }
  return { values, missing }
}

/** 条件里的一项是否成立：key（有值）、!key（没值）、key=a|b、key!=a */
function test(cond: string, values: ParamValues): boolean {
  const c = cond.trim()
  const m = /^(!)?\s*([^=!\s]+)\s*(?:(!=|=)\s*(.*))?$/.exec(c)
  if (!m) return false
  const [, not, key, op, rhs] = m
  const v = values[key]
  if (!op) {
    const has = !isEmptyValue(v) && v !== false && v !== 0
    return not ? !has : has
  }
  const wants = rhs
    .split('|')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
  const vs = Array.isArray(v) ? v : [valueText(v)]
  const hit = wants.some((w) => vs.includes(w) || (typeof v === 'boolean' && (w === 'true') === v))
  return op === '=' ? hit : !hit
}

/**
 * 角色设定里的模板：
 * - {{key}} 换成参数的值
 * - {{#if key}}…{{else}}…{{/if}}，条件可以写 key=值、key=值1|值2、key!=值、!key，可以嵌套
 * 不认识的写法原样保留。
 */
export function renderTemplate(text: string, values: ParamValues) {
  let out = text
  // 先处理最里层的条件块，一层层往外
  const IF = /\{\{#if\s+([^}]+)\}\}((?:(?!\{\{#if\s)[\s\S])*?)\{\{\/if\}\}/
  for (let i = 0; i < 200; i++) {
    const m = IF.exec(out)
    if (!m) break
    const [yes, no = ''] = m[2].split(/\{\{else\}\}/)
    out = out.slice(0, m.index) + (test(m[1], values) ? yes : no) + out.slice(m.index + m[0].length)
  }
  return out.replace(/\{\{\s*([^#/{}\s][^{}]*?)\s*\}\}/g, (all, key: string) =>
    key in values ? valueText(values[key]) : all,
  )
}

/** 引入的 Agent，按顺序展开（去重、跳过循环和停用的），不含自己 */
export function includedAgents(agent: Agent, agents: Agent[]): { agent: Agent; depth: number }[] {
  const out: { agent: Agent; depth: number }[] = []
  const seen = new Set([agent.id])
  const walk = (a: Agent, depth: number) => {
    if (depth > MAX_INCLUDE_DEPTH) return
    for (const id of a.includes) {
      if (seen.has(id)) continue
      const sub = agents.find((x) => x.id === id)
      if (!sub) continue
      seen.add(id)
      out.push({ agent: sub, depth })
      walk(sub, depth + 1)
    }
  }
  walk(agent, 1)
  return out
}

/** 这个 Agent 引入了谁会形成循环（引入 target 后能绕回自己） */
export function wouldCycle(agentId: string, target: string, agents: Agent[]) {
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length) {
    const id = stack.pop()!
    if (id === agentId) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(agents.find((a) => a.id === id)?.includes ?? []))
  }
  return false
}

/** 引入树的一行：depth 从 1 开始；cycle 表示这里绕回了上面的某一层，不再往下展开 */
export interface IncludeRow {
  id: string
  agent?: Agent
  depth: number
  cycle?: boolean
}

/** 引入树最多列多少行：互相引入很多时也不至于卡住页面 */
const MAX_TREE_ROWS = 200

/**
 * 完整的引入树（不受 MAX_INCLUDE_DEPTH 限制），按深度优先排成一行一行，配置页用来显示层级、提醒太深和循环。
 * 同一个 Agent 从不同路径被引入会出现多次；绕回祖先的地方标 cycle 并停下。
 */
export function includeTree(agent: Pick<Agent, 'id' | 'includes'>, agents: Agent[]): IncludeRow[] {
  const rows: IncludeRow[] = []
  const walk = (a: Pick<Agent, 'id' | 'includes'>, depth: number, path: string[]) => {
    for (const id of a.includes) {
      if (rows.length >= MAX_TREE_ROWS) return
      const sub = agents.find((x) => x.id === id)
      const cycle = path.includes(id)
      rows.push({ id, agent: sub, depth, ...(cycle && { cycle }) })
      if (sub && !cycle) walk(sub, depth + 1, [...path, id])
    }
  }
  walk(agent, 1, [agent.id])
  return rows
}

/** 引入链有几层（没有引入是 0） */
export const includeDepth = (agent: Pick<Agent, 'id' | 'includes'>, agents: Agent[]) =>
  includeTree(agent, agents).reduce((m, r) => Math.max(m, r.depth), 0)

/**
 * 经过这个 Agent 的引入循环：返回 [自己, …, 自己] 的 id 链，没有循环返回空。
 * 执行时循环会被跳过，但说明它的设定写错了，配置页要提出来。
 */
export function includeCycle(agent: Pick<Agent, 'id' | 'includes'>, agents: Agent[]): string[] {
  const prev = new Map<string, string>()
  const queue = agent.includes.filter((id) => {
    if (prev.has(id)) return false
    prev.set(id, agent.id)
    return true
  })
  while (queue.length) {
    const id = queue.shift()!
    if (id === agent.id) {
      const chain = [id]
      for (let cur = prev.get(id)!; cur !== agent.id; cur = prev.get(cur)!) chain.unshift(cur)
      return [agent.id, ...chain]
    }
    for (const next of agents.find((a) => a.id === id)?.includes ?? [])
      if (!prev.has(next)) {
        prev.set(next, id)
        queue.push(next)
      }
  }
  return []
}

/** 所有 Agent 里的引入循环（每个循环只列一次） */
export function includeCycles(agents: Agent[]): string[][] {
  const out: string[][] = []
  const seen = new Set<string>()
  for (const a of agents) {
    if (seen.has(a.id)) continue
    const c = includeCycle(a, agents)
    if (!c.length) continue
    c.forEach((id) => seen.add(id))
    out.push(c)
  }
  return out
}

/** 循环链写成「A → B → A」 */
export const cycleText = (chain: string[], agents: Agent[]) =>
  chain.map((id) => agents.find((a) => a.id === id)?.name ?? id).join(' → ')

/** 通用 Agent：工作流里任何 Agent 都可以把子任务派给它们（停用的不算） */
export const commonAgents = (agents: Agent[]) => agents.filter((a) => a.common && a.enabled)

/**
 * 交给 CLI 的完整角色设定：自己的设定（套上参数）、引入的 Agent 的设定、参数的取值、要用的 Skill。
 * 引入的 Agent 用它们自己的参数默认值；同名参数跟着这个 Agent 的取值走，方便一个开关管住一串。
 * slots 是项目里定的技能槽取值：Skill 名写 `{{槽名}}` 时按它换掉（见 shared/expose.ts）。
 */
export function composeRole(
  agent: Agent,
  agents: Agent[],
  given: ParamValues = {},
  slots: Record<string, string> = {},
) {
  const { values } = resolveParams(agent.params, given)
  const parts: string[] = []
  const own = renderTemplate(agent.instructions, values).trim()
  if (own) parts.push(own)
  const subs = includedAgents(agent, agents)
  for (const { agent: s } of subs) {
    const sv = resolveParams(s.params, { ...values }).values
    const text = renderTemplate(s.instructions, sv).trim()
    if (text) parts.push(`## 引入的 Agent：${s.name}\n${s.description ? `${s.description}\n\n` : ''}${text}`)
  }
  if (agent.params.length) {
    const lines = agent.params.map((p) => `- ${paramLabel(p)}（${p.key}）：${valueText(values[p.key]) || '（空）'}`)
    parts.push(`## 本次的参数\n按这些参数决定做法：\n${lines.join('\n')}`)
  }
  const skills = [...new Set(fillSkills([...agent.skills, ...subs.flatMap((s) => s.agent.skills)], slots))]
  if (skills.length)
    parts.push(
      `## 要用的 Skill\n遇到下面的情况时先读对应的 SKILL.md，按里面的规则做（找不到就按自己的方式做）：\n${skills.map(skillLine).join('\n')}`,
    )
  return parts.join('\n\n')
}

/** Agent 设的档位；不是档位时（旧数据、默认 Agent）按中档 */
export const agentTier = (a: { model: string }): Exclude<NodeTier, ''> => tierOf(a.model)?.id ?? 'medium'

/**
 * 工作流节点上实际执行用的 Agent：固定用默认 CLI，模型和思考强度都取节点选的档位。
 * 额外参数是写给某个 CLI 的：Agent 固定了别的 CLI 时不带过去；权限由 agentPermission 判断新 CLI 认不认。
 */
export function nodeAgentRun<A extends Agent>(agent: A, tier: NodeTier, defaultCliId?: string): A {
  const keepArgs = !agent.cli || !defaultCliId || agent.cli === defaultCliId
  return {
    ...agent,
    cli: '',
    model: `@${tier || agentTier(agent)}`,
    effort: '',
    extraArgs: keepArgs ? agent.extraArgs : [],
  }
}

/** 节点上的参数还缺哪些（要问用户的参数在节点上必须填） */
export function nodeMissingParams(agent: Agent | undefined, values: ParamValues) {
  if (!agent || !agent.id) return []
  return resolveParams(agent.params, values).missing
}

/** 参数类型的名字 */
export const PARAM_TYPES: { id: AgentParam['type']; label: string }[] = [
  { id: 'select', label: t('下拉单选') },
  { id: 'multi', label: t('多选') },
  { id: 'bool', label: t('开关') },
  { id: 'text', label: t('文本') },
  { id: 'number', label: t('数字') },
]

/** 新建对话时还没选的参数（要问用户的）：返回错误说明，都有了返回空 */
export function chatMissingParams(input: { mode: string; agentId: string; params?: ParamValues }, agents: Agent[]) {
  if (input.mode !== 'chat') return ''
  const agent = agents.find((a) => a.id === input.agentId)
  const lack = agent ? resolveParams(agent.params, input.params ?? {}).missing : []
  return lack.length ? t('请先选择参数：{list}', { list: lack.map(paramLabel).join(t('、')) }) : ''
}
