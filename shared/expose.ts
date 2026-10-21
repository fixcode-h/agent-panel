import type { FlowNode, ParamValues, Workflow, WorkflowExpose } from './schema.ts'

/**
 * 工作流暴露项：工作流里用 `{{槽名}}` 在技能列表、节点参数、工作流说明里占位，
 * 项目设置里按 expose 的说明填值。
 *
 * 新建对话时解析一次写进任务快照，之后改工作流或项目设置都不影响已经开始的对话。
 */

/** 一项配置现在生效的值：项目填了就用项目的，没填用默认值 */
export function exposeValue(e: WorkflowExpose, params: ParamValues): string {
  const v = params[e.key]
  const text = (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v)).trim()
  if (text) return text
  const d = e.default
  if (Array.isArray(d)) return d.join(', ')
  return d === undefined || d === null ? '' : String(d)
}

/** 项目里实际生效的配置：key → 文本值，只留非空的 */
export function exposeValues(w: Pick<Workflow, 'expose'>, params: ParamValues) {
  const out: Record<string, string> = {}
  for (const e of w.expose) {
    const v = exposeValue(e, params).trim()
    if (v) out[e.key] = v
  }
  return out
}

/** 把 `{{槽名}}` 换成配置值；没配到的保持原样（方便一眼看出漏配） */
export function fillSlots(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (all, key: string) => values[key] ?? all)
}

/** 把一项配置写进参数；targetId 可以是节点 id，也可以是节点里某一步的 id */
function setParam(params: ParamValues, e: WorkflowExpose, v: string) {
  const cur = params[e.key]
  params[e.key] = typeof cur === 'boolean' ? v === 'true' : typeof cur === 'number' && Number.isFinite(+v) ? +v : v
}

/** 节点上的参数覆盖（target=node，targetId 为空表示这个节点和它的步骤上没有同名参数就不动） */
export function applyNodeExpose(n: FlowNode, w: Pick<Workflow, 'expose'>, values: Record<string, string>): FlowNode {
  const params = { ...n.params }
  const steps = n.steps.map((s) => ({ ...s, params: { ...s.params } }))
  for (const e of w.expose) {
    if (e.target !== 'node') continue
    const v = values[e.key]
    if (v === undefined) continue
    if (!e.targetId || e.targetId === n.id) setParam(params, e, v)
    for (const s of steps) if (!e.targetId || e.targetId === s.id) setParam(s.params, e, v)
  }
  return { ...n, params, steps }
}

/**
 * Agent 参数的覆盖（target=agent，targetId 是参数 key）：写进每个节点的参数里，
 * Agent 没声明这个参数时会被忽略，声明了的节点就用这里定的值。
 */
export function applyAgentExpose(n: FlowNode, w: Pick<Workflow, 'expose'>, values: Record<string, string>): FlowNode {
  const add = (params: ParamValues) => {
    for (const e of w.expose) {
      if (e.target !== 'agent' || !e.targetId) continue
      const v = values[e.key]
      if (v === undefined) continue
      params[e.targetId] = v === 'true' ? true : v === 'false' ? false : v
    }
  }
  const params = { ...n.params }
  add(params)
  const steps = n.steps.map((s) => {
    const p = { ...s.params }
    add(p)
    return { ...s, params: p }
  })
  return { ...n, params, steps }
}

/** 注入到工作流说明后面的配置（target=document） */
function documentPart(w: Pick<Workflow, 'expose'>, values: Record<string, string>) {
  return w.expose
    .filter((e) => e.target === 'document')
    .map((e) => [e, values[e.key]] as const)
    .filter(([, v]) => v)
    .map(([e, v]) => `## ${e.targetId || e.label || e.key}\n${v}`)
    .join('\n\n')
}

/**
 * 解析成任务里存的那份工作流：说明和节点参数按配置落好，技能槽留给角色拼装
 * （技能在 Agent 上，不在工作流里），expose 清空。
 */
export function applyExpose(w: Workflow, params: ParamValues): Workflow {
  if (!w.expose.length) return w
  const values = exposeValues(w, params)
  const doc = [fillSlots(w.document, values), documentPart(w, values)].filter(Boolean).join('\n\n')
  return {
    ...w,
    document: doc,
    expose: [],
    flows: w.flows.map((f) => ({
      ...f,
      nodes: f.nodes.map((n) => {
        const node = applyAgentExpose(applyNodeExpose(n, w, values), w, values)
        return {
          ...node,
          instructions: fillSlots(n.instructions, values),
          steps: node.steps.map((s) => ({ ...s, instructions: fillSlots(s.instructions, values) })),
        }
      }),
    })),
  }
}

/**
 * 任务快照里的技能槽取值：Agent 的 skills 里写 `{{槽名}}`，执行时换成这里解析好的技能名。
 * 和说明、节点参数一样在新建对话时定下来，之后改项目设置不影响这个对话。
 * 只留 target=skill 的项：别的项已经落进工作流说明和节点参数里了。
 */
export function exposeSlots(w: Pick<Workflow, 'expose'>, params: ParamValues) {
  return exposeValues({ expose: w.expose.filter((e) => e.target === 'skill') }, params)
}

/** 把技能列表里的 `{{槽名}}` 换成任务快照里的取值；没配到的槽（残留的 {{…}}）丢掉 */
export function fillSkills(skills: string[], slots: Record<string, string>) {
  return skills.map((s) => fillSlots(s, slots).trim()).filter((s) => s && !/\{\{[^}]*\}\}/.test(s))
}
