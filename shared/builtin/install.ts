import type {
  Agent,
  AgentInput,
  Category,
  Project,
  ProjectCategory,
  Tag,
  TagInput,
  Workflow,
  WorkflowInput,
} from '../schema.ts'
import { BUILTIN_AGENTS, COMMON_AGENT_KEYS, type BuiltinAgent } from './agents.ts'
import { DEFAULT_WORKFLOW_ID } from './default.ts'
import {
  BUILTIN_WORKFLOWS,
  buildWorkflow,
  builtinAgentKeys,
  GENERAL,
  GENERAL_KEY,
  GENERAL_LEGACY,
  GENERAL_NAME,
  GENERAL_ORIGIN,
  UE_PROJECT_KEY,
  type BuiltinWorkflow,
} from './workflows.ts'

/**
 * 把内置工作流、内置 Agent 建进数据：不自动装，由用户在工作流页、Agent 页的「内置」里明确添加。
 * 怎么新建（接口还是测试里的内存）由调用方传进 ops。
 */
export interface BuiltinOps {
  createAgent: (input: AgentInput) => Promise<Agent>
  createCategory: (name: string, scope: Category['scope']) => Promise<Category>
  createTag: (input: TagInput) => Promise<Tag>
  createWorkflow: (input: WorkflowInput) => Promise<Workflow>
  /** 升级旧的「通用项目」副本；没有时跳过迁移 */
  updateWorkflow?: (id: string, input: WorkflowInput) => Promise<Workflow | null>
}

/** 内置模板建出来的东西统一打上这个标签，方便在列表里筛 */
const BUILTIN_TAG = '内置'

export interface BuiltinState {
  agents: Agent[]
  categories: Category[]
  tags: Tag[]
  workflows: Workflow[]
}

const originOf = (key: string) => `builtin:${key}`
const findBuiltin = (agents: Agent[], key: string) => agents.find((a) => a.origin === originOf(key))

/** 这些内置 Agent，加上它们引入的（例如「通用约束」） */
function withIncludes(start: string[]): BuiltinAgent[] {
  const keys = new Set(start)
  for (let changed = true; changed; ) {
    changed = false
    for (const k of [...keys])
      for (const inc of BUILTIN_AGENTS.find((a) => a.key === k)?.includes ?? [])
        if (!keys.has(inc)) {
          keys.add(inc)
          changed = true
        }
  }
  return BUILTIN_AGENTS.filter((a) => keys.has(a.key))
}

/** 这个内置工作流要新建哪些 Agent（本机已经有的会复用） */
export const missingAgents = (w: BuiltinWorkflow, agents: Agent[]) =>
  withIncludes(workflowAgentKeys(w)).filter((b) => !findBuiltin(agents, b.key))

/** 工作流要的内置 Agent，加上通用 Agent：节点执行时会派它们做子任务 */
const workflowAgentKeys = (w: BuiltinWorkflow) => [...new Set([...builtinAgentKeys(w), ...COMMON_AGENT_KEYS])]

/** 本机已经添加过的内置 Agent（按 key） */
export const addedBuiltin = (agents: Agent[], key: string) => findBuiltin(agents, key)

/** 本机已经添加过的这个内置工作流；以前添加的没有记来源，按名字认 */
export const addedBuiltinWorkflow = (workflows: Workflow[], w: BuiltinWorkflow) =>
  workflows.find((x) => x.origin === originOf(w.key)) ?? workflows.find((x) => !x.origin && x.name === w.name)

function context(state: BuiltinState, api: BuiltinOps) {
  const agents = [...state.agents]
  const categories = [...state.categories]
  const tags = [...state.tags]
  const created: Agent[] = []
  const newCategories: Category[] = []
  const newTags: Tag[] = []

  const category = async (name: string, scope: Category['scope']) => {
    const hit = categories.find((c) => c.scope === scope && c.name === name)
    if (hit) return hit.id
    const c = await api.createCategory(name, scope)
    categories.push(c)
    newCategories.push(c)
    return c.id
  }
  const tag = async (name: string) => {
    const hit = tags.find((x) => x.name === name)
    if (hit) return hit.id
    const x = await api.createTag({ name, color: 'violet', description: '从内置模板添加的 Agent 和工作流' })
    tags.push(x)
    newTags.push(x)
    return x.id
  }

  /** 建出还没有的内置 Agent（按分类放好、带上引入关系）；已有的直接复用，你改过的设定不会被覆盖 */
  const createAgents = async (keys: string[]) => {
    const tagId = await tag(BUILTIN_TAG)
    let todo = withIncludes(keys).filter((b) => !findBuiltin(agents, b.key))
    const catIds = new Map<string, string>()
    for (const c of new Set(todo.map((b) => b.category))) catIds.set(c, await category(c, 'agent'))
    // 按引入关系一层层建：被引入的先建，建的时候就带上引入关系。
    // 一个个建，不并行：服务端的集合是「读出来、加一项、整个写回」，并行新建会互相覆盖
    const taken = new Set(agents.map((a) => a.name))
    while (todo.length) {
      const ready = todo.filter((b) => b.includes.every((k) => !todo.some((x) => x.key === k)))
      if (!ready.length) throw new Error(`内置 Agent 的引入关系有循环：${todo.map((b) => b.key).join(', ')}`)
      for (const b of ready) {
        // 和你自己的 Agent 重名时加个后缀，两个都留着
        let name = b.agent.name
        for (let i = 1; taken.has(name); i++) name = i > 1 ? `${b.agent.name}（内置 ${i}）` : `${b.agent.name}（内置）`
        taken.add(name)
        const a = await api.createAgent({
          ...b.agent,
          name,
          categoryId: catIds.get(b.category) ?? '',
          tags: [tagId],
          includes: b.includes.map((k) => findBuiltin(agents, k)?.id ?? '').filter(Boolean),
          origin: originOf(b.key),
        })
        agents.push(a)
        created.push(a)
      }
      todo = todo.filter((b) => !ready.includes(b))
    }
    return tagId
  }
  return { agents, created, newCategories, newTags, category, createAgents }
}

/** Agent 页「内置 Agent」里点添加：建出这些 Agent 和它们引入的 */
export async function addBuiltinAgents(keys: string[], state: BuiltinState, api: BuiltinOps) {
  const ctx = context(state, api)
  await ctx.createAgents(keys)
  return { created: ctx.created, newCategories: ctx.newCategories, newTags: ctx.newTags }
}

/**
 * 添加一个内置工作流：缺的内置 Agent 先建出来，再按模板建工作流。返回新建的东西，调用方据此更新页面上的数据。
 */
export async function addBuiltinWorkflow(w: BuiltinWorkflow, state: BuiltinState, api: BuiltinOps) {
  const { agents, created, newCategories, newTags, category, createAgents } = context(state, api)
  const tagId = await createAgents(workflowAgentKeys(w))

  const names = new Set(state.workflows.map((x) => x.name))
  let name = w.name
  for (let i = 2; names.has(name); i++) name = `${w.name} ${i}`
  const workflow = await api.createWorkflow({
    ...buildWorkflow(w, (key) => findBuiltin(agents, key)?.id ?? ''),
    name,
    categoryId: await category(w.category, 'workflow'),
    tags: [tagId],
    origin: originOf(w.key),
  })
  return { workflow, created, newCategories, newTags }
}

/** 「通用项目」「UE 项目」：启动时自动装一次，项目默认流程要用 */
const GLOBAL_WORKFLOWS = BUILTIN_WORKFLOWS.filter((w) => w.key === GENERAL_KEY || w.key === UE_PROJECT_KEY)

/** 参数表是否一致（忽略键的顺序） */
const sameParams = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

type FlowNodeLike = Workflow['flows'][number]['nodes'][number]

/** 两个节点的语义是否一致：忽略 id 和坐标 */
function sameNode(a: FlowNodeLike, b: FlowNodeLike) {
  return (
    a.title === b.title &&
    a.kind === b.kind &&
    a.agentId === b.agentId &&
    (a.flow?.kind ?? '') === (b.flow?.kind ?? '') &&
    (a.flow?.id ?? '') === (b.flow?.id ?? '') &&
    a.tier === b.tier &&
    sameParams(a.params, b.params) &&
    a.retries === b.retries &&
    a.instructions === b.instructions &&
    a.steps.length === b.steps.length &&
    (a.hooks.start?.kind ?? '') === (b.hooks.start?.kind ?? '') &&
    (a.hooks.start?.id ?? '') === (b.hooks.start?.id ?? '') &&
    (a.hooks.review?.kind ?? '') === (b.hooks.review?.kind ?? '') &&
    (a.hooks.review?.id ?? '') === (b.hooks.review?.id ?? '') &&
    (a.hooks.end?.kind ?? '') === (b.hooks.end?.kind ?? '') &&
    (a.hooks.end?.id ?? '') === (b.hooks.end?.id ?? '') &&
    a.hooks.maxRounds === b.hooks.maxRounds &&
    !!a.hooks.confirm === !!b.hooks.confirm
  )
}

const edgeKey = (e: { from: string; to: string; when?: string }) => `${e.from}>${e.to}>${e.when ?? ''}`
const sameEdges = (
  a: { from: string; to: string; when?: string }[],
  b: { from: string; to: string; when?: string }[],
) => a.map(edgeKey).sort().join('|') === b.map(edgeKey).sort().join('|')

/**
 * 本机的「通用项目」还是没改过的旧 5 节点版本：
 * Agent 按来源比较（本机 id 因机器而异），其余语义字段一致、忽略坐标和工作流说明以外的顺序
 */
function isLegacyGeneral(w: Workflow, agents: Agent[]) {
  if (w.origin !== GENERAL_ORIGIN || w.entryFlowId !== 'main') return false
  const expected = buildWorkflow(GENERAL_LEGACY, (key) => findBuiltin(agents, key)?.id ?? '')
  const exp = expected.flows.find((f) => f.id === 'main')
  const main = w.flows.find((f) => f.id === 'main')
  if (!exp || !main || main.nodes.length !== exp.nodes.length) return false
  if (!sameEdges(main.edges, exp.edges)) return false
  if (w.document.trim() !== expected.document.trim()) return false
  const byId = new Map(main.nodes.map((n) => [n.id, n]))
  return exp.nodes.every((e) => {
    const n = byId.get(e.id)
    return !!n && sameNode(n, e)
  })
}

/**
 * 把本机没改过的旧「通用项目」升级成合并后的主流程：
 * 保留工作流 id、名称、分类、标签、说明、暴露项和其他流程，discover / design / docs 的坐标不动。
 * 用户改过语义字段时跳过；升级后结构不再匹配，重复启动不会再改
 */
export async function migrateGeneralWorkflow(state: BuiltinState, api: BuiltinOps): Promise<Workflow | null> {
  if (!api.updateWorkflow) return null
  const cur = state.workflows.find((w) => w.origin === GENERAL_ORIGIN)
  if (!cur || !isLegacyGeneral(cur, state.agents)) return null
  const built = buildWorkflow(GENERAL, (key) => findBuiltin(state.agents, key)?.id ?? '')
  const oldMain = cur.flows.find((f) => f.id === 'main')!
  const newMain = built.flows.find((f) => f.id === built.entryFlowId)!
  const pos = new Map(oldMain.nodes.map((n) => [n.id, n]))
  const flows = built.flows.map((f) => {
    // 其他流程（文档初始化、测试、验收）保留本机的版本，用户可能改过
    const old = cur.flows.find((x) => x.id === f.id)
    if (f.id !== newMain.id) return old ?? f
    return {
      ...f,
      startPos: oldMain.startPos,
      endPos: oldMain.endPos,
      nodes: f.nodes.map((n) => {
        const o = pos.get(n.id)
        return o ? { ...n, x: o.x, y: o.y } : n
      }),
    }
  })
  const { id, createdAt, updatedAt, ...rest } = cur
  return api.updateWorkflow(id, {
    ...rest,
    mainAgentId: built.mainAgentId,
    entryFlowId: built.entryFlowId,
    flows,
  })
}

/**
 * 启动时安装一次项目用的内置工作流（「通用项目」「UE 项目」）：同名或同来源的跳过，不覆盖用户改过的。
 * 再把本机没改过的旧「通用项目」副本升级成合并后的主流程。
 * 返回装完后的数据，调用方据此更新集合。
 */
export async function seedProjectWorkflows(state: BuiltinState, api: BuiltinOps) {
  const rest = GLOBAL_WORKFLOWS.filter(
    (w) => !state.workflows.some((x) => x.origin === originOf(w.key) || x.name === w.name),
  )
  let cur = state
  let created: Workflow[] = []
  if (rest.length) {
    const seeded = await seedBuiltins(state, api, rest)
    cur = seeded
    created = seeded.workflows.filter((w) => !state.workflows.some((x) => x.id === w.id))
  }
  const updated = await migrateGeneralWorkflow(cur, api)
  if (updated) cur = { ...cur, workflows: cur.workflows.map((w) => (w.id === updated.id ? updated : w)) }
  return { state: cur, created, updated: updated ? [updated] : [] }
}

/**
 * 旧项目迁移：以前项目可以不指定工作流，现在必须有。
 * 没指定、分类也没有默认时，指向内置的「通用项目」；
 * 指向内置「默认」工作流的也换过去——项目对话要用常驻编排器，不是通用入口。
 */
export async function migrateProjectsToGeneral(
  projects: Project[],
  workflows: Workflow[],
  categories: ProjectCategory[],
): Promise<{ id: string; workflowId: string }[]> {
  const general = workflows.find((w) => w.origin === GENERAL_ORIGIN) ?? workflows.find((w) => w.name === GENERAL_NAME)
  if (!general) return []
  const ids = new Set(workflows.map((w) => w.id))
  const usable = (id?: string) => !!id && id !== DEFAULT_WORKFLOW_ID && ids.has(id)
  const out: { id: string; workflowId: string }[] = []
  for (const p of projects) {
    if (usable(p.workflowId)) continue
    const cat = categories.find((c) => c.id === p.categoryId)
    if (!p.workflowId && usable(cat?.workflowId)) continue
    out.push({ id: p.id, workflowId: general.id })
  }
  return out
}
/**
 * 一次装上多个内置工作流（默认全部；已有同名工作流的跳过），返回装完后的数据
 */
export async function seedBuiltins(state: BuiltinState, api: BuiltinOps, list = BUILTIN_WORKFLOWS) {
  const cur = {
    agents: [...state.agents],
    categories: [...state.categories],
    tags: [...state.tags],
    workflows: [...state.workflows],
  }
  for (const w of list) {
    if (cur.workflows.some((x) => x.name === w.name)) continue
    const r = await addBuiltinWorkflow(w, cur, api)
    cur.agents.push(...r.created)
    cur.categories.push(...r.newCategories)
    cur.tags.push(...r.newTags)
    cur.workflows.push(r.workflow)
  }
  return cur
}
