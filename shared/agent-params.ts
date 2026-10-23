import type { Agent, AgentParam, ParamValue, ParamValues, Workflow } from './schema.ts'
import { nodeSteps } from './flow.ts'
import { coerceValue, isEmptyValue, paramLabel } from './agent-role.ts'

/**
 * 工作流里实际用到的 Agent 参数：项目设置里派生出来给用户配，不再要工作流作者手工加 expose。
 *
 * 收集范围是「项目当前工作流」（包括子流程、节点步骤、主 Agent），按 Agent 去重。
 * 同一个参数 key 出现在多个 Agent 时只出现一次、共用一个值，并记下影响哪些 Agent——
 * 不能让用户以为配了 A 就不影响 B。已经被 Workflow.expose（target=agent）管理的 key
 * 不再出现在这里，避免同一参数有两套配置源。
 */

export interface AgentParamOwner {
  id: string
  name: string
  /** 这个 Agent 里同名参数的声明 */
  param: AgentParam
}

export interface AgentParamGroup {
  agentId: string
  agentName: string
  params: AgentParam[]
  /** 这个 Agent 在工作流里出现几次，界面上可以提示 */
  used: number
}

export interface DerivedParam {
  /** 参数 key，也是 workflowParams[workflowId] 里的键 */
  key: string
  label: string
  /** 第一个用到它的 Agent 声明的类型 */
  type: AgentParam['type']
  options: string[]
  defaultValue?: ParamValue
  /** 没有默认值又必须填 */
  required: boolean
  description: string
  /** 哪些 Agent 会用这个参数（同 key 共用） */
  agents: AgentParamOwner[]
  /** 联动：第一个声明里的显示条件和选项规则（见 AgentParam） */
  when?: AgentParam['when']
  optionsBy?: AgentParam['optionsBy']
}

/** 工作流实际用到的 Agent id：主 Agent + 所有节点 / 步骤的 Agent，去重 */
export function workflowAgentIds(w: Pick<Workflow, 'mainAgentId' | 'flows'>) {
  const ids = new Set<string>()
  if (w.mainAgentId) ids.add(w.mainAgentId)
  for (const f of w.flows)
    for (const n of f.nodes) for (const s of nodeSteps(n)) if (s.kind === 'agent' && s.agentId) ids.add(s.agentId)
  return [...ids]
}

/** 每个 Agent 在工作流里被用到的次数；节点没指定 Agent 时算主 Agent 的 */
export function workflowAgentUsage(w: Pick<Workflow, 'mainAgentId' | 'flows'>) {
  const out = new Map<string, number>()
  const bump = (id: string) => out.set(id, (out.get(id) ?? 0) + 1)
  for (const f of w.flows)
    for (const n of f.nodes)
      for (const s of nodeSteps(n)) bump(s.kind === 'agent' && s.agentId ? s.agentId : w.mainAgentId)
  return out
}

/**
 * 按 Agent 分组的参数：只列真正会被执行的、有参数的 Agent。
 * 主 Agent 排在最前，其余按名称，和界面上看到的角色对应。
 */
export function agentParamGroups(w: Workflow, agents: Agent[]): AgentParamGroup[] {
  const usage = workflowAgentUsage(w)
  return workflowAgentIds(w)
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a && a.params.length > 0)
    .sort((a, b) => {
      if (a.id === w.mainAgentId) return -1
      if (b.id === w.mainAgentId) return 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    .map((a) => ({ agentId: a.id, agentName: a.name, params: a.params, used: usage.get(a.id) ?? 0 }))
}

/**
 * 派生出来的参数表：同 key 合并成一条，共用一个值。
 * 工作流 expose 里 target=agent 的 key 由 expose 管，不再派生。
 */
export function derivedParams(w: Pick<Workflow, 'expose' | 'mainAgentId' | 'flows'>, agents: Agent[]): DerivedParam[] {
  const managed = new Set(w.expose.filter((e) => e.target === 'agent').map((e) => e.targetId))
  const map = new Map<string, DerivedParam>()
  for (const group of agentParamGroups(w as Workflow, agents))
    for (const p of group.params) {
      if (managed.has(p.key)) continue
      const owner: AgentParamOwner = { id: group.agentId, name: group.agentName, param: p }
      const cur = map.get(p.key)
      if (!cur) {
        map.set(p.key, {
          key: p.key,
          label: paramLabel(p),
          type: p.type,
          options: p.options,
          defaultValue: p.default,
          required: p.ask && p.default === undefined,
          description: p.description,
          agents: [owner],
          ...(p.when && { when: p.when }),
          ...(p.optionsBy && { optionsBy: p.optionsBy }),
        })
        continue
      }
      cur.agents.push(owner)
      // 第一个有选项的声明决定选项表；任一处没默认值又必须填时算必须填
      if (!cur.options.length && p.options.length) cur.options = p.options
      if (!cur.description && p.description) cur.description = p.description
      if (cur.defaultValue === undefined && p.default !== undefined) cur.defaultValue = p.default
      if (cur.defaultValue === undefined && p.ask) cur.required = true
    }
  return [...map.values()]
}

/**
 * 项目里填的 Agent 参数值，按声明规整成参数类型。
 * 只保留真正填过的值：空字符串、空多选当作没填，默认值仍由 AgentParam.default 提供，
 * 所以表单里「留空 = 用默认」不需要额外约定。
 */
export function projectAgentValues(
  w: Pick<Workflow, 'expose' | 'mainAgentId' | 'flows'>,
  agents: Agent[],
  params: ParamValues,
): ParamValues {
  const out: ParamValues = {}
  for (const d of derivedParams(w, agents)) {
    const raw = params[d.key]
    if (raw === undefined) continue
    const v = coerceValue({ ...d, ask: d.required }, raw)
    if (v === undefined) continue
    // 布尔和数字的 false / 0 是有效值，只有空字符串和空多选当作没填
    if (isEmptyValue(v) && typeof v !== 'boolean' && typeof v !== 'number') continue
    out[d.key] = v
  }
  return out
}

/** 参数值是不是还是默认值（没填过）：界面用它区分「用户填过」和「留空用默认」 */
export const isDefaultValue = (d: Pick<DerivedParam, 'defaultValue'>, v: ParamValue | undefined) =>
  v === undefined || JSON.stringify(v) === JSON.stringify(d.defaultValue)
