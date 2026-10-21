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
import { BUILTIN_AGENTS, COMMON_AGENT_KEYS, CORE_CATEGORY, type BuiltinAgent } from './agents.ts'
import { DEFAULT_WORKFLOW_ID } from './default.ts'
import { CORE_AGENTS, coreDefinition, sameCore, syncCore } from './core.ts'
import {
  LEGACY_AGENT_FIELDS,
  LEGACY_AGENT_FIELDS_MORE,
  LEGACY_WORKFLOWS,
  MERGED_AGENTS,
  mergedParams,
  type LegacyWorkflow,
  type MergedAgent,
} from './legacy.ts'
import {
  BUILTIN_WORKFLOWS,
  buildFlow,
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
  /** 升级没改过的内置副本、旧「通用项目」副本；没有时跳过迁移 */
  updateWorkflow?: (id: string, input: WorkflowInput) => Promise<Workflow | null>
  /** 升级没改过的旧内置 Agent；没有时跳过 */
  updateAgent?: (id: string, input: AgentInput) => Promise<Agent | null>
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
 * 本机副本是不是「没改过的旧版本」：和某个旧定义的流程逐个比较，
 * 节点语义、连线和说明都一致（忽略坐标），并且这个名字对应的流程在两边都有。
 * 只比较旧定义里出现过的流程 id，用户新增的流程不影响判断。
 */
function matchesLegacy(cur: Workflow, legacy: LegacyWorkflow, agentId: (key: string) => string) {
  if (cur.document.trim() !== legacy.document.trim()) return false
  const expected = legacy.flows.map((f) => buildFlow(f, agentId))
  for (const exp of expected) {
    const mine = cur.flows.find((f) => f.id === exp.id)
    if (!mine || mine.nodes.length !== exp.nodes.length) return false
    if (!sameEdges(mine.edges, exp.edges)) return false
    const byId = new Map(mine.nodes.map((n) => [n.id, n]))
    if (
      !exp.nodes.every((e) => {
        const n = byId.get(e.id)
        return !!n && sameNode(n, e)
      })
    )
      return false
  }
  return true
}

/** 本机已合并 Agent 的副本 id → 合并目标的 id 和换算规则（两边都在本机才算） */
function mergedTargets(agents: Pick<Agent, 'id' | 'origin'>[]) {
  const target = new Map<string, { to: string; merged: MergedAgent }>()
  for (const [key, m] of Object.entries(MERGED_AGENTS)) {
    const from = findBuiltin(agents as Agent[], key)?.id
    const to = findBuiltin(agents as Agent[], m.into)?.id
    if (from && to && from !== to) target.set(from, { to, merged: m })
  }
  return target
}

/**
 * 旧副本里引用了已合并 Agent 的节点，改成指向合并后的 Agent（`MERGED_AGENTS`），
 * 让用户改过、没自动升级的工作流也仍然能跑，不会因为 Agent 不再出现在「内置」里就断掉。
 * 节点说明保留，参数按 MERGED_AGENTS 换算成目标 Agent 的（例如调试员的「性能问题」换成开发的「任务」）；
 * 主 Agent 和成员一起换。返回改过的流程，没有命中时返回 null。幂等：改完就不再引用旧 id。
 */
function redirectMergedAgents(cur: Workflow, agents: Agent[]): Workflow | null {
  const target = mergedTargets(agents)
  if (!target.size) return null
  let changed = false
  const fix = <U extends { agentId: string; params: Workflow['flows'][number]['nodes'][number]['params'] }>(
    u: U,
  ): U => {
    const hit = target.get(u.agentId)
    if (!hit) return u
    changed = true
    return { ...u, agentId: hit.to, params: mergedParams(hit.merged, u.params) }
  }
  const flows = cur.flows.map((f) => ({
    ...f,
    nodes: f.nodes.map((n) => {
      const node = n.kind === 'agent' && n.agentId ? fix(n) : n
      return { ...node, steps: node.steps.map((s) => (s.kind === 'agent' && s.agentId ? fix(s) : s)) }
    }),
  }))
  const main = target.get(cur.mainAgentId)
  if (main) changed = true
  const members = cur.members.map((m) => {
    const hit = target.get(m.agentId)
    if (!hit) return m
    changed = true
    return { ...m, agentId: hit.to }
  })
  if (!changed) return null
  return {
    ...cur,
    mainAgentId: main?.to ?? cur.mainAgentId,
    // 合并到同一个 Agent 后可能重复，留第一条
    members: members.filter((m, i) => members.findIndex((x) => x.agentId === m.agentId) === i),
    flows,
  }
}

/** 项目的默认对话角色指向已合并的 Agent 时，改成合并目标；返回要改的项目 */
export function redirectMergedProjects(projects: Project[], agents: Agent[]) {
  const target = mergedTargets(agents)
  return projects
    .filter((p) => target.has(p.defaultAgentId))
    .map((p) => ({ id: p.id, defaultAgentId: target.get(p.defaultAgentId)!.to }))
}

/** 这个 Agent 是否还被用着：工作流（主 Agent、成员、节点、步骤）、项目的默认对话角色、其他 Agent 的引入 */
function agentInUse(id: string, state: BuiltinState, projects: Pick<Project, 'defaultAgentId'>[]) {
  return (
    state.workflows.some(
      (w) =>
        w.mainAgentId === id ||
        w.members.some((m) => m.agentId === id) ||
        w.flows.some((f) => f.nodes.some((n) => n.agentId === id || n.steps.some((s) => s.agentId === id))),
    ) ||
    projects.some((p) => p.defaultAgentId === id) ||
    state.agents.some((a) => a.id !== id && a.includes.includes(id))
  )
}

/** 已合并 Agent 的本机副本是不是没改过：和它的旧指纹一致（简介后面补的合并说明不算改动） */
function untouchedMerged(a: Agent, key: string) {
  const olds = [LEGACY_AGENT_FIELDS[key], ...(LEGACY_AGENT_FIELDS_MORE[key] ?? [])].filter(Boolean)
  // 更早合并的几个没留指纹：它们早就只剩一条说明，引用也在上一版重定向过了
  if (!olds.length) return true
  const note = `（${MERGED_AGENTS[key].note}）`
  const desc = a.description.replace(note, '').trim()
  return olds.some(
    (o) => a.name === o.name && desc === o.description.trim() && a.instructions.trim() === o.instructions.trim(),
  )
}

/**
 * 删掉已经没用的已合并 Agent 副本：引用都重定向过了、没人再用、也没被用户改过的才删。
 * 返回删掉的 Agent（调用方备份）和「旧 id → 合并目标 id」，旧对话里还记着旧 id 的照这个转过去。
 * 用户改过的、还被用着的保留，只在简介里补合并说明（见 annotateMergedAgents）。
 */
export async function pruneMergedAgents(
  state: BuiltinState,
  projects: Pick<Project, 'defaultAgentId'>[],
  api: { deleteAgent?: (id: string) => Promise<unknown> },
) {
  const removed: Agent[] = []
  const aliases: Record<string, string> = {}
  if (!api.deleteAgent) return { removed, aliases }
  const target = mergedTargets(state.agents)
  for (const [key] of Object.entries(MERGED_AGENTS)) {
    const cur = findBuiltin(state.agents, key)
    const hit = cur && target.get(cur.id)
    if (!cur || !hit) continue
    if (agentInUse(cur.id, state, projects) || !untouchedMerged(cur, key)) continue
    await api.deleteAgent(cur.id)
    removed.push(cur)
    aliases[cur.id] = hit.to
  }
  return { removed, aliases }
}

/**
 * 把旧副本里指向已合并 Agent 的引用重定向到新 Agent（见 redirectMergedAgents）。
 * 放在升级之后跑：没改过的副本已经被整体换掉了，这里只处理用户改过、没自动升级的那些。
 */
export async function redirectMergedWorkflows(state: BuiltinState, api: BuiltinOps): Promise<Workflow[]> {
  if (!api.updateWorkflow) return []
  const out: Workflow[] = []
  for (const cur of state.workflows) {
    const next = redirectMergedAgents(cur, state.agents)
    if (!next) continue
    const { id, createdAt, updatedAt, ...rest } = next
    const saved = await api.updateWorkflow(id, rest)
    if (saved) out.push(saved)
  }
  return out
}

/**
 * 升级没改过的内置工作流副本（用户机器上已经装过旧版）。
 * 判定按 origin + 语义比较：只有旧副本和 LEGACY_WORKFLOWS 里的旧定义一致时才升级，保留 id、名称、
 * 分类、标签等本机字段；用户改过的副本不动。
 * 升级后结构不再匹配旧定义，重复启动不会重复改（幂等）。
 */
export async function upgradeBuiltinWorkflows(state: BuiltinState, api: BuiltinOps): Promise<Workflow[]> {
  if (!api.updateWorkflow) return []
  const out: Workflow[] = []
  for (const w of BUILTIN_WORKFLOWS) {
    const cur = state.workflows.find((x) => x.origin === originOf(w.key))
    if (!cur) continue
    const legacy = LEGACY_WORKFLOWS[w.key]
    if (!legacy?.length) continue
    const agentId = (key: string) => findBuiltin(state.agents, key)?.id ?? ''
    const hit = legacy.find((l) => matchesLegacy(cur, l, agentId))
    if (!hit) continue
    const built = buildWorkflow(w, agentId)
    // 用户可能调过坐标：按流程 id + 节点 id 沿用原来的位置
    const flows = built.flows.map((f) => {
      const old = cur.flows.find((x) => x.id === f.id)
      if (!old) return f
      const pos = new Map(old.nodes.map((n) => [n.id, n]))
      return {
        ...f,
        startPos: old.startPos,
        endPos: old.endPos,
        nodes: f.nodes.map((n) => {
          const o = pos.get(n.id)
          return o ? { ...n, x: o.x, y: o.y } : n
        }),
      }
    })
    const { id, createdAt, updatedAt, ...rest } = cur
    const next = await api.updateWorkflow(id, {
      ...rest,
      description: built.description,
      mainAgentId: built.mainAgentId,
      entryFlowId: built.entryFlowId,
      document: built.document,
      expose: built.expose,
      flows,
    })
    if (next) out.push(next)
  }
  return out
}

/**
 * 本机没改过的旧「通用项目」升级成合并后的主流程。
 * 已在 upgradeBuiltinWorkflows 里按 LEGACY_WORKFLOWS 做过通用处理；这里保留给旧调用方，
 * 语义一致时返回 null（已经升级过或结构不匹配）。
 */
export async function migrateGeneralWorkflow(state: BuiltinState, api: BuiltinOps): Promise<Workflow | null> {
  if (!api.updateWorkflow) return null
  const cur = state.workflows.find((w) => w.origin === GENERAL_ORIGIN)
  if (!cur || !isLegacyGeneral(cur, state.agents)) return null
  const agentId = (key: string) => findBuiltin(state.agents, key)?.id ?? ''
  const built = buildWorkflow(GENERAL, agentId)
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
 * 启动时确保五个必备角色（统筹、执行、文档、测试验收、子任务）都在，并按内置定义同步一遍（见 ./core.ts）：
 * 缺的建出来，已有的把名称、设定、Skill、能力、参数定义换成当前版本，保留用户填的参数值和运行配置。
 * 没有变化的不写盘，重复启动不会反复改文件。
 */
export async function ensureProjectAgents(state: BuiltinState, api: BuiltinOps) {
  const ctx = context(state, api)
  await ctx.createAgents([...builtinAgentKeys(GENERAL), ...CORE_AGENTS.map((c) => c.key)])
  const synced: Agent[] = []
  if (api.updateAgent) {
    const categoryId = await ctx.category(CORE_CATEGORY, 'agent')
    for (const { key } of CORE_AGENTS) {
      const cur = findBuiltin(ctx.agents, key)
      if (!cur) continue
      const def = coreDefinition(key)
      const includes = def.includes.map((k) => findBuiltin(ctx.agents, k)?.id ?? '').filter(Boolean)
      const next = syncCore(cur, def, { categoryId, includes })
      // 用户自己有同名的角色时保留建出来时加了后缀的名字，免得派活时按名字认错
      if (ctx.agents.some((a) => a.id !== cur.id && a.name === next.name)) next.name = cur.name
      if (sameCore(cur, next)) continue
      const { id, createdAt: _c, updatedAt: _u, ...rest } = { ...cur, ...next }
      const saved = await api.updateAgent(id, rest)
      if (saved) {
        synced.push(saved)
        ctx.agents.splice(ctx.agents.indexOf(cur), 1, saved)
      }
    }
  }
  return { created: ctx.created, synced, newCategories: ctx.newCategories, newTags: ctx.newTags }
}

/**
 * 启动时安装一次项目用的内置工作流（「通用项目」「UE 项目」）：同名或同来源的跳过，不覆盖用户改过的。
 * 再把本机没改过的旧副本升级到新定义（工作流节点引用、Agent 的角色设定和参数），旧副本引用了
 * 已合并的 Agent 时仍能运行，结果里由调用方提示。
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
  // 本机还有已合并的旧副本、却没有合并目标时（例如只装过「Bug 修复」，没有「开发」）先把目标建出来，下面才能重定向
  const targets = Object.entries(MERGED_AGENTS)
    .filter(([key, m]) => findBuiltin(cur.agents, key) && !findBuiltin(cur.agents, m.into))
    .map(([, m]) => m.into)
  if (targets.length) {
    const r = await addBuiltinAgents(targets, cur, api)
    cur = {
      ...cur,
      agents: [...cur.agents, ...r.created],
      categories: [...cur.categories, ...r.newCategories],
      tags: [...cur.tags, ...r.newTags],
    }
  }
  const upgradedAgents = await upgradeBuiltinAgents(cur, api)
  if (upgradedAgents.length)
    cur = { ...cur, agents: cur.agents.map((a) => upgradedAgents.find((x) => x.id === a.id) ?? a) }
  const noted = await annotateMergedAgents(cur, api)
  if (noted.length) cur = { ...cur, agents: cur.agents.map((a) => noted.find((x) => x.id === a.id) ?? a) }
  const updated = await upgradeBuiltinWorkflows(cur, api)
  if (updated.length) cur = { ...cur, workflows: cur.workflows.map((w) => updated.find((x) => x.id === w.id) ?? w) }
  // 用户改过、没自动升级的副本：至少把指向已合并 Agent 的引用换掉，保证还能跑
  const redirected = await redirectMergedWorkflows(cur, api)
  if (redirected.length)
    cur = { ...cur, workflows: cur.workflows.map((w) => redirected.find((x) => x.id === w.id) ?? w) }
  return { state: cur, created, updated }
}

/**
 * 没改过的旧内置 Agent 升级到新定义：只按 origin 找，并且角色设定、名称、简介和某个旧指纹完全一致才升级。
 * 旧指纹分两处：LEGACY_AGENT_FIELDS 是最早的一版，LEGACY_AGENT_FIELDS_MORE 是后来的各个已发布版本，
 * 停在任一版的副本都能升级。用户改过、或者已经升级过（名字变了）的保留原样，重复启动不会重复改。
 * 参数、Skill 一起换成新定义；ID、分类、标签、引入关系、能力开关保留本机的。
 */
export async function upgradeBuiltinAgents(state: BuiltinState, api: { updateAgent?: BuiltinOps['updateAgent'] }) {
  if (!api.updateAgent) return []
  const out: Agent[] = []
  for (const b of BUILTIN_AGENTS) {
    const olds = [LEGACY_AGENT_FIELDS[b.key], ...(LEGACY_AGENT_FIELDS_MORE[b.key] ?? [])].filter(Boolean)
    const cur = findBuiltin(state.agents, b.key)
    if (!olds.length || !cur) continue
    const untouched = olds.some(
      (old) =>
        cur.name === old.name &&
        cur.description === old.description &&
        cur.instructions.trim() === old.instructions.trim(),
    )
    if (!untouched) continue
    const next = await api.updateAgent!(cur.id, {
      ...cur,
      name: b.agent.name,
      description: b.agent.description,
      instructions: b.agent.instructions,
      params: b.agent.params,
      skills: b.agent.skills,
      common: b.agent.common,
      enabled: cur.enabled,
    })
    if (next) out.push(next)
  }
  return out
}

/**
 * 已合并的内置 Agent 在本机还有副本时，给简介补一句说明（幂等）。
 * 旧工作流可能还在引用它们，所以不删除；用户看到简介就知道去哪找新的角色。
 */
export async function annotateMergedAgents(state: BuiltinState, api: { updateAgent?: BuiltinOps['updateAgent'] }) {
  if (!api.updateAgent) return []
  const out: Agent[] = []
  for (const [key, m] of Object.entries(MERGED_AGENTS)) {
    const cur = findBuiltin(state.agents, key)
    if (!cur) continue
    const note = `（${m.note}）`
    if (cur.description.includes(note)) continue
    const next = await api.updateAgent(cur.id, {
      ...cur,
      description: `${cur.description}${cur.description ? ' ' : ''}${note}`.slice(0, 200),
    })
    if (next) out.push(next)
  }
  return out
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
