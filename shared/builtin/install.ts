import {
  WorkflowInput,
  type Agent,
  type AgentInput,
  type Category,
  type Project,
  type ProjectCategory,
  type Tag,
  type TagInput,
  type Workflow,
} from '../schema.ts'
import { contentHash } from '../hash.ts'
import { COMMON_AGENT_KEYS, CORE_CATEGORY, type BuiltinAgent } from './agents.ts'
import { builtinAgents, builtinWorkflows } from './catalog.ts'
import { DEFAULT_WORKFLOW_ID } from './default.ts'
import {
  CORE_AGENTS,
  builtinMounts,
  coreDefinition,
  sameCore,
  syncCore,
  upgradeParamDefaults,
  upgradeRunIn,
} from './core.ts'
import { MERGED_AGENTS, mergedParams, type MergedAgent } from './merged.ts'
import {
  buildWorkflow,
  builtinAgentKeys,
  GENERAL,
  GENERAL_KEY,
  GENERAL_NAME,
  GENERAL_ORIGIN,
  RETIRED_WORKFLOWS,
  UE_PROJECT_KEY,
  type BuiltinWorkflow,
} from './workflows.ts'

/**
 * 把内置工作流、内置 Agent 建进数据：自带工作流启动时全部自动装一次（用到的角色随之建好，见 seedProjectWorkflows），
 * 用户删掉的可以在工作流页的「内置工作流」里再添加回来。怎么新建（接口还是测试里的内存）由调用方传进 ops。
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

/** 内置角色依赖的其他内置角色：引入的（例如「通用约束」）和挂载的能力，建它之前先建好 */
const depsOf = (b: Pick<BuiltinAgent, 'includes' | 'mounts'>) => [...b.includes, ...b.mounts.map((m) => m.key)]

/** 挂载的 key 换成本机的 id；本机没有的能力跳过 */
const mountIds = (b: BuiltinAgent, agents: Agent[]) => builtinMounts(b, (k) => findBuiltin(agents, k)?.id)

/** 这些内置 Agent，加上它们引入的、挂载的 */
function withIncludes(start: string[]): BuiltinAgent[] {
  const keys = new Set(start)
  for (let changed = true; changed;) {
    changed = false
    for (const k of [...keys])
      for (const inc of depsOf(builtinAgents().find((a) => a.key === k) ?? { includes: [], mounts: [] }))
        if (!keys.has(inc)) {
          keys.add(inc)
          changed = true
        }
  }
  return builtinAgents().filter((a) => keys.has(a.key))
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
      const ready = todo.filter((b) => depsOf(b).every((k) => !todo.some((x) => x.key === k)))
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
          mounts: mountIds(b, agents),
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
  const input: WorkflowInput = {
    ...buildWorkflow(w, (key) => findBuiltin(agents, key)?.id ?? ''),
    name,
    categoryId: await category(w.category, 'workflow'),
    tags: [tagId],
    origin: originOf(w.key),
  }
  const workflow = await api.createWorkflow({ ...input, builtinHash: workflowFingerprint(input) })
  return { workflow, created, newCategories, newTags }
}

/** 「通用项目」「UE 项目」：项目默认流程要用，本机没有时每次启动都补上；其余自带工作流只自动装一次 */
const ALWAYS_SEEDED = new Set([GENERAL_KEY, UE_PROJECT_KEY])

/**
 * 内置工作流副本的内容指纹：只算升级会换掉的部分（说明、主 Agent、入口、文档、暴露项、流程），
 * 先按 schema 解析补齐默认值，坐标不算（用户拖动节点不算改过）。
 */
export function workflowFingerprint(w: WorkflowInput) {
  const x = WorkflowInput.parse(w)
  return contentHash({
    description: x.description,
    mainAgentId: x.mainAgentId,
    entryFlowId: x.entryFlowId,
    document: x.document.trim(),
    expose: x.expose,
    // ADR 0044 加的挑选字段：只在填了时算进指纹，加字段之前记下的指纹照样对得上（不然没改过的副本都算改过、不再升级）
    ...(x.when && { when: x.when }),
    ...(x.notFor && { notFor: x.notFor }),
    ...(x.kind && { kind: x.kind }),
    flows: x.flows.map(({ startPos: _s, endPos: _e, ...f }) => ({
      ...f,
      nodes: f.nodes.map(({ x: _x, y: _y, ...n }) => n),
    })),
  })
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
export function agentInUse(id: string, state: BuiltinState, projects: Pick<Project, 'defaultAgentId'>[]) {
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
/**
 * 去掉简介末尾的合并说明。说明里的角色名会随合并目标改名，所以按形状认（从「已合并到」到结尾），
 * 不只认当前这一句：否则改过名字的旧副本永远匹配不上指纹，也不会更新成新的说明。
 */
const stripMergedNote = (description: string) => {
  const m = description.match(/（已合并到.*）$/s)
  return (m ? description.slice(0, m.index) : description).trim()
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
    if (agentInUse(cur.id, state, projects)) continue
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
 * 内置工作流的定义更新了，就把本机副本换成新版（用户 2026-10-25 定「内置只留一份、更新时覆盖」，2026-11-12 定改过的也直接覆盖、不备份）。
 * 保留 id、名称、分类、标签、坐标等本机字段。副本上的 builtinHash 记着上次写进去的是哪一版：
 * 和当前定义一样说明定义没更新，用户之后改的留着；不一样（定义更新了，或者是没记过指纹的老副本）就覆盖成新版。
 * 升级后指纹更新成新内容，重复启动不会重复改（幂等）。
 */
export async function upgradeBuiltinWorkflows(state: BuiltinState, api: BuiltinOps): Promise<Workflow[]> {
  if (!api.updateWorkflow) return []
  const out: Workflow[] = []
  for (const w of builtinWorkflows()) {
    const cur = state.workflows.find((x) => x.origin === originOf(w.key))
    if (!cur) continue
    const agentId = (key: string) => findBuiltin(state.agents, key)?.id ?? ''
    const { id, createdAt, updatedAt, ...rest } = cur
    const mine = workflowFingerprint(rest)
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
    const input: WorkflowInput = {
      ...rest,
      description: built.description,
      mainAgentId: built.mainAgentId,
      entryFlowId: built.entryFlowId,
      document: built.document,
      expose: built.expose,
      when: built.when,
      notFor: built.notFor,
      kind: built.kind,
      flows,
    }
    const latest = workflowFingerprint(input)
    if (latest === mine) {
      // 已经是当前版本：没记过指纹的补记一次，之后改没改过就能直接判断
      if (cur.builtinHash !== mine) {
        const next = await api.updateWorkflow(id, { ...rest, builtinHash: mine })
        if (next) out.push(next)
      }
      continue
    }
    // 内置定义没变过（上次写进副本的就是这一版）：用户在这之后改的留着
    if (cur.builtinHash === latest) continue
    const next = await api.updateWorkflow(id, { ...input, builtinHash: latest })
    if (next) out.push(next)
  }
  return out
}

/**
 * 启动时确保九个必备角色（协调器、执行、文档、评审、测试验收、版本控制、子任务、分析，加上 Chat 页的助手）都在，并按内置定义同步一遍（见 ./core.ts）：
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
      const mounts = mountIds(def, ctx.agents)
      const next = upgradeRunIn(upgradeParamDefaults(syncCore(cur, def, { categoryId, includes, mounts }), key), key)
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
 * 启动时装上自带工作流（用户 2026-10-25 改成默认全部加入，不再手动添加）：同名或同来源的跳过，不覆盖用户改过的。
 * seeded 是已经自动装过的 key（调用方存盘）：装过一次的、用户后来删掉的不再装回来，只有「通用项目」「UE 项目」缺了就补；
 * 以后新加的自带工作流不在 seeded 里，下次启动自动装上。
 * 再把内置角色换成当前定义（改过的也直接覆盖），定义更新过的内置工作流副本换成新版，旧副本引用了
 * 已合并的 Agent 时仍能运行，结果里由调用方提示。
 * 返回装完后的数据和新的 seeded，调用方据此更新集合。
 */
export async function seedProjectWorkflows(state: BuiltinState, api: BuiltinOps, seeded: string[] = []) {
  const rest = builtinWorkflows().filter(
    (w) =>
      (ALWAYS_SEEDED.has(w.key) || !seeded.includes(w.key)) &&
      !state.workflows.some((x) => x.origin === originOf(w.key) || x.name === w.name),
  )
  let cur = state
  let created: Workflow[] = []
  if (rest.length) {
    const seeded = await seedBuiltins(state, api, rest)
    cur = seeded
    created = seeded.workflows.filter((w) => !state.workflows.some((x) => x.id === w.id))
  }
  // 本机还有已合并的旧副本、却没有合并目标时（例如只装过「Bug 修复」，没有「开发」）先把目标建出来，下面才能重定向。
  // 合并目标是插件带的（例如 Blender 建模，ADR 0059）而插件没开时不建：旧副本由插件的清理规则处理
  const targets = Object.entries(MERGED_AGENTS)
    .filter(
      ([key, m]) =>
        findBuiltin(cur.agents, key) &&
        !findBuiltin(cur.agents, m.into) &&
        builtinAgents().some((b) => b.key === m.into),
    )
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
  const nextSeeded = [...new Set([...seeded, ...builtinWorkflows().map((w) => w.key)])]
  return { state: cur, created, updated, seeded: nextSeeded, upgradedAgents }
}

/**
 * 合并掉的内置工作流（RETIRED_WORKFLOWS）：本机副本和合并前的定义一致（没改过）、接替的工作流本机也有时，
 * 返回要删的副本和接替它的本机工作流 id。用户改过的副本（或没记过指纹、认不出改没改过的老副本）、接替的被删掉了的，都留着不动。
 */
export function retiredWorkflows(state: Pick<BuiltinState, 'agents' | 'workflows'>) {
  const out: { workflow: Workflow; into: string }[] = []
  for (const [key, intoKey] of Object.entries(RETIRED_WORKFLOWS)) {
    const into = state.workflows.find((w) => w.origin === originOf(intoKey))
    if (!into) continue
    for (const w of state.workflows.filter((x) => x.origin === originOf(key)))
      if (untouchedCopy(w)) out.push({ workflow: w, into: into.id })
  }
  return out
}

/**
 * 删掉的工作流在项目和项目分类里的引用改指到接替的工作流：默认工作流、可选列表（去重）、按工作流存的暴露项取值
 * （接替的那个没有取值时才搬过去）。返回要改的项目和分类，没有引用的不返回。
 */
export function redirectWorkflowRefs(
  projects: Project[],
  categories: ProjectCategory[],
  moved: Record<string, string>,
) {
  const to = (id: string) => moved[id] ?? id
  const projectUpdates: Project[] = []
  for (const p of projects) {
    const hit =
      moved[p.workflowId] ||
      p.workflowIds.some((id) => moved[id]) ||
      Object.keys(p.workflowParams).some((id) => moved[id])
    if (!hit) continue
    const workflowParams = { ...p.workflowParams }
    for (const [from, into] of Object.entries(moved)) {
      if (!(from in workflowParams)) continue
      if (!(into in workflowParams)) workflowParams[into] = workflowParams[from]
      delete workflowParams[from]
    }
    const ids = p.workflowIds.map(to)
    projectUpdates.push({
      ...p,
      workflowId: p.workflowId && to(p.workflowId),
      workflowIds: ids.filter((id, i) => ids.indexOf(id) === i),
      workflowParams,
    })
  }
  const categoryUpdates = categories
    .filter((c) => !!moved[c.workflowId])
    .map((c) => ({ ...c, workflowId: to(c.workflowId) }))
  return { projects: projectUpdates, categories: categoryUpdates }
}

/**
 * 内置工作流副本是不是没改过：内容还是上次面板写进去的那一版（builtinHash）。没记过指纹的老副本当作改过，
 * 删除类的清理（合并掉的、插件带的）不动它
 */
export function untouchedCopy(w: Workflow) {
  if (!w.builtinHash) return false
  const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = w
  return w.builtinHash === workflowFingerprint(rest)
}

/**
 * 内置角色按当前定义同步（用户 2026-10-25 定的「一律强制覆盖」，见 core.ts 的 builtinKey）：
 * 名称、简介、图标、角色设定、Skill、能力、参数定义、引入关系都换成当前版本；
 * 参数取值、运行配置（CLI、模型、强度、权限、额外参数、开场白）、分类、标签、启用开关留本机的。
 * 以前按「和某个历史版本逐字一致才升级」判断，历史版本漏登记一次副本就永远卡在旧版，所以不再判断。
 * 用户自己改过的设定也直接覆盖，不备份（用户 2026-11-12 定的）。
 * 必备角色的分类、一次性默认值升级由 ensureProjectAgents 再做一遍。没有变化的不写盘，重复启动不改文件。
 */
export async function upgradeBuiltinAgents(state: BuiltinState, api: { updateAgent?: BuiltinOps['updateAgent'] }) {
  if (!api.updateAgent) return []
  const out: Agent[] = []
  const agents = [...state.agents]
  for (const b of builtinAgents()) {
    const cur = findBuiltin(agents, b.key)
    if (!cur) continue
    const includes = b.includes.map((k) => findBuiltin(agents, k)?.id ?? '').filter(Boolean)
    const next = syncCore(cur, b, { categoryId: cur.categoryId, includes, mounts: mountIds(b, agents) })
    // 用户自己有同名的角色时保留建出来时加了后缀的名字，免得派活时按名字认错
    if (agents.some((a) => a.id !== cur.id && a.name === next.name)) next.name = cur.name
    if (sameCore(cur, next)) continue
    const { id, createdAt: _c, updatedAt: _u, ...rest } = { ...cur, ...next }
    const saved = await api.updateAgent(id, rest)
    if (saved) {
      out.push(saved)
      agents.splice(agents.indexOf(cur), 1, saved)
    }
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
    const head = stripMergedNote(cur.description)
    const next = `${head}${head ? ' ' : ''}${note}`.slice(0, 200)
    if (cur.description === next) continue
    const saved = await api.updateAgent(cur.id, { ...cur, description: next })
    if (saved) out.push(saved)
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
export async function seedBuiltins(state: BuiltinState, api: BuiltinOps, list = builtinWorkflows()) {
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
