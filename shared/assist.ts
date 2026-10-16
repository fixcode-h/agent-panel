/**
 * AI 创建 / 优化：让本机 CLI 通过对话生成 Agent 或工作流。
 * 提示词里写明背景、可选值、创建规则和输出格式；CLI 回复里的 JSON 经过这里的校验，
 * 引用的 Agent、CLI、图标都换成真实的 id 后，才能应用到面板。
 */
import { z } from 'zod'
import { CLIS, getCli } from './clis.ts'
import { flowId } from './flow.ts'
import { AGENT_ICON_IDS } from './icons.ts'
import type { Agent, AgentInput, Category, Workflow, WorkflowInput } from './schema.ts'

export const AssistKind = z.enum(['agent', 'workflow'])
export type AssistKind = z.infer<typeof AssistKind>

export const AssistMessage = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().max(40000),
})
export type AssistMessage = z.infer<typeof AssistMessage>

export const AssistInput = z.object({
  kind: AssistKind,
  /** 优化已有的 Agent / 工作流时传它的 id；为空表示新建 */
  targetId: z.string().default(''),
  /** 用哪个 CLI 生成 */
  cli: z.string().min(1, '请选择 CLI'),
  /** 为空时用设置里这个 CLI 的默认模型 */
  model: z.string().trim().default(''),
  messages: z.array(AssistMessage).min(1).max(40),
})
export type AssistInput = z.infer<typeof AssistInput>

/** CLI 输出的 Agent 草稿：分类、CLI 用名字或 id 表示 */
export const AgentDraft = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(40, 'name 最多 40 个字'),
  description: z.string().trim().max(200).default(''),
  cli: z.string().trim().min(1, 'cli 不能为空'),
  model: z.string().trim().default(''),
  icon: z.string().trim().default('bot'),
  category: z.string().trim().default(''),
  instructions: z.string().max(8000).default(''),
})
export type AgentDraft = z.infer<typeof AgentDraft>

/** CLI 输出的工作流草稿：Agent 用名字引用，缺的 Agent 放在 newAgents 里一起创建 */
export const WorkflowDraft = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(40),
  description: z.string().trim().max(200).default(''),
  mainAgent: z.string().trim().min(1, 'mainAgent 不能为空'),
  members: z
    .array(z.object({ agent: z.string().trim().min(1), responsibility: z.string().trim().max(200).default('') }))
    .default([]),
  newAgents: z.array(AgentDraft).max(8).default([]),
  stages: z
    .array(
      z.object({
        title: z.string().trim().max(40).default(''),
        nodes: z
          .array(
            z.object({
              title: z.string().trim().min(1, '节点 title 不能为空').max(60),
              agent: z.string().trim().default(''),
              instructions: z.string().max(20000).default(''),
            }),
          )
          .min(1, '每个阶段至少一个节点'),
      }),
    )
    .min(1, '至少一个阶段')
    .max(30),
  document: z.string().max(50000).default(''),
})
export type WorkflowDraft = z.infer<typeof WorkflowDraft>

/** 校验通过、可以直接应用的结果 */
export type AgentProposal = {
  kind: 'agent'
  agent: AgentInput
  /** 分类不存在时会新建 */
  newCategory: string
}
export type WorkflowProposal = {
  kind: 'workflow'
  workflow: WorkflowInput
  /** 需要先创建的 Agent；workflow 里用 `new:<名称>` 引用它们 */
  newAgents: (AgentInput & { ref: string; newCategory: string })[]
}
export type Proposal = AgentProposal | WorkflowProposal

export interface AssistJob {
  id: string
  kind: AssistKind
  targetId: string
  status: 'running' | 'done' | 'failed'
  /** 去掉 JSON 代码块后的说明文字（执行中是已输出的部分） */
  text: string
  proposal?: Proposal
  /** CLI 给出的 JSON 原文，下一轮对话时带回给 CLI */
  raw?: string
  error?: string
  /** 第几次尝试（格式不对会自动让 CLI 修正一次） */
  attempt: number
}

export interface AssistContext {
  agents: Agent[]
  categories: Category[]
  workflows: Workflow[]
  /** 设置里用户补充的规则 */
  rules: string
  /** 优化时的当前内容 */
  target?: Agent | Workflow
}

const KIND_NAME = { agent: 'Agent', workflow: '工作流' }

const AGENT_RULES = `- name 简短，体现职责，例如「前端开发」「代码审查」；不要和已有 Agent 重名（优化时保留原名，除非用户要求改名）
- description 一句话说明它擅长什么，不超过 60 字
- cli 从「可用的 CLI」里选 id；没有特别要求时选已安装的；model 可以留空表示用设置里的默认模型
- icon 从「可选图标」里选最贴切的 id
- category 填已有分类的名称；确实没有合适的才写一个新名称，留空表示不分类
- instructions 是角色设定，会作为系统提示词发给 CLI，用 Markdown 写清楚：职责范围、工作方式、要遵守的约束、交付标准和完成后怎么汇报；不要写和具体项目无关的空话`

const WORKFLOW_RULES = `- 流程由阶段组成，阶段从左到右依次执行；同一阶段里的节点同时执行，全部完成后才进入下一阶段
- 互不依赖的工作（例如前端和后端、单元测试和文档）放在同一阶段并行；有先后依赖的拆成不同阶段
- 同一阶段的并行节点不要改同一批文件，instructions 里写清楚各自负责的范围
- 第一个阶段一般由主 Agent 分析需求、拆分任务；最后一个阶段一般由主 Agent 或审查类 Agent 验收
- 节点的 agent 写 Agent 名称，留空表示主 Agent；只能用「已有的 Agent」或 newAgents 里新建的 Agent
- members 列出除主 Agent 外参与流程的 Agent 和它在这个工作流里的职责；节点里用到的 Agent 都要在 members 里
- 已有的 Agent 能胜任就复用，确实缺少某种角色时才在 newAgents 里新建（字段和 Agent 草稿相同）
- 每个节点的 instructions 写清楚：要做什么、产出什么、完成标准
- document 是工作流说明（Markdown）：目标、规范、完成标准，每个节点执行时都会带上；不要在里面重复写步骤`

const AGENT_SHAPE = `{
  "name": "前端开发",
  "description": "实现 React 页面与交互，保证视觉还原",
  "cli": "claude",
  "model": "sonnet",
  "icon": "layout",
  "category": "开发",
  "instructions": "## 职责\\n…\\n## 工作方式\\n…\\n## 交付标准\\n…"
}`

const WORKFLOW_SHAPE = `{
  "name": "Web 功能开发",
  "description": "前后端一起改的常规功能需求",
  "mainAgent": "架构师",
  "members": [{ "agent": "前端开发", "responsibility": "页面与交互" }],
  "newAgents": [],
  "stages": [
    { "title": "分析", "nodes": [{ "title": "分析需求、拆分任务", "agent": "", "instructions": "…" }] },
    { "title": "开发", "nodes": [
      { "title": "实现接口", "agent": "后端开发", "instructions": "…" },
      { "title": "实现页面", "agent": "前端开发", "instructions": "…" }
    ] },
    { "title": "验收", "nodes": [{ "title": "验收", "agent": "", "instructions": "…" }] }
  ],
  "document": "# 目标\\n…\\n# 规范\\n…\\n# 完成标准\\n…"
}`

function agentLine(a: Agent, categories: Category[]) {
  const cat = categories.find((c) => c.id === a.categoryId)?.name
  return `- ${a.name}（${a.cli}${a.model ? ` / ${a.model}` : ''}${cat ? `，分类：${cat}` : ''}${a.enabled ? '' : '，已停用'}）：${a.description || '没有简介'}`
}

/** 把工作流转成和草稿相同的结构，优化时给 CLI 看 */
export function workflowToDraft(w: Workflow, agents: Agent[]): WorkflowDraft {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? ''
  return {
    name: w.name,
    description: w.description,
    mainAgent: name(w.mainAgentId),
    members: w.members.map((m) => ({ agent: name(m.agentId), responsibility: m.responsibility })),
    newAgents: [],
    stages: w.stages.map((s) => ({
      title: s.title,
      nodes: s.nodes.map((n) => ({ title: n.title, agent: name(n.agentId), instructions: n.instructions })),
    })),
    document: w.document,
  }
}

export function agentToDraft(a: Agent, categories: Category[]): AgentDraft {
  return {
    name: a.name,
    description: a.description,
    cli: a.cli,
    model: a.model,
    icon: a.icon,
    category: categories.find((c) => c.id === a.categoryId)?.name ?? '',
    instructions: a.instructions,
  }
}

/** 发给 CLI 的完整提示词（每次带上全部对话，不依赖 CLI 的会话） */
export function buildAssistPrompt(
  kind: AssistKind,
  ctx: AssistContext,
  messages: AssistMessage[],
  installed: string[],
) {
  const improving = !!ctx.target
  const what = KIND_NAME[kind]
  const clis = CLIS.map(
    (c) =>
      `- ${c.id}（${c.name}${installed.includes(c.id) ? '，已安装' : '，未安装'}）：常用模型 ${c.models.map((m) => m.id).join('、')}`,
  ).join('\n')
  const current = !ctx.target
    ? ''
    : kind === 'agent'
      ? JSON.stringify(agentToDraft(ctx.target as Agent, ctx.categories), null, 2)
      : JSON.stringify(workflowToDraft(ctx.target as Workflow, ctx.agents), null, 2)
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')

  return [
    `你是「Agent 面板」里的配置助手，正在和用户对话，帮他${improving ? '优化一个已有的' : '设计一个新的'}${what}。`,
    '只根据下面的信息回答。不要读写任何文件，也不要运行命令。',
    `## 背景
- Agent：一个可复用的「本机 CLI + 模型 + 角色设定」组合，执行任务时由面板在项目目录里调用对应 CLI。
- 工作流：一个主 Agent 和若干子 Agent 组成团队，用流程图编排：阶段依次执行，阶段内的节点并行。`,
    `## 可用的 CLI\n${clis}`,
    `## 可选图标\n${AGENT_ICON_IDS.map(([id, label]) => `${id}（${label}）`).join('、')}`,
    `## 已有的分类\n${ctx.categories.map((c) => c.name).join('、') || '（没有）'}`,
    `## 已有的 Agent\n${ctx.agents.map((a) => agentLine(a, ctx.categories)).join('\n') || '（没有）'}`,
    kind === 'workflow' && ctx.workflows.length
      ? `## 已有的工作流（避免重名）\n${ctx.workflows.map((w) => `- ${w.name}：${w.description || '没有简介'}`).join('\n')}`
      : '',
    improving ? `## 当前的${what}（在它的基础上按用户要求修改）\n\`\`\`json\n${current}\n\`\`\`` : '',
    `## 创建规则\n${kind === 'agent' ? AGENT_RULES : WORKFLOW_RULES}`,
    ctx.rules.trim() ? `## 用户补充的规则（优先遵守）\n${ctx.rules.trim()}` : '',
    `## 输出格式
先用两三句中文说明你的设计${improving ? '和改了哪些地方' : ''}；信息不够时可以说明你做的假设，但仍然要给出完整结果。
然后输出且只输出一个 \`\`\`json 代码块，内容是完整的${what}，严格符合下面的结构（字段名不能改，不要加注释）：
\`\`\`json
${kind === 'agent' ? AGENT_SHAPE : WORKFLOW_SHAPE}
\`\`\``,
    `## 对话\n${convo}`,
    `请回复用户最后一条消息。`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 取出回复里最后一个 JSON 代码块；没有代码块时取最外层的大括号 */
export function extractJson(text: string): { json?: unknown; rest: string; error?: string } {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  let raw = blocks.at(-1)?.[1]
  let rest = text
  if (raw !== undefined) rest = text.replace(blocks.at(-1)![0], '').trim()
  else {
    const a = text.indexOf('{')
    const b = text.lastIndexOf('}')
    if (a < 0 || b <= a) return { rest: text.trim(), error: '回复里没有 JSON 代码块' }
    raw = text.slice(a, b + 1)
    rest = (text.slice(0, a) + text.slice(b + 1)).trim()
  }
  try {
    return { json: JSON.parse(raw), rest }
  } catch (e) {
    return { rest, error: `JSON 解析失败：${(e as Error).message}` }
  }
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`).join('；')

function resolveAgent(d: AgentDraft, ctx: AssistContext): { agent?: AgentInput; newCategory: string; error?: string } {
  const cli = getCli(d.cli) ?? CLIS.find((c) => c.name.toLowerCase() === d.cli.toLowerCase())
  if (!cli) return { newCategory: '', error: `cli「${d.cli}」不存在，只能是 ${CLIS.map((c) => c.id).join(' / ')}` }
  const icon = AGENT_ICON_IDS.some(([id]) => id === d.icon) ? d.icon : 'bot'
  const cat = d.category ? ctx.categories.find((c) => c.name === d.category) : undefined
  return {
    agent: {
      name: d.name,
      description: d.description,
      cli: cli.id,
      model: d.model,
      icon,
      categoryId: cat?.id ?? '',
      instructions: d.instructions,
      extraArgs: [],
      enabled: true,
    },
    newCategory: d.category && !cat ? d.category.slice(0, 20) : '',
  }
}

/** 校验 CLI 给出的 JSON，转成可以应用的结果；不通过时返回给 CLI 看的错误说明 */
export function resolveProposal(
  kind: AssistKind,
  json: unknown,
  ctx: AssistContext,
): { proposal?: Proposal; error?: string } {
  if (kind === 'agent') {
    const p = AgentDraft.safeParse(json)
    if (!p.success) return { error: issues(p.error) }
    const target = ctx.target as Agent | undefined
    if (ctx.agents.some((a) => a.name === p.data.name && a.id !== target?.id))
      return { error: `已经有叫「${p.data.name}」的 Agent，换一个名称` }
    const r = resolveAgent(p.data, ctx)
    if (r.error) return { error: r.error }
    if (target) r.agent = { ...r.agent!, extraArgs: target.extraArgs, enabled: target.enabled }
    return { proposal: { kind: 'agent', agent: r.agent!, newCategory: r.newCategory } }
  }

  const p = WorkflowDraft.safeParse(json)
  if (!p.success) return { error: issues(p.error) }
  const d = p.data
  const errors: string[] = []
  const newAgents: WorkflowProposal['newAgents'] = []
  for (const na of d.newAgents) {
    if (ctx.agents.some((a) => a.name === na.name)) continue // 已有同名 Agent，直接复用
    const r = resolveAgent(na, ctx)
    if (r.error) errors.push(`newAgents「${na.name}」：${r.error}`)
    else newAgents.push({ ...r.agent!, ref: `new:${na.name}`, newCategory: r.newCategory })
  }
  const idOf = (name: string) => {
    const a = ctx.agents.find((x) => x.name === name)
    if (a) return a.id
    const n = newAgents.find((x) => x.name === name)
    if (n) return n.ref
    errors.push(`找不到 Agent「${name}」，只能用已有的 Agent 或在 newAgents 里新建`)
    return ''
  }
  const main = idOf(d.mainAgent)
  const members: WorkflowInput['members'] = []
  const addMember = (id: string, responsibility = '') => {
    if (id && id !== main && !members.some((m) => m.agentId === id)) members.push({ agentId: id, responsibility })
  }
  for (const m of d.members) addMember(idOf(m.agent), m.responsibility)
  const stages = d.stages.map((s) => ({
    id: flowId('st'),
    title: s.title,
    nodes: s.nodes.map((n) => {
      const id = n.agent && n.agent !== d.mainAgent ? idOf(n.agent) : ''
      addMember(id)
      return { id: flowId('nd'), title: n.title, agentId: id, instructions: n.instructions }
    }),
  }))
  const target = ctx.target as Workflow | undefined
  if (ctx.workflows.some((w) => w.name === d.name && w.id !== target?.id))
    errors.push(`已经有叫「${d.name}」的工作流，换一个名称`)
  if (errors.length) return { error: [...new Set(errors)].join('；') }
  // 没用到的新 Agent 不创建
  const used = new Set([main, ...members.map((m) => m.agentId)])
  return {
    proposal: {
      kind: 'workflow',
      workflow: { name: d.name, description: d.description, mainAgentId: main, members, stages, document: d.document },
      newAgents: newAgents.filter((a) => used.has(a.ref)),
    },
  }
}

/** 应用工作流结果：先建分类和新 Agent，再把 new:名称 换成真实 id */
export async function applyProposal(
  p: Proposal,
  ops: {
    createCategory: (name: string) => Promise<Category>
    categories: Category[]
    createAgent: (a: AgentInput) => Promise<Agent>
  },
): Promise<{ agent?: AgentInput; workflow?: WorkflowInput; created: Agent[]; categories: Category[] }> {
  const cats: Category[] = []
  const categoryId = async (name: string, fallback: string) => {
    if (!name) return fallback
    const old = [...ops.categories, ...cats].find((c) => c.name === name)
    if (old) return old.id
    const c = await ops.createCategory(name)
    cats.push(c)
    return c.id
  }
  if (p.kind === 'agent')
    return {
      agent: { ...p.agent, categoryId: await categoryId(p.newCategory, p.agent.categoryId) },
      created: [],
      categories: cats,
    }
  const created: Agent[] = []
  const map = new Map<string, string>()
  for (const { ref, newCategory, ...a } of p.newAgents) {
    const agent = await ops.createAgent({ ...a, categoryId: await categoryId(newCategory, a.categoryId) })
    created.push(agent)
    map.set(ref, agent.id)
  }
  const id = (x: string) => map.get(x) ?? x
  const w = p.workflow
  return {
    workflow: {
      ...w,
      mainAgentId: id(w.mainAgentId),
      members: w.members.map((m) => ({ ...m, agentId: id(m.agentId) })),
      stages: w.stages.map((s) => ({ ...s, nodes: s.nodes.map((n) => ({ ...n, agentId: id(n.agentId) })) })),
    },
    created,
    categories: cats,
  }
}
