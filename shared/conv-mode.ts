/**
 * 对话分两种（ADR 0037、0038）：Chat 页的对话一问一答，用 Chat 角色；项目里的对话是 Agent 模式，用 Agent 角色，
 * 面板推着它把事做完。角色分两类（Agent.scope），各自只在对应模式里用；这里放模式规则和类别校验。
 * 放在单独的文件里：shared/task.ts、engine.ts 都到了行数上限
 */
import { defaultAgent, type Agent, type AgentInput, type Task, type WorkflowInput } from './schema.ts'
import { t } from './i18n.ts'

type ModeOf = Pick<Task, 'mode' | 'projectId'> & { parentTaskId?: string }

/**
 * Chat 模式：Chat 页的对话（没有项目的顶层对话）。只用于模式规则（推进次数、一问一答、角色类别、能力上限：
 * 不派子任务、不开子对话、不跑工作流）；推送授权、教训这类「有没有项目」的客观条件直接看 projectId（ADR 0038）
 */
export const isChatMode = (tk: ModeOf) => tk.mode === 'chat' && !tk.projectId && !tk.parentTaskId

/** Agent 模式的顶层对话同一个进度最多推几次（ADR 0037）；子对话推不动会上报父对话、Chat 页一问一答，都只推一次 */
export const AGENT_NUDGE_MAX = 3
export const nudgeMax = (tk: ModeOf) => (tk.parentTaskId || isChatMode(tk) ? 1 : AGENT_NUDGE_MAX)

/**
 * 面板推对话「接着做」的计数：key 是进度（计划 id + 已完成几步，或「said:用户消息 id」），进度变了从 1 重新数。
 * 返回推完之后的记录（n 是这是第几次）；推满了返回 null
 */
export function nextNudge(prev: { key: string; n: number } | undefined, key: string, max: number) {
  const n = prev?.key === key ? prev.n + 1 : 1
  return n > max ? null : { key, n }
}

export type RoleScope = 'agent' | 'chat'

/** 角色的类别：旧数据没有这个字段，一律当 Agent 角色 */
export const scopeOf = (a: Pick<AgentInput, 'scope'> | undefined): RoleScope => a?.scope ?? 'agent'

/** 这个对话该用哪一类角色 */
export const modeScope = (tk: ModeOf): RoleScope => (isChatMode(tk) ? 'chat' : 'agent')

/** 内置「助手」的来源：Chat 页没选角色的对话（agentId 为空）都按它跑 */
export const CHAT_ORIGIN = 'builtin:chat'

/**
 * Chat 模式里没选角色（agentId 为空）的对话按内置「助手」跑：取它的设定、引入、参数、Skill；
 * 运行配置（CLI、模型、强度）仍按对话自己选的，所以 id 保持空字符串（canPickRun 照旧为真，Chat 页随时换模型）。
 * 旧对话不迁移，下一轮起就是助手；本机没有助手（演示数据、同步失败）时返回 undefined，退回无角色
 */
export function chatRoleFor(task: ModeOf & Pick<Task, 'agentId'>, agents: Agent[]): Agent | undefined {
  if (!isChatMode(task) || task.agentId) return undefined
  const c = agents.find((a) => a.origin === CHAT_ORIGIN)
  if (!c) return undefined
  const { instructions, includes, params, skills } = c
  return { ...defaultAgent(), id: '', name: '', description: '', instructions, includes, params, skills, scope: 'chat' }
}

/** agentId 为空时这一轮用的角色：Chat 模式是内置助手，项目里是「无角色」 */
export const emptyRole = (task: ModeOf & Pick<Task, 'agentId'>, agents: Agent[]): Agent =>
  chatRoleFor(task, agents) ?? { ...defaultAgent(), id: '', name: '', description: '' }

/**
 * 这一轮按 id 用的角色。Chat 模式里选的角色被删了（自建的 Chat 角色）：回退到内置「助手」接着聊，
 * 不报「找不到角色」——Chat 页没有别的东西依赖这个角色，换一个就能聊下去（运行时回退，不改对话；调用方记日志）。
 * 项目里的对话照旧返回 undefined，由调用方报错：项目对话的角色关系到分派、计划和工作流，不能悄悄换
 */
export function turnRole(task: ModeOf & Pick<Task, 'agentId'>, agents: Agent[], id: string): Agent | undefined {
  if (!id) return emptyRole(task, agents)
  return (
    agents.find((a) => a.id === id) ?? (isChatMode(task) ? chatRoleFor({ ...task, agentId: '' }, agents) : undefined)
  )
}

/**
 * 按 id 或名字找角色（spawn_agents 的 agent、create_conversation 的 role）：同名时先找这一类的。
 * Chat 角色和 Agent 角色可以同名（例如复制成另一类后又改回原名），只按名字找会先撞上另一类、报「是 Chat 角色」
 */
export function findRole<T extends Pick<Agent, 'id' | 'name' | 'scope'>>(
  agents: T[],
  want: string,
  scope: RoleScope,
  ok: (a: T) => boolean = () => true,
): T | undefined {
  const hit = (a: T) => ok(a) && (a.id === want || a.name === want)
  return agents.find((a) => hit(a) && scopeOf(a) === scope) ?? agents.find(hit)
}

/**
 * CLI 自带的待办（task.todos）什么时候收起：上一轮已经全部做完的，用户发下一条消息时清掉，
 * 不然「待办已完成」会一直挂在对话上（面板计划做完就收起，这里同一个口径）。没做完的留着，CLI 下一轮会接着更新
 */
export const settledTodos = <T extends { status: string }>(todos: T[] | undefined): T[] =>
  todos?.length && todos.every((x) => x.status === 'done') ? [] : (todos ?? [])

/**
 * 新建对话、换角色时的类别校验：Chat 模式只能用 Chat 角色，项目里的对话只能用 Agent 角色。
 * 例外只有面板开的「AI 分析」：归不到项目时开在 Chat，用必备角色「分析」（面板专用，受 Chat 模式的能力上限管）
 */
export function scopeError(
  tk: ModeOf & { analysis?: unknown },
  agent: Pick<Agent, 'name' | 'scope' | 'origin'> | undefined,
): string {
  if (tk.mode !== 'chat' || !agent) return ''
  const want = modeScope(tk)
  if (scopeOf(agent) === want) return ''
  if (want === 'chat' && tk.analysis && agent.origin === 'builtin:analyzer') return ''
  return want === 'chat'
    ? t('「{name}」是 Agent 角色，只能在项目里用；Chat 页请用 Chat 角色', { name: agent.name })
    : t('「{name}」是 Chat 角色，只能在 Chat 页用', { name: agent.name })
}

/**
 * 保存角色时按类别整理（服务端兜底，导入、AI 优化、手改 JSON 都会被纠正）：
 * Chat 角色不挂能力、不当通用角色、不分派、不跑工作流，这些字段一律归零；引入只留同一类的。
 * Agent 角色挂载的能力必须是 Agent 角色。返回错误原文，没问题返回空字符串
 */
export function normalizeScope(a: AgentInput, all: Pick<Agent, 'id' | 'name' | 'scope'>[]): string {
  const scope = scopeOf(a)
  const byId = new Map(all.map((x) => [x.id, x]))
  a.includes = a.includes.filter((id) => !byId.has(id) || scopeOf(byId.get(id)) === scope)
  if (scope === 'chat') {
    Object.assign(a, { common: false, canDelegate: false, canPlan: false, runIn: 'any', inlineEdit: 'off' })
    Object.assign(a, { mounts: [], mountsCustom: undefined, kind: 'advanced', when: '', independent: false })
    a.modes = ['inline', 'subtask']
    return ''
  }
  const bad = a.mounts.map((m) => byId.get(m.agentId)).find((x) => x && scopeOf(x) === 'chat')
  return bad ? t('「{name}」是 Chat 角色，不能挂载', { name: bad.name }) : ''
}

/** 项目默认角色、工作流的主角色 / 成员 / 节点 / 步骤都只能是 Agent 角色 */
export function agentOnlyError(ids: string[], all: Pick<Agent, 'id' | 'name' | 'scope'>[]): string {
  const bad = all.find((a) => scopeOf(a) === 'chat' && ids.includes(a.id))
  return bad ? t('「{name}」是 Chat 角色，只能在 Chat 页用', { name: bad.name }) : ''
}

/** 工作流里引用的全部角色 id */
export const workflowAgentIds = (wf: Pick<WorkflowInput, 'mainAgentId' | 'members' | 'flows'>) => [
  wf.mainAgentId,
  ...wf.members.map((m) => m.agentId),
  ...wf.flows.flatMap((f) => f.nodes.flatMap((n) => [n.agentId, ...n.steps.map((s) => s.agentId)])),
]
