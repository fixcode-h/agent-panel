import type { Agent, Category, Tag, Workflow } from '@shared/schema'
import { BUILTIN_AGENTS, type BuiltinAgent } from '@shared/builtin/agents'
import { buildWorkflow, builtinAgentKeys, type BuiltinWorkflow } from '@shared/builtin/workflows'
import { api } from './api'

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

/** 工作流用到的内置 Agent，加上它们引入的（例如「通用约束」） */
function neededAgents(w: BuiltinWorkflow): BuiltinAgent[] {
  const keys = new Set(builtinAgentKeys(w))
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
  neededAgents(w).filter((b) => !findBuiltin(agents, b.key))

/**
 * 添加一个内置工作流：缺的内置 Agent 先建出来（按分类放好、引用好 Skill），已有的直接复用（你改过的设定不会被覆盖），
 * 再按模板建工作流。返回新建的东西，调用方据此更新页面上的数据。
 */
export async function addBuiltinWorkflow(w: BuiltinWorkflow, state: BuiltinState) {
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
  const tagId = await tag(BUILTIN_TAG)

  // 先把要用的分类建好
  let todo = missingAgents(w, agents)
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

  const names = new Set(state.workflows.map((x) => x.name))
  let name = w.name
  for (let i = 2; names.has(name); i++) name = `${w.name} ${i}`
  const workflow = await api.createWorkflow({
    ...buildWorkflow(w, (key) => findBuiltin(agents, key)?.id ?? ''),
    name,
    categoryId: await category(w.category, 'workflow'),
    tags: [tagId],
  })
  return { workflow, created, newCategories, newTags }
}
