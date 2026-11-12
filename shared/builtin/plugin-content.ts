import { type Agent, type Project, type ProjectCategory, type Workflow } from '../schema.ts'
import { t } from '../i18n.ts'
import type { PluginManifest } from '../plugins/types.ts'
import {
  addBuiltinAgents,
  addBuiltinWorkflow,
  agentInUse,
  untouchedCopy,
  type BuiltinOps,
  type BuiltinState,
} from './install.ts'

/**
 * 插件带的内置角色和工作流在本机的副本（ADR 0059）：打开插件时装上，关掉时清掉没改过、没人用的。
 * 副本按来源 builtin:<key> 认，和核心的内置模板同一套规则，所以老用户在插件出现之前装的 Blender 副本也照样认得出。
 */

const originOf = (key: string) => `builtin:${key}`

/**
 * 打开插件：插件的工作流按「添加内置工作流」建出来（缺的角色一起建），已有同来源副本的跳过。
 * 不看「自动装过」的记录：用户主动打开插件，就是要这些东西，以前删过的也装回来。
 */
export async function addPluginContent(plugin: PluginManifest, state: BuiltinState, api: BuiltinOps) {
  const cur: BuiltinState = {
    agents: [...state.agents],
    categories: [...state.categories],
    tags: [...state.tags],
    workflows: [...state.workflows],
  }
  const workflows: Workflow[] = []
  const agents: Agent[] = []
  for (const w of plugin.workflows) {
    if (cur.workflows.some((x) => x.origin === originOf(w.key))) continue
    const r = await addBuiltinWorkflow(w, cur, api)
    cur.agents.push(...r.created)
    cur.categories.push(...r.newCategories)
    cur.tags.push(...r.newTags)
    cur.workflows.push(r.workflow)
    workflows.push(r.workflow)
    agents.push(...r.created)
  }
  // 没被工作流带上的角色（只给对话用的）也建出来
  const rest = plugin.agents.map((a) => a.key).filter((k) => !cur.agents.some((a) => a.origin === originOf(k)))
  if (rest.length) {
    const r = await addBuiltinAgents(rest, cur, api)
    agents.push(...r.created)
  }
  return { workflows, agents }
}

export interface PluginRemoval {
  /** 没改过、没人用：删掉（调用方先备份） */
  workflows: Workflow[]
  agents: Agent[]
  /** 改过或还被用着：保留，说明原因（插件页上提示） */
  kept: { kind: 'workflow' | 'agent'; id: string; name: string; why: string }[]
}

/** 项目、项目分类里有没有引用这个工作流（默认工作流、可选列表） */
const workflowRefs = (id: string, projects: Project[], categories: ProjectCategory[]) =>
  projects
    .filter((p) => p.workflowId === id || p.workflowIds.includes(id))
    .map((p) => p.name)
    .concat(categories.filter((c) => c.workflowId === id).map((c) => c.name))

/** 一组要清的内置副本（按来源 key）：插件带的角色和工作流，或者以前内置、后来挪进插件的 */
export interface ContentKeys {
  agents: string[]
  workflows: string[]
}
export const pluginKeys = (p: PluginManifest): ContentKeys => ({
  agents: p.agents.map((a) => a.key),
  workflows: p.workflows.map((w) => w.key),
})

/**
 * 以前面板内置、现在挪进插件的模板（ADR 0059）：插件没装或关着时，本机没改过、没人用的副本按同样的规则清掉。
 * 只是旧数据的来源 key，不是插件代码；插件装上并打开后照常按 builtin:<key> 认回去。
 */
export const MOVED_TO_PLUGINS: Record<string, ContentKeys> = {
  blender: { agents: ['blender', 'blenderqa'], workflows: ['blender'] },
}

/**
 * 关掉插件（或启动时插件关着）要清掉哪些副本：
 * - 工作流：没改过、项目和分类都没在用的删；
 * - 角色：删掉这些工作流之后没人再用（工作流、项目默认对话角色、其他角色的引入）的删。内置角色每次启动都按定义同步，
 *   设定上不存在「改过」，所以只看用没用。
 * 改过的、还在用的保留，原因写进 kept。只算不改，调用方据此删除和备份。
 */
export function planPluginRemoval(
  keys: ContentKeys,
  state: BuiltinState,
  projects: Project[],
  categories: ProjectCategory[],
): PluginRemoval {
  const out: PluginRemoval = { workflows: [], agents: [], kept: [] }
  for (const key of keys.workflows) {
    for (const w of state.workflows.filter((x) => x.origin === originOf(key))) {
      const refs = workflowRefs(w.id, projects, categories)
      if (refs.length)
        out.kept.push({
          kind: 'workflow',
          id: w.id,
          name: w.name,
          why: t('在用：{list}', { list: refs.join(t('、')) }),
        })
      else if (!untouchedCopy(w)) out.kept.push({ kind: 'workflow', id: w.id, name: w.name, why: t('改过') })
      else out.workflows.push(w)
    }
  }
  const gone = new Set(out.workflows.map((w) => w.id))
  const after: BuiltinState = { ...state, workflows: state.workflows.filter((w) => !gone.has(w.id)) }
  // 插件的角色之间互相引入时，一起删的不算「被用着」：每轮把还被留下的东西用着的剔出去，直到稳定
  let candidates = keys.agents.flatMap((key) => state.agents.filter((a) => a.origin === originOf(key)))
  for (let changed = true; changed;) {
    changed = false
    const removing = new Set(candidates.map((a) => a.id))
    for (const a of candidates) {
      const others = { ...after, agents: after.agents.filter((x) => x.id === a.id || !removing.has(x.id)) }
      if (!agentInUse(a.id, others, projects)) continue
      candidates = candidates.filter((x) => x.id !== a.id)
      out.kept.push({ kind: 'agent', id: a.id, name: a.name, why: t('在用') })
      changed = true
      break
    }
  }
  out.agents = candidates
  return out
}
