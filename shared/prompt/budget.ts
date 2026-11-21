import { AgentInput, type Agent, type Task } from '../schema.ts'
import { BUILTIN_AGENTS } from '../builtin/agents.ts'
import { builtinMounts } from '../builtin/core.ts'
import { composeRole } from '../agents/role.ts'
import { runEngineTurn } from '../engine/index.ts'
import type { EngineHost } from '../engine/host.ts'
import { newTask } from '../task.ts'
import { estimateTokens } from '../mcp-catalog/cost.ts'

/**
 * 提示词预算（设计稿 designs/Agent写代码能力-提升与扩展分析.md 的 D1）：把每个内置角色在几种典型情况下
 * 交给模型的提示词渲染出来、数字数。每修一个 Agent 行为问题就往角色设定里加一段，基础提示词只会越来越长，
 * 弱模型对每一条的遵守都会变差；scripts/prompt-budget.mjs 拿它和基线比，变长了 lint 失败，变短了收紧基线。
 *
 * 只算面板自己拼的部分：角色设定（composeRole，进系统提示词）和对话新会话第一轮的消息（runEngineTurn 交给 CLI 的那一段）。
 * 服务端再补的（编排说明、项目教训、插件提示）和项目有关，不在这里算
 */

export interface BudgetCase {
  id: string
  chars: number
  tokens: number
}

const PROMPT = '把登录页的「记住我」改成默认勾选'

/** 内置角色装成本机的样子：id 和来源都是 builtin:<key>，引入、挂载按 key 接上 */
export function builtinAgentSet(): Agent[] {
  const id = (key: string) => `builtin:${key}`
  const keys = new Set(BUILTIN_AGENTS.map((b) => b.key))
  return BUILTIN_AGENTS.map((b) => ({
    ...AgentInput.parse({
      ...b.agent,
      includes: b.includes.map(id),
      mounts: builtinMounts(b, (k) => (keys.has(k) ? id(k) : undefined)),
      origin: id(b.key),
    }),
    id: id(b.key),
    createdAt: '',
    updatedAt: '',
  }))
}

/** 一种典型情况：顶层 / 子对话、Git / P4、普通项目 / UE */
interface Scenario {
  id: string
  /** 只算顶层对话的角色（协调器）跳过子对话的情况 */
  sub?: boolean
  vcs?: 'git' | 'p4'
  ue?: boolean
  /** 项目接了 JetBrains IDE 的 MCP 服务（Lua 项目常见） */
  ide?: boolean
}

const SCENARIOS: Scenario[] = [
  { id: '顶层·Git' },
  { id: '顶层·P4', vcs: 'p4' },
  { id: '顶层·UE', ue: true },
  { id: '顶层·UE·IDE', ue: true, ide: true },
  { id: '子对话·Git', sub: true },
  { id: '子对话·UE', sub: true, ue: true },
]

/** 跑一轮假的对话，拿到交给 CLI 的那一段（新会话第一轮，完整的，不是增量） */
async function turnPrompt(agents: Agent[], agentId: string, s: Scenario): Promise<string> {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId, prompt: PROMPT } as never, undefined, '', 't'),
    id: 't',
    ...(s.sub ? { parentTaskId: 'parent', rootTaskId: 'parent' } : {}),
  } as Task
  let prompt = ''
  let n = 0
  const host: EngineHost = {
    task,
    agents,
    workflows: [],
    prompt: PROMPT,
    changed: () => {},
    newId: () => `id${++n}`,
    policy: { push: 'ask', tools: [], vcs: s.vcs ?? 'git' },
    ...(s.ue ? { ueBuild: { role: s.sub ? 'child' : 'parent', request: async () => ({ ok: true, info: '' }) } } : {}),
    ...(s.ide
      ? {
          ideMcpServers: [
            {
              server: 'idea',
              router: true,
              params: { lua_code: [{ name: 'action', type: 'search | files | outline', required: true }] },
            },
          ],
        }
      : {}),
    runAgent: async (call) => {
      if (!prompt && !call.step) prompt = call.fresh ?? call.prompt
      return { ok: true, text: '好了' }
    },
  }
  await runEngineTurn(host)
  return prompt
}

const measure = (id: string, text: string): BudgetCase => ({ id, chars: text.length, tokens: estimateTokens(text) })

/** 对话里常用的几个角色，各情况都算；协调器只当顶层对话 */
const TURN_ROLES = ['orchestrator', 'worker', 'developer', 'analyzer']
const TOP_ONLY = new Set(['orchestrator']) // 模块状态：常量，加载后不改

export async function promptBudgetCases(): Promise<BudgetCase[]> {
  const agents = builtinAgentSet()
  const out: BudgetCase[] = []
  const roles = new Map<string, string>()
  for (const a of agents) {
    const text = composeRole(a, agents)
    roles.set(a.id, text)
    out.push(measure(`角色/${a.name}`, text))
  }
  for (const key of TURN_ROLES) {
    const a = agents.find((x) => x.id === `builtin:${key}`)
    if (!a) continue
    for (const s of SCENARIOS) {
      if (s.sub && TOP_ONLY.has(key)) continue
      // 角色设定 + 第一轮的消息：新会话里模型一开始就要读完的部分
      const turn = await turnPrompt(agents, a.id, s)
      out.push(measure(`合计/${a.name}/${s.id}`, `${roles.get(a.id) ?? ''}\n\n${turn}`))
    }
  }
  return out
}
