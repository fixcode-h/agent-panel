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
import {
  BUILTIN_WORKFLOWS,
  buildWorkflow,
  builtinAgentKeys,
  GENERAL_KEY,
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

/**
 * 启动时安装一次项目用的内置工作流（「通用项目」「UE 项目」）：同名或同来源的跳过，不覆盖用户改过的。
 * 返回装完后的数据，调用方据此更新集合。
 */
export async function seedProjectWorkflows(state: BuiltinState, api: BuiltinOps) {
  const rest = GLOBAL_WORKFLOWS.filter(
    (w) => !state.workflows.some((x) => x.origin === originOf(w.key) || x.name === w.name),
  )
  if (!rest.length) return { state, created: [] as Workflow[] }
  const { workflows, categories, tags, agents } = await seedBuiltins(state, api, rest)
  return {
    state: { workflows, categories, tags, agents },
    created: workflows.filter((w) => !state.workflows.some((x) => x.id === w.id)),
  }
}

/**
 * 旧项目迁移：以前项目可以不指定工作流，现在必须有。
 * 没指定、分类也没有默认时，指向内置的「通用项目」；已经指定（而且还存在）的不动。
 */
export async function migrateProjectsToGeneral(
  projects: Project[],
  workflows: Workflow[],
  categories: ProjectCategory[],
): Promise<{ id: string; workflowId: string }[]> {
  const general = workflows.find((w) => w.origin === GENERAL_ORIGIN) ?? workflows.find((w) => w.name === GENERAL_NAME)
  if (!general) return []
  const ids = new Set(workflows.map((w) => w.id))
  const out: { id: string; workflowId: string }[] = []
  for (const p of projects) {
    if (p.workflowId && ids.has(p.workflowId)) continue
    const cat = categories.find((c) => c.id === p.categoryId)
    if (!p.workflowId && cat?.workflowId && ids.has(cat.workflowId)) continue
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
