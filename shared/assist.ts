/**
 * AI 创建 / 优化：让本机 CLI 通过对话生成 Agent 或工作流。
 * 提示词里写明背景、可选值、创建规则和输出格式；CLI 回复里的 JSON 经过这里的校验，
 * 引用的 Agent、CLI、图标都换成真实的 id 后，才能应用到面板。
 */
import { z } from 'zod'
import { CLIS, getCli } from './clis.ts'
import { promptLangWord, withPromptLangRules } from './prompt-lang.ts'
import {
  autoLayout,
  edge,
  findRefCycle,
  flowId,
  flowLabel,
  newFlow,
  newNode,
  newNodeStep,
  reachable,
  refLabel,
  wouldCycle,
} from './flow.ts'
import { AGENT_ICON_IDS } from './icons.ts'
import { McpServer } from './library.ts'
import type { GlobalLessonChange } from './lessons.ts'
import {
  END,
  START,
  TEST_STEP_ENVS,
  type Agent,
  type AgentInput,
  type Category,
  type Flow,
  type FlowRef,
  type GlobalLesson,
  type ParamValues,
  type ProjectLesson,
  type TaskMessage,
  type TestStep,
  type Workflow,
  type WorkflowInput,
} from './schema.ts'
import type { DerivedParam } from './agent-params.ts'
import { includedAgents, renderTemplate, resolveParams } from './agent-role.ts'

export const AssistKind = z.enum(['agent', 'workflow', 'skill', 'mcp', 'params', 'teststeps', 'lessons', 'project'])
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
  /** 为空时跟着模型档位或这个 CLI 的默认思考强度 */
  effort: z.string().trim().default(''),
  messages: z.array(AssistMessage).min(1).max(40),
  /** 「提问」开关：CLI 的提问交给用户回答；关着时让它自己选 */
  askUser: z.boolean().default(false),
  /**
   * Skill 和 MCP 工具的当前内容（它们不在面板的数据里，由页面带来）：
   * skill 是 cli、name、content；mcp 是 name、server（JSON）、error（测试连接的报错）、clis（装在哪些 CLI 里）
   */
  subject: z.record(z.string(), z.string().max(60000)).default({}),
  /**
   * 项目目录里的只读分析（params / teststeps）：在项目目录里执行，让 CLI 自己看代码判断参数和测试命令。
   * 传项目 id，服务端按它取目录；提示词里写死只读约束。
   */
  projectId: z.string().trim().max(100).default(''),
})
export type AssistInput = z.infer<typeof AssistInput>

/** CLI 输出的项目分析：步骤按测试步骤的规则另外校验 */
const ProjectDraft = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(40, 'name 最多 40 个字'),
  description: z.string().trim().max(200).default(''),
  type: z.enum(['general', 'ue']).default('general'),
  steps: z.array(z.unknown()).max(40).default([]),
})

/** CLI 输出的 Agent 草稿：分类、CLI 用名字或 id 表示 */
export const AgentDraft = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(40, 'name 最多 40 个字'),
  description: z.string().trim().max(200).default(''),
  /** 空字符串表示系统默认 CLI */
  cli: z.string().trim().default(''),
  /** @high / @medium / @low 表示档位 */
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
  flows: z
    .array(
      z.object({
        name: z.string().trim().min(1, '流程 name 不能为空').max(40),
        /** 主流程：任务从这里开始；没有标记时第一个是主流程 */
        main: z.boolean().default(false),
        description: z.string().trim().max(200).default(''),
        nodes: z
          .array(
            z.object({
              key: z.string().trim().min(1, '节点 key 不能为空').max(40),
              title: z.string().trim().min(1, '节点 title 不能为空').max(60),
              agent: z.string().trim().default(''),
              /** 写了就是流程节点：执行这个流程（子流程名或其他工作流名） */
              flow: z.string().trim().default(''),
              instructions: z.string().max(20000).default(''),
              start: z.string().trim().default(''),
              review: z.string().trim().default(''),
              end: z.string().trim().default(''),
              maxRounds: z.number().int().min(1).max(10).default(3),
              confirm: z.boolean().default(false),
              /** 按顺序执行的步骤；有 steps 时节点自己的 agent / review / confirm 不生效 */
              steps: z
                .array(
                  z.object({
                    title: z.string().trim().max(60).default(''),
                    agent: z.string().trim().default(''),
                    flow: z.string().trim().default(''),
                    tier: z.enum(['', 'high', 'medium', 'low']).default(''),
                    instructions: z.string().max(20000).default(''),
                    retries: z.number().int().min(0).max(5).default(0),
                    confirm: z.boolean().default(false),
                    review: z.string().trim().default(''),
                    maxRounds: z.number().int().min(1).max(10).default(3),
                  }),
                )
                .max(20)
                .default([]),
            }),
          )
          .max(60),
        /** 连线 [from, to]，用节点 key，开始和结束写 start / end */
        edges: z
          .array(z.tuple([z.string(), z.string()]))
          .max(200)
          .default([]),
      }),
    )
    .min(1, '至少一个流程')
    .max(10),
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
export type SkillProposal = {
  kind: 'skill'
  name: string
  /** 完整的 SKILL.md */
  content: string
}
export type McpProposal = {
  kind: 'mcp'
  server: McpServer
}
/**
 * 项目设置里的 Agent 参数值：只填「这次要配的参数」，key 必须是派生出来的参数 key。
 * 值按参数类型校验（select 必须在 options 里，bool 是布尔，number 是数字）。
 */
export type ParamsProposal = {
  kind: 'params'
  /** workflowId 是这次配置对应的工作流，界面上按它写进 workflowParams */
  workflowId: string
  values: ParamValues
}
/** 项目测试步骤：整份列表，用户确认后替换表单里的草稿 */
export type TestStepsProposal = {
  kind: 'teststeps'
  steps: TestStep[]
}
/** 分析项目目录：名称、简介、项目类型和测试步骤，用户确认后填进项目设置的表单 */
export type ProjectProposal = {
  kind: 'project'
  name: string
  description: string
  /** 选哪个内置项目工作流：一般项目还是 UE 项目 */
  type: 'general' | 'ue'
  steps: TestStep[]
}
/** 从项目教训里提取的全局教训改动：用户在界面上逐条勾选确认后才写进去 */
export type LessonsProposal = {
  kind: 'lessons'
  changes: GlobalLessonChange[]
}
export type Proposal =
  | ProjectProposal
  | LessonsProposal
  | AgentProposal
  | WorkflowProposal
  | SkillProposal
  | McpProposal
  | ParamsProposal
  | TestStepsProposal

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
  /** 执行中的进度：最近的思考内容、用到的工具、已输出的字数（含 JSON），让页面不是一直「正在生成」 */
  thinking?: string
  tools?: string[]
  outChars?: number
  startedAt?: number
  /** 和任务页一样的消息流：思考、工具调用（可以点开看详情）、说明文字；JSON 部分不在里面 */
  messages?: TaskMessage[]
}

export interface AssistContext {
  agents: Agent[]
  categories: Category[]
  workflows: Workflow[]
  /** 设置里用户补充的规则 */
  rules: string
  /** 优化时的当前内容 */
  target?: Agent | Workflow
  /** 设置里的系统默认 CLI */
  defaultCli?: string
  /** Skill、MCP 工具的当前内容，见 AssistInput.subject */
  subject?: Record<string, string>
  /** 只读分析的项目目录和名称：params / teststeps 在项目目录里执行 */
  projectPath?: string
  projectName?: string
  /** params 的校验依据：工作流派生出来的 Agent 参数（服务端按 workflowId 算好传进来） */
  paramSpec?: DerivedParam[]
  /** params 只配某一个 Agent 时，只校验这个 Agent 用到的参数 */
  paramAgentId?: string
  /** teststeps 校验和展示用的系统 */
  platform?: string
  /** lessons：这个项目的教训和现有的全局教训 */
  projectLessons?: ProjectLesson[]
  globalLessons?: GlobalLesson[]
}

const KIND_NAME = {
  agent: 'Agent',
  workflow: '工作流',
  skill: 'Skill',
  mcp: 'MCP 工具',
  params: '参数配置',
  teststeps: '测试步骤',
  lessons: '全局教训',
  project: '项目分析',
}

const AGENT_RULES = `- name 简短，体现职责，例如「前端开发」「代码审查」；不要和已有 Agent 重名（优化时保留原名，除非用户要求改名）
- description 一句话说明它擅长什么，不超过 60 字
- cli 留空表示跟随系统默认 CLI（推荐，以后切换默认 CLI 时会跟着换）；用户点名某个 CLI、或角色明显需要某个 CLI 时才填「可用的 CLI」里的 id
- model 只能写档位：@high（复杂任务、架构设计）、@medium（日常开发）、@low（简单改动、整理文档），执行时按设置换成对应 CLI 的模型
- icon 从「可选图标」里选最贴切的 id
- category 填已有分类的名称；确实没有合适的才写一个新名称，留空表示不分类
- instructions 是角色设定，会作为系统提示词发给 CLI，用 Markdown 写清楚：职责范围、工作方式、要遵守的约束、交付标准和完成后怎么汇报；不要写和具体项目无关的空话`

const WORKFLOW_RULES = `- 流程是节点和连线组成的图：从 start 出发，一个节点的上游全部完成后才执行它；没有先后依赖的节点同时执行
- 互不依赖的工作（例如前端和后端、单元测试和文档）都从同一个上游连出去，让它们同时执行；有依赖的用连线串起来
- 每个要执行的节点都必须能从 start 沿连线走到；最后的节点连到 end。不要连成环
- 同时执行的节点不要改同一批文件，instructions 里写清楚各自负责的范围
- 节点的 agent 写 Agent 名称，留空表示主 Agent；只能用「已有的 Agent」或 newAgents 里新建的 Agent
- 节点可以挂三个流程入口：start（开始前执行，结果作为节点的初始资料）、review（验收：不通过会把意见交回节点继续完善，最多 maxRounds 轮）、end（完成后执行）。值写流程名
- 节点的 flow 写流程名时，这个节点就是执行那个流程，而不是交给 Agent
- 可以引用的流程：flows 里的其他流程（子流程），或「已有的工作流」的名称。不要让流程互相引用形成循环
- 验收流程的最后一个节点要在结尾写「验收结论：通过」或「验收结论：不通过」
- flows 里有且只有一个 main 为 true 的主流程；只在确实需要复用或验收时才建子流程
- members 列出除主 Agent 外参与流程的 Agent 和它在这个工作流里的职责；节点里用到的 Agent 都要在 members 里
- 已有的 Agent 能胜任就复用，确实缺少某种角色时才在 newAgents 里新建（字段和 Agent 草稿相同）
- 每个节点的 instructions 写清楚：要做什么、产出什么、完成标准
- 一个节点可以按顺序挂多步（steps）：每步写 agent 或 flow，串行执行，上一步的输出作为下一步的输入；每步可以有自己的 tier、retries、review、maxRounds、confirm。有 steps 时节点自己的 agent、review、confirm 不生效
- document 是工作流说明（Markdown）：目标、规范、完成标准，每个节点执行时都会带上；不要在里面重复写步骤`

const AGENT_SHAPE = `{
  "name": "前端开发",
  "description": "实现 React 页面与交互，保证视觉还原",
  "cli": "",
  "model": "@medium",
  "icon": "layout",
  "category": "开发",
  "instructions": "## 职责\\n…\\n## 工作方式\\n…\\n## 交付标准\\n…"
}`

const WORKFLOW_SHAPE = `{
  "name": "Web 功能开发",
  "description": "前后端一起改的常规功能需求",
  "mainAgent": "架构师",
  "members": [{ "agent": "前端开发", "responsibility": "页面与交互" }, { "agent": "代码审查", "responsibility": "验收改动" }],
  "newAgents": [],
  "flows": [
    {
      "name": "主流程",
      "main": true,
      "nodes": [
        { "key": "plan", "title": "分析需求、拆分任务", "agent": "", "instructions": "…" },
        {
          "key": "api", "title": "方案与实现", "instructions": "…",
          "steps": [
            { "title": "方案确认", "agent": "架构师", "confirm": true, "instructions": "…" },
            { "title": "实现接口", "agent": "后端开发", "review": "代码验收", "maxRounds": 3, "retries": 1, "instructions": "…" }
          ]
        },
        { "key": "ui", "title": "实现页面", "agent": "前端开发", "instructions": "…" },
        { "key": "check", "title": "整体验收", "agent": "", "instructions": "…" }
      ],
      "edges": [["start", "plan"], ["plan", "api"], ["plan", "ui"], ["api", "check"], ["ui", "check"], ["check", "end"]]
    },
    {
      "name": "代码验收",
      "nodes": [{ "key": "review", "title": "审查改动", "agent": "代码审查", "instructions": "…最后一行写「验收结论：通过」或「验收结论：不通过」" }],
      "edges": [["start", "review"], ["review", "end"]]
    }
  ],
  "document": "# 目标\\n…\\n# 规范\\n…\\n# 完成标准\\n…"
}`

function agentLine(a: Agent, categories: Category[]) {
  const cat = categories.find((c) => c.id === a.categoryId)?.name
  return `- ${a.name}（${a.cli || '系统默认 CLI'}${a.model ? ` / ${a.model}` : ''}${cat ? `，分类：${cat}` : ''}${a.enabled ? '' : '，已停用'}）：${a.description || '没有简介'}`
}

/** 把工作流转成和草稿相同的结构，优化时给 CLI 看 */
export function workflowToDraft(w: Workflow, agents: Agent[], workflows: Workflow[] = []): WorkflowDraft {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? ''
  const ref = (r: FlowRef | null) => (r ? refLabel(r, w, workflows) : '')
  return {
    name: w.name,
    description: w.description,
    mainAgent: name(w.mainAgentId),
    members: w.members.map((m) => ({ agent: name(m.agentId), responsibility: m.responsibility })),
    newAgents: [],
    flows: w.flows.map((f) => {
      const key = new Map(f.nodes.map((n, i) => [n.id, `n${i + 1}`]))
      const k = (id: string) => (id === START || id === END ? id : (key.get(id) ?? id))
      return {
        name: flowLabel(f, w),
        main: f.id === w.entryFlowId,
        description: f.description,
        nodes: f.nodes.map((n) => ({
          key: key.get(n.id)!,
          title: n.title,
          agent: n.kind === 'agent' ? name(n.agentId) : '',
          flow: n.kind === 'flow' ? ref(n.flow) : '',
          instructions: n.instructions,
          start: ref(n.hooks.start),
          review: ref(n.hooks.review),
          end: ref(n.hooks.end),
          maxRounds: n.hooks.maxRounds,
          confirm: !!n.hooks.confirm,
          steps: n.steps.map((s) => ({
            title: s.title,
            agent: s.kind === 'agent' ? name(s.agentId) : '',
            flow: s.kind === 'flow' ? ref(s.flow) : '',
            tier: s.tier,
            instructions: s.instructions,
            retries: s.retries,
            confirm: !!s.confirm,
            review: ref(s.review),
            maxRounds: s.maxRounds,
          })),
        })),
        edges: f.edges.map((e) => [k(e.from), k(e.to)] as [string, string]),
      }
    }),
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
  // 配置助手的回复也跟随面板设置的语言：正文和思考过程用同一种，代码和命令不翻译
  return withPromptLangRules(buildAssistBody(kind, ctx, messages, installed))
}

function buildAssistBody(kind: AssistKind, ctx: AssistContext, messages: AssistMessage[], installed: string[]) {
  if (kind === 'skill' || kind === 'mcp') return buildLibraryPrompt(kind, ctx, messages)
  if (kind === 'params') return buildParamsPrompt(ctx, messages)
  if (kind === 'teststeps') return buildTestStepsPrompt(ctx, messages)
  if (kind === 'project') return buildProjectPrompt(ctx, messages)
  if (kind === 'lessons') return buildLessonsPrompt(ctx, messages)
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
      : JSON.stringify(workflowToDraft(ctx.target as Workflow, ctx.agents, ctx.workflows), null, 2)
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')

  return [
    `你是「Agent 面板」里的配置助手，正在和用户对话，帮他${improving ? '优化一个已有的' : '设计一个新的'}${what}。`,
    '只根据下面的信息回答。不要读写任何文件，也不要运行命令。',
    `## 背景
- Agent：一个可复用的「本机 CLI + 模型 + 角色设定」组合，执行任务时由面板在项目目录里调用对应 CLI。
- 工作流：一个主 Agent 和若干子 Agent 组成团队，用流程图编排：阶段依次执行，阶段内的节点并行。`,
    `## 可用的 CLI\n${clis}${ctx.defaultCli ? `\n系统默认 CLI：${ctx.defaultCli}` : ''}`,
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
先用两三句${promptLangWord()}说明你的设计${improving ? '和改了哪些地方' : ''}；信息不够时可以说明你做的假设，但仍然要给出完整结果。
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

const SKILL_RULES = `- SKILL.md 开头是 front matter：name 和 description 两个字段，后面是正文
- name 和文件夹名一致：小写字母、数字和连字符，简短，例如 commit-message（优化时保持原名）
- description 一到两句：写清它做什么、什么时候该用它——CLI 靠这句话决定要不要自动启用，别写成笼统的口号
- 正文用祈使句分步骤写：先做什么、再做什么、什么情况下停下来问用户；有固定格式的产出给一个简短的例子
- 只写这个 Skill 自己的流程，不要重复通用常识；篇幅精炼（一般不超过 150 行）
- 不要引用不存在的脚本和文件；需要时说明让 CLI 现场创建`

const SKILL_SHAPE = `{
  "name": "commit-message",
  "content": "---\\nname: commit-message\\ndescription: 按团队约定写提交说明。在用户要求提交代码或写 commit message 时使用。\\n---\\n\\n# 写提交说明\\n\\n1. 先看 git diff…\\n2. …\\n"
}`

const MCP_RULES = `- 你要排查的是一个 MCP 工具的配置：本地命令（transport 为 stdio，面板按 command 加 args 启动它，通过标准输入输出对话）或远程地址（transport 为 http，面板向 url 发 MCP 请求）
- 可以只读地排查：检查命令是否存在（which / where、--version）、Node 或 Python 的版本、自己运行一下启动命令看输出、读相关配置文件。不要修改任何文件，不要安装软件，不要执行有副作用的命令；运行命令需要用户确认时会弹出确认卡片
- 常见原因：命令不在 PATH 里或没装；npx 少了 -y 导致卡在确认安装；包名或参数拼错；需要的环境变量（API Key 等）没填；Node 版本太低；远程地址缺了路径（如 /mcp）、需要 Authorization 请求头、或者服务实际是 SSE 而不是 HTTP；工具启动时往标准输出打印了非 MCP 的内容
- 找到原因后改配置：只改能确定要改的字段；不知道的值（密钥等）保留原样并在说明里请用户自己填写
- 工具名 name 必须保持不变`

const MCP_SHAPE = `{
  "name": "docs",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "docs-mcp"],
  "env": { "API_KEY": "…" },
  "url": "",
  "headers": {}
}`

/** Skill 的创建 / 优化、MCP 工具的报错排查：和 Agent、工作流用同一套对话，提示词和输出格式不同 */
function buildLibraryPrompt(kind: 'skill' | 'mcp', ctx: AssistContext, messages: AssistMessage[]) {
  const sub = ctx.subject ?? {}
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')
  const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``
  if (kind === 'skill') {
    const improving = !!sub.content
    const cli = CLIS.find((c) => c.id === sub.cli)?.name
    return [
      `你是「Agent 面板」里的配置助手，正在和用户对话，帮他${improving ? '优化一个已有的' : '设计一个新的'} Skill。`,
      '只根据下面的信息回答。不要读写任何文件，也不要运行命令。',
      `## 背景\nSkill 是一个文件夹，核心是里面的 SKILL.md：教编码 CLI${cli ? `（这份是给 ${cli} 用的）` : ''}怎样完成某一类事情的说明，CLI 会按 description 判断什么时候用它。`,
      improving
        ? `## 当前的 SKILL.md（文件夹名 ${sub.name}，在它的基础上按用户要求修改）\n${fence('markdown', sub.content)}`
        : '',
      `## 创建规则\n${SKILL_RULES}`,
      ctx.rules.trim() ? `## 用户补充的规则（优先遵守）\n${ctx.rules.trim()}` : '',
      `## 输出格式
先用两三句${promptLangWord()}说明你的设计${improving ? '和改了哪些地方' : ''}；信息不够时可以说明你做的假设，但仍然要给出完整结果。
然后输出且只输出一个 \`\`\`json 代码块，content 是完整的 SKILL.md 文本（含 front matter），严格符合下面的结构（字段名不能改，不要加注释）：
${fence('json', SKILL_SHAPE)}`,
      `## 对话\n${convo}`,
      '请回复用户最后一条消息。',
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  return [
    '你是「Agent 面板」里的配置助手，正在和用户对话，帮他排查并修复一个 MCP 工具的配置。',
    `## 当前配置\n${fence('json', sub.server ?? '{}')}`,
    sub.error ? `## 测试连接的报错\n${fence('', sub.error)}` : '',
    sub.clis ? `## 已装在这些 CLI 里\n${sub.clis}` : '',
    `## 排查规则\n${MCP_RULES}`,
    `## 输出格式
先用几句${promptLangWord()}说明你查到的原因、做了哪些检查、改了哪里；没能确定原因时说清楚还缺什么信息，但仍然给出你认为最可能可用的配置。
然后输出且只输出一个 \`\`\`json 代码块，内容是修复后的完整配置，严格符合下面的结构（字段名不能改，不要加注释；stdio 的只填 command、args、env，http 的只填 url、headers）：
${fence('json', MCP_SHAPE)}`,
    `## 对话\n${convo}`,
    '请回复用户最后一条消息。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const SkillDraft = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][\w.-]*$/, 'name 只能用字母、数字、. _ -'),
  content: z.string().min(1, 'content 不能为空').max(60000),
})

/**
 * 项目设置里的 Agent 参数：在项目目录里只读看代码，给出每个参数的合理值。
 * 每个参数附上「取不同值时角色设定差在哪」和工作流节点上的预设，CLI 才有判断依据；
 * 否则它只看到一个标签（「TDD」「任务记录」），只能把开关原样拿去问用户。
 */
function buildParamsPrompt(ctx: AssistContext, messages: AssistMessage[]) {
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')
  const spec = paramSpecFor(ctx)
  const wf = ctx.target && 'flows' in ctx.target ? ctx.target : undefined
  const params = spec
    .map((d) => {
      const options = d.options.length ? `，可选值：${d.options.map((o) => `"${o}"`).join('、')}` : ''
      const def = d.defaultValue === undefined ? '，没有默认值' : `，默认值：${JSON.stringify(d.defaultValue)}`
      const who = [...new Set(d.agents.map((a) => a.name))].join('、')
      const preset = wf ? nodePresets(wf, d.key) : ''
      const effect = paramEffect(d, ctx.agents)
      return [
        `- ${d.key}（${d.label}，类型 ${d.type}${options}${def}${d.required ? '，必须填' : ''}）${d.description ? `：${d.description}` : ''}`,
        `  影响：${who}`,
        preset ? `  工作流节点上已预设：${preset}（项目里填了值会覆盖这些节点）` : '',
        effect,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')
  const where = ctx.projectPath
    ? `项目「${ctx.projectName || ctx.projectPath}」的目录是 ${ctx.projectPath}。
只读地看这个目录：AGENTS.md / CLAUDE.md、README、依赖清单、构建 / 测试脚本、CI 配置、docs 和目录结构，据此判断参数值。
**不许修改任何文件、不许安装依赖、不许执行有副作用的命令。** 需要跑命令确认时，先说清楚要跑什么并等用户确认。`
    : '没有项目目录：只按对话内容和参数说明给出合理值，不要编造项目里不存在的命令。'
  return [
    '你是「Agent 面板」里的配置助手，正在帮用户填一个项目里某个工作流的 Agent 参数。',
    where,
    `## 要配置的参数\n${params || '（没有可配置的参数）'}`,
    `## 怎么判断
- 每个参数都由你自己决定，不要把参数的取舍拿去问用户：你给的值只会显示在右侧预览里，用户确认后才填进表单，填错了用户能直接改。
- 依据按这个顺序找：项目里的事实（文件、脚本、约定文档里写的规则）→ 参数「取不同值时」的差别 → 默认值。默认值和节点预设是工作流作者针对一般项目选好的，没有看到需要改的依据就保持不变，这本身就是一个确定的结论。
- 只有两种情况才请用户补充：参数必须填、没有默认值，而且项目里查不到（例如外部服务地址、账号）；或者用户在对话里提的要求和项目事实冲突。这时也先给出你推荐的值。
- 事实自己查，查不到就按上面的顺序落到默认值，不要因为「没有明确依据」而停下来提问。`,
    ctx.rules.trim() ? `## 用户补充的规则（优先遵守）\n${ctx.rules.trim()}` : '',
    `## 输出格式
先逐个参数用一行${promptLangWord()}写结论和依据，例如「TDD：打开（package.json 有 test:unit，server/ 下有 *.test.ts）」「任务记录：保持默认（项目没有 worklog 目录，也没有跨会话的大任务约定）」。
然后输出且只输出一个 \`\`\`json 代码块，形如：
\`\`\`json
{ "values": { "scope": "本次改动", "env": "wsl", "regress": true } }
\`\`\`
- 只能出现上面列出的参数 key；要改的参数写进 values，保持默认（或节点预设）的不写。
- 值必须符合类型：下拉写可选值之一，开关写 true / false，数字写数字，多选写字符串数组。
- 命令、路径这类字符串要能直接用，不要写占位符。`,
    `## 对话\n${convo}`,
    '请回复用户最后一条消息。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 工作流节点（和步骤）上已经写好的这个参数的值，例如第一个节点的 scene=true */
function nodePresets(w: Workflow, key: string) {
  const out: string[] = []
  for (const f of w.flows)
    for (const n of f.nodes) {
      const name = n.title || n.id
      if (n.params[key] !== undefined) out.push(`「${name}」= ${JSON.stringify(n.params[key])}`)
      for (const s of n.steps)
        if (s.params[key] !== undefined) out.push(`「${name}」的步骤 = ${JSON.stringify(s.params[key])}`)
    }
  return [...new Set(out)].slice(0, 8).join('、')
}

/**
 * 参数取不同值时，角色设定（含引入的角色）里多出来的内容。
 * 按每个取值各渲染一遍模板，只列这个取值独有的行，让 CLI 知道开关实际管什么。
 */
function paramEffect(d: DerivedParam, agents: Agent[]) {
  const variants: [string, ParamValues[string]][] =
    d.type === 'bool'
      ? [
          ['打开时', true],
          ['关闭时', false],
        ]
      : d.options.length && d.type !== 'multi'
        ? d.options.slice(0, 6).map((o) => [`选「${o}」时`, o])
        : []
  if (!variants.length) return ''
  const owners = d.agents.map((o) => agents.find((a) => a.id === o.id)).filter((a): a is Agent => !!a)
  const seen = new Set<string>()
  const roles = owners.flatMap((a) => [a, ...includedAgents(a, agents).map((x) => x.agent)])
  const texts = roles.filter((a) => !seen.has(a.id) && seen.add(a.id) && a.instructions.includes(`{{#if`))
  if (!texts.length) return ''
  const linesOf = (v: ParamValues[string]) => {
    const out = new Set<string>()
    for (const a of texts) {
      const base = resolveParams(a.params).values
      for (const l of renderTemplate(a.instructions, { ...base, [d.key]: v }).split('\n'))
        if (l.trim()) out.add(l.trim())
    }
    return out
  }
  const sets = variants.map(([, v]) => linesOf(v))
  const rows = variants
    .map(([label], i) => {
      const own = [...sets[i]].filter((l) => sets.some((s, j) => j !== i && !s.has(l)))
      if (!own.length) return ''
      const text = own.join(' ')
      return `  ${label}角色设定里会多出：${text.length > 360 ? `${text.slice(0, 360)}…` : text}`
    })
    .filter(Boolean)
  return rows.join('\n')
}

/** teststeps 的提示词：读项目实际的技术栈和脚本，生成可以直接执行的步骤 */
function buildTestStepsPrompt(ctx: AssistContext, messages: AssistMessage[]) {
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')
  const platform = ctx.platform || ''
  const where = ctx.projectPath
    ? `项目「${ctx.projectName || ctx.projectPath}」的目录是 ${ctx.projectPath}。
只读地看这个目录：依赖清单（package.json / Cargo.toml / go.mod / .uproject 等）、scripts、Makefile、CI 配置、README，读出现有的构建、测试、检查命令，按实际存在的方式写步骤。
**不许修改任何文件、不许安装依赖、不许执行有副作用的命令。** 需要跑命令确认时，先说清楚要跑什么并等用户确认。`
    : '没有项目目录：按对话里描述的技术栈给出步骤，命令写通用的形式，并说明需要用户按项目实际情况改。'
  return [
    '你是「Agent 面板」里的配置助手，正在帮用户写**这个项目的测试步骤**。测试步骤属于项目：Agent 按它执行构建、测试、检查，所以每条都要能直接跑。',
    where,
    `当前系统：${platform || '未知'}。整行命令默认在 Git Bash 里跑（Windows 路径如 F:/… 可以直接用）；只有确实必须在 WSL 里跑的步骤才标 wsl，标了 wsl 的步骤在 Windows 上用 wsl.exe 执行、非 Windows 上按 bash。`,
    `## 步骤的字段
- name：显示名，例如「类型检查」「单元测试」「编译」
- command：要执行的命令原文，必须是项目里真实存在的命令
- env：auto / wsl / powershell / cmd / bash。auto 按系统自己判断（Windows 上默认 Git Bash）；只有确实必须在 WSL 里跑的（例如 agent-panel 的 e2e）才标 wsl
- cwd：相对项目根的工作目录，没有就留空
- when：执行条件，例如「仅在改了 web/ 时」「仅发布前」，没有就留空
- timeoutSec：超时秒数，0 表示不限
- note：给执行者看的说明，例如「同一时间只编译一次」
- enabled：默认 true
- quick：小改动也跑。Agent 判断是小改动（改文案、样式、一两处局部修改）时只跑标了 true 的步骤；类型检查、lint、语法检查这类几十秒内跑完的标 true，单元测试、端到端、完整构建标 false`,
    `## 写步骤的规则
- 按执行顺序排：先静态检查和单元测试，再端到端和构建；编译类放在需要它之前。
- 只写项目里真的有的命令：先看 package.json 的 scripts，没有脚本就不要编 \`npm run xxx\`。
- UE 项目给编译（\`Build.bat <Target> Win64 Development -Project=<.uproject> -WaitMutex\`）、Lua 语法检查、可选的 AutomationTest；需要 Editor 的标成 enabled: false 并在 note 里说明。
- 每条 id 用简短的英文标识（例如 node-typecheck），同一份里不要重复。`,
    ctx.rules.trim() ? `## 用户补充的规则（优先遵守）\n${ctx.rules.trim()}` : '',
    `## 输出格式
先用两三句${promptLangWord()}说明你看到了什么、为什么这样排${ctx.projectPath ? '' : '，以及哪些命令要用户按项目实际情况改'}。
然后输出且只输出一个 \`\`\`json 代码块：
\`\`\`json
{ "steps": [ { "id": "node-typecheck", "name": "类型检查", "command": "npm run typecheck", "env": "auto", "cwd": "", "when": "", "timeoutSec": 0, "note": "", "enabled": true } ] }
\`\`\`
字段名不能改；没有的字段可以不写（会按默认值补）。`,
    `## 对话\n${convo}`,
    '请回复用户最后一条消息。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * project 的提示词：在项目目录里只读地看一遍，给出名称、简介、项目类型和测试步骤。
 * 面板自己的规则扫描（scan）一起交过去当线索，AI 以实际看到的为准
 */
function buildProjectPrompt(ctx: AssistContext, messages: AssistMessage[]) {
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')
  return [
    '你是「Agent 面板」里的配置助手，正在帮用户**分析一个项目目录**，填好项目设置：名称、简介、项目类型和测试步骤。',
    `项目目录是 ${ctx.projectPath}。只读地看这个目录：README、依赖清单（package.json / Cargo.toml / go.mod / *.uproject / *.sln 等）、scripts、Makefile、CI 配置、目录结构，弄清楚它是做什么的、用什么技术栈、怎么构建和测试。
**不许修改任何文件、不许安装依赖、不许执行有副作用的命令。** 读文件、列目录、git log 这类只读操作可以直接做。`,
    `当前系统：${ctx.platform || '未知'}。`,
    ctx.subject?.scan ? `## 面板按文件规则扫出来的线索（可能不全或不准，以你实际看到的为准）\n${ctx.subject.scan}` : '',
    `## 要填的字段
- name：项目名，简短，优先用 README 标题或包名，不超过 40 个字
- description：一两句${promptLangWord()}说明这个项目是做什么的、主要技术栈，不超过 120 个字
- type：general（一般项目）或 ue（Unreal Engine 项目，目录里有 .uproject）
- steps：测试步骤，Agent 按它执行构建、测试、检查，每条都要能直接跑。字段：id（简短英文标识）、name、command（项目里真实存在的命令）、env（auto / wsl / powershell / cmd / bash，不确定就 auto；Windows 上默认走 Git Bash，只有确实必须在 WSL 里跑的才标 wsl）、cwd（相对项目根，没有留空）、when（执行条件，没有留空）、timeoutSec（0 表示不限）、note、enabled、quick（类型检查、lint 这类几十秒内跑完的标 true）
- 按执行顺序排：先静态检查和单元测试，再端到端和构建。只写项目里真的有的命令，没有脚本就不要编 \`npm run xxx\`。`,
    ctx.rules.trim() ? `## 用户补充的规则（优先遵守）\n${ctx.rules.trim()}` : '',
    `## 输出格式
先用三五句${promptLangWord()}说明你看到了什么：项目是做什么的、技术栈、构建和测试怎么跑、有什么要用户注意的。
然后输出且只输出一个 \`\`\`json 代码块：
\`\`\`json
{ "name": "官网前端", "description": "公司官网的前端，React + Vite。", "type": "general", "steps": [ { "id": "node-typecheck", "name": "类型检查", "command": "npm run typecheck", "env": "auto", "quick": true } ] }
\`\`\`
字段名不能改；步骤里没有的字段可以不写（会按默认值补）。`,
    `## 对话\n${convo}`,
    '请回复用户最后一条消息。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** lessons 的提示词：从一个项目的教训里挑出换个项目也适用的，合并进现有的全局教训 */
function buildLessonsPrompt(ctx: AssistContext, messages: AssistMessage[]) {
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')
  const line = (l: ProjectLesson | GlobalLesson) =>
    [
      `- [${l.id}] ${l.title}${l.enabled ? '' : '（已停用）'}`,
      l.rule ? `  说明：${l.rule.replace(/\n+/g, ' ')}` : '',
      l.cause ? `  起因：${l.cause.replace(/\n+/g, ' ')}` : '',
      l.paths.length ? `  范围：${l.paths.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  const own = ctx.projectLessons ?? []
  const globals = ctx.globalLessons ?? []
  return [
    `你是「Agent 面板」里的配置助手，正在帮用户从项目「${ctx.projectName || '未命名'}」的教训里**提取全局教训**。`,
    '项目教训是 Agent 在这个项目里返工过、被纠正过的地方写成的规则。全局教训所有项目的对话都会带上，优先级低于项目教训和用户当次的要求，只有用户确认后才能修改。',
    `## 这个项目的教训（${own.length} 条）\n${own.map(line).join('\n') || '（没有）'}`,
    `## 现有的全局教训（${globals.length} 条）\n${globals.map(line).join('\n') || '（还没有）'}`,
    `## 提取规则
- 只提取换一个项目、换一种技术栈也成立的做法（例如「等待、计时用面板的后台任务，不用会立刻退出的脚本」「改了提示词先搜测试里有没有断言原句」）。只对这个项目的目录、字段、命令、业务成立的不要提。
- 提取时改写成通用的说法：去掉这个项目的文件名、字段名，具体事件只留在 cause 里一句话带过。
- 和现有全局教训说的是同一件事时，用 update 改写那一条（id 写它的 id），把两边的要点合在一起；不要新加重复的。
- 现有全局教训和这个项目的教训冲突时，不要改全局教训去迁就一个项目；这种情况在说明里讲出来，让用户决定。
- paths 一般留空：不同项目的目录不一样。
- 宁缺毋滥：没有适合的就输出空的 changes，在说明里讲为什么。`,
    `## 输出格式
先用两三句${promptLangWord()}说明挑了哪些、为什么，以及哪些看起来通用但没提（原因）。
然后输出且只输出一个 \`\`\`json 代码块：
\`\`\`json
{ "changes": [ { "op": "add", "id": "", "title": "一句话的规则", "rule": "展开说明", "cause": "从什么情况总结的", "paths": [], "sources": ["项目教训的 id"] } ] }
\`\`\`
op 只能是 add 或 update；update 的 id 必须是现有全局教训的 id；sources 写它来自这个项目的哪几条教训（id）。`,
    `## 对话\n${convo}`,
    '请回复用户最后一条消息。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const LESSON_CHANGE = z.object({
  op: z.enum(['add', 'update']),
  id: z.string().trim().max(60).default(''),
  title: z.string().trim().min(1, 'title 不能为空').max(120),
  rule: z.string().trim().max(1500).default(''),
  cause: z.string().trim().max(500).default(''),
  paths: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  sources: z.array(z.string().trim()).max(50).default([]),
})

/** 校验 AI 给出的全局教训改动：update 要指向现有的那条，同一条不能改两次 */
export function resolveLessonChanges(
  json: unknown,
  globals: GlobalLesson[],
): { changes?: GlobalLessonChange[]; error?: string } {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  const raw = Array.isArray(obj) ? obj : obj?.changes
  const arr = z
    .array(LESSON_CHANGE)
    .max(30)
    .safeParse(raw ?? [])
  if (!arr.success) return { error: z.prettifyError(arr.error) }
  const seen = new Set<string>()
  for (const c of arr.data) {
    if (c.op !== 'update') continue
    if (!globals.some((g) => g.id === c.id)) return { error: `update 的 id「${c.id}」不是现有全局教训的 id` }
    if (seen.has(c.id)) return { error: `全局教训「${c.id}」被改了两次，合成一条 update` }
    seen.add(c.id)
  }
  return { changes: arr.data.map((c) => (c.op === 'add' ? { ...c, id: '' } : c)) }
}

/** params 这个 Agent 分组会用到的参数；指定了 paramAgentId 时只留那个 Agent 的 */
function paramSpecFor(ctx: AssistContext) {
  const all = ctx.paramSpec ?? []
  if (!ctx.paramAgentId) return all
  return all.filter((d) => d.agents.some((a) => a.id === ctx.paramAgentId))
}

const TEST_STEP_SHAPE = z.object({
  id: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1, 'name 不能为空').max(60),
  command: z.string().trim().min(1, 'command 不能为空').max(2000),
  env: z.enum(TEST_STEP_ENVS).default('auto'),
  cwd: z.string().trim().max(300).default(''),
  when: z.string().trim().max(120).default(''),
  timeoutSec: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600)
    .default(0),
  note: z.string().trim().max(300).default(''),
  enabled: z.boolean().default(true),
  merge: z.boolean().default(false),
  quick: z.boolean().default(false),
})

/**
 * 校验 AI 给出的参数值：key 必须是派生出来的参数，值按类型校验。
 * 不通过的逐条说明，服务端据此让 CLI 修正一次。
 */
export function resolveParamValues(json: unknown, spec: DerivedParam[]): { values?: ParamValues; error?: string } {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  const raw = obj?.values ?? obj
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { error: '要输出一个 JSON 对象：{ "values": { … } }' }
  const problems: string[] = []
  const values: ParamValues = {}
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const d = spec.find((x) => x.key === key)
    if (!d) {
      problems.push(`「${key}」不是这里可配置的参数`)
      continue
    }
    const bad = (what: string) => problems.push(`「${key}」${what}`)
    if (d.type === 'bool') {
      if (typeof v !== 'boolean') bad('要是 true 或 false')
      else values[key] = v
    } else if (d.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n)) bad('要是数字')
      else values[key] = n
    } else if (d.type === 'multi') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad('要是字符串数组')
      else {
        const bad2 = v.filter((x) => d.options.length && !d.options.includes(x))
        if (bad2.length) bad(`里有不在可选项中的值：${bad2.join('、')}`)
        else values[key] = v as string[]
      }
    } else if (d.type === 'select') {
      if (typeof v !== 'string') bad('要是字符串')
      else if (d.options.length && !d.options.includes(v)) bad(`要是 ${d.options.join(' / ')} 之一`)
      else values[key] = v
    } else {
      if (typeof v === 'object') bad('要是文字')
      else values[key] = String(v)
    }
  }
  return problems.length ? { error: problems.join('；') } : { values }
}

/** 校验 AI 给出的测试步骤：字段和类型、id 不重复、至少一条、环境合法 */
export function resolveTestSteps(json: unknown): { steps?: TestStep[]; error?: string } {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  const raw = Array.isArray(obj) ? obj : obj?.steps
  const arr = z.array(TEST_STEP_SHAPE).max(40).safeParse(raw)
  if (!arr.success) return { error: z.prettifyError(arr.error) }
  if (!arr.data.length) return { error: '至少要有一步；项目确实没有可执行的命令时就留在说明里，不要输出空列表' }
  const ids = new Set<string>()
  const steps = arr.data.map((s, i): TestStep => {
    const base =
      (s.id || `step-${i + 1}`)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .slice(0, 40) || `step-${i + 1}`
    let id = base
    for (let n = 2; ids.has(id); n++) id = `${base.slice(0, 36)}-${n}`
    ids.add(id)
    return { ...s, id }
  })
  return { steps }
}

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

const agentExtras = (a?: Agent) => ({
  includes: a?.includes ?? [],
  params: a?.params ?? [],
  skills: a?.skills ?? [],
  starters: a?.starters ?? [],
  tags: a?.tags ?? [],
  common: a?.common ?? false,
  canDelegate: a?.canDelegate ?? false,
  canPlan: a?.canPlan ?? false,
  capsSet: a?.capsSet ?? true,
  origin: a?.origin ?? '',
})

function resolveAgent(d: AgentDraft, ctx: AssistContext): { agent?: AgentInput; newCategory: string; error?: string } {
  const sys = !d.cli || /^(default|系统默认|默认)$/i.test(d.cli)
  const cli = sys ? { id: '' } : (getCli(d.cli) ?? CLIS.find((c) => c.name.toLowerCase() === d.cli.toLowerCase()))
  const tier = d.model.replace(/^@/, '').toLowerCase()
  // Agent 的模型只能是档位；写了具体模型名的按中档处理
  const model = ['high', 'medium', 'low'].includes(tier) ? `@${tier}` : '@medium'
  if (!cli) return { newCategory: '', error: `cli「${d.cli}」不存在，只能是 ${CLIS.map((c) => c.id).join(' / ')}` }
  const icon = AGENT_ICON_IDS.some(([id]) => id === d.icon) ? d.icon : 'bot'
  const cat = d.category ? ctx.categories.find((c) => c.name === d.category) : undefined
  return {
    agent: {
      name: d.name,
      description: d.description,
      cli: cli.id,
      model,
      icon,
      categoryId: cat?.id ?? '',
      instructions: d.instructions,
      effort: '',
      permission: '',
      extraArgs: [],
      enabled: true,
      // AI 只改名称、简介、角色设定这些；优化时引入、参数、Skill、标签沿用原来的
      ...agentExtras(ctx.target && 'instructions' in ctx.target ? ctx.target : undefined),
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
  if (kind === 'params') {
    const r = resolveParamValues(json, paramSpecFor(ctx))
    if (r.error) return { error: r.error }
    return { proposal: { kind: 'params', workflowId: ctx.target?.id ?? '', values: r.values! } }
  }
  if (kind === 'lessons') {
    const r = resolveLessonChanges(json, ctx.globalLessons ?? [])
    return r.error ? { error: r.error } : { proposal: { kind: 'lessons', changes: r.changes! } }
  }
  if (kind === 'project') {
    const p = ProjectDraft.safeParse(json)
    if (!p.success) return { error: issues(p.error) }
    const r = p.data.steps.length ? resolveTestSteps({ steps: p.data.steps }) : { steps: [] as TestStep[] }
    if (r.error) return { error: `steps：${r.error}` }
    return { proposal: { kind: 'project', ...p.data, steps: r.steps! } }
  }
  if (kind === 'teststeps') {
    const r = resolveTestSteps(json)
    return r.error ? { error: r.error } : { proposal: { kind: 'teststeps', steps: r.steps! } }
  }
  if (kind === 'skill') {
    const p = SkillDraft.safeParse(json)
    if (!p.success) return { error: issues(p.error) }
    // 优化时文件夹名不变
    const name = ctx.subject?.name || p.data.name
    const fm = p.data.content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
    if (!fm) return { error: 'content 要以 --- 包起来的 front matter 开头，里面写 name 和 description' }
    if (!/^description:\s*\S/m.test(fm)) return { error: 'front matter 里缺少 description' }
    const fmName = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm)?.[1]
    if (fmName !== name) return { error: `front matter 里的 name 要写成 ${name}（和文件夹名一致）` }
    return { proposal: { kind: 'skill', name, content: p.data.content } }
  }
  if (kind === 'mcp') {
    const p = McpServer.safeParse({ ...(json as object), name: ctx.subject?.name || (json as any)?.name })
    if (!p.success) return { error: issues(p.error) }
    const sv = p.data
    if (sv.transport === 'stdio' && !sv.command.trim()) return { error: 'stdio 的工具要填 command' }
    if (sv.transport === 'http' && !/^https?:\/\//.test(sv.url))
      return { error: 'http 的工具要填以 http:// 或 https:// 开头的 url' }
    return { proposal: { kind: 'mcp', server: sv } }
  }
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
  const target = ctx.target as Workflow | undefined
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

  // 先给每个流程分配 id，节点里按名称引用流程
  const mains = d.flows.filter((f) => f.main)
  if (mains.length > 1) errors.push('只能有一个 main 为 true 的主流程')
  const ids = d.flows.map((f, i) => (i === 0 && !target ? 'main' : flowId('fl')))
  if (target)
    ids.forEach((_, i) => (ids[i] = target.flows.find((f) => flowLabel(f, target) === d.flows[i].name)?.id ?? ids[i]))
  const refOf = (nameText: string, where: string): FlowRef | null => {
    if (!nameText) return null
    const i = d.flows.findIndex((f) => f.name === nameText)
    if (i >= 0) return { kind: 'sub', id: ids[i] }
    const w = ctx.workflows.find((x) => x.name === nameText && x.id !== target?.id)
    if (w) return { kind: 'workflow', id: w.id }
    errors.push(`${where}引用的流程「${nameText}」不存在，只能写 flows 里的流程名或已有工作流的名称`)
    return null
  }
  const flows: Flow[] = d.flows.map((f, fi) => {
    const keys = new Map<string, string>()
    for (const n of f.nodes) {
      if (keys.has(n.key)) errors.push(`流程「${f.name}」里节点 key「${n.key}」重复`)
      keys.set(n.key, flowId('nd'))
    }
    const nodes = f.nodes.map((n) => {
      const where = `流程「${f.name}」的节点「${n.title}」`
      const agentId = n.flow ? '' : n.agent && n.agent !== d.mainAgent ? idOf(n.agent) : ''
      addMember(agentId)
      const steps = n.steps.map((s, si) => {
        const swhere = `${where}的第 ${si + 1} 步「${s.title || s.agent || '未命名'}」`
        const stepAgent = s.flow ? '' : s.agent && s.agent !== d.mainAgent ? idOf(s.agent) : ''
        addMember(stepAgent)
        return newNodeStep({
          id: `st${si + 1}`,
          title: s.title,
          kind: s.flow ? 'flow' : 'agent',
          agentId: stepAgent,
          flow: s.flow ? refOf(s.flow, swhere) : null,
          tier: s.tier,
          instructions: s.instructions,
          retries: s.retries,
          confirm: s.confirm || undefined,
          review: s.flow ? null : refOf(s.review, swhere),
          maxRounds: s.maxRounds,
        })
      })
      return newNode({
        id: keys.get(n.key)!,
        title: n.title,
        kind: steps.length ? 'agent' : n.flow ? 'flow' : 'agent',
        agentId: steps.length ? '' : agentId,
        flow: steps.length ? null : n.flow ? refOf(n.flow, where) : null,
        instructions: n.instructions,
        steps,
        hooks: {
          start: refOf(n.start, where),
          review: steps.length ? null : refOf(n.review, where),
          end: refOf(n.end, where),
          maxRounds: n.maxRounds,
          ...(!steps.length && n.confirm && { confirm: true }),
        },
        x: 0,
        y: 0,
      })
    })
    const end = (k: string) => (k === START || k === END ? k : keys.get(k))
    const flow: Flow = { ...newFlow(f.name, ids[fi]), description: f.description, nodes }
    for (const [a, b] of f.edges) {
      const from = end(a)
      const to = end(b)
      if (!from || !to) {
        errors.push(`流程「${f.name}」的连线 [${a}, ${b}] 用了不存在的节点 key`)
        continue
      }
      if (from === END || to === START) {
        errors.push(`流程「${f.name}」的连线 [${a}, ${b}] 方向不对：start 只能连出，end 只能连入`)
        continue
      }
      if (wouldCycle(flow, from, to)) {
        errors.push(`流程「${f.name}」的连线 [${a}, ${b}] 形成了环`)
        continue
      }
      if (!flow.edges.some((e) => e.from === from && e.to === to)) flow.edges.push(edge(from, to))
    }
    const live = reachable(flow)
    const lost = nodes.filter((n) => !live.has(n.id)).map((n) => n.title)
    if (lost.length)
      errors.push(`流程「${f.name}」里的节点 ${lost.map((t) => `「${t}」`).join('')} 没有从 start 连过来，不会被执行`)
    if (!nodes.length) errors.push(`流程「${f.name}」没有节点`)
    return autoLayout(flow)
  })
  const entryFlowId =
    ids[
      Math.max(
        0,
        d.flows.findIndex((f) => f.main),
      )
    ]
  if (ctx.workflows.some((w) => w.name === d.name && w.id !== target?.id))
    errors.push(`已经有叫「${d.name}」的工作流，换一个名称`)
  if (!errors.length) {
    const cycle = findRefCycle(
      { ...(target ?? ({ id: '__draft' } as Workflow)), name: d.name, flows, entryFlowId } as Workflow,
      ctx.workflows,
    )
    if (cycle) errors.push(`流程之间循环引用：${cycle.join(' → ')}`)
  }
  if (errors.length) return { error: [...new Set(errors)].join('；') }
  // 没用到的新 Agent 不创建
  const used = new Set([main, ...members.map((m) => m.agentId)])
  return {
    proposal: {
      kind: 'workflow',
      workflow: {
        name: d.name,
        description: d.description,
        mainAgentId: main,
        members,
        flows,
        entryFlowId,
        document: d.document,
        expose: target?.expose ?? [],
        categoryId: target?.categoryId ?? '',
        tags: target?.tags ?? [],
      },
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
  // Skill、MCP 工具由各自的页面应用；参数和测试步骤只填进项目设置的表单草稿
  if (
    p.kind === 'skill' ||
    p.kind === 'mcp' ||
    p.kind === 'params' ||
    p.kind === 'teststeps' ||
    p.kind === 'lessons' ||
    p.kind === 'project'
  )
    return { created: [], categories: [] }
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
      flows: w.flows.map((f) => ({
        ...f,
        nodes: f.nodes.map((n) => ({
          ...n,
          agentId: id(n.agentId),
          steps: n.steps.map((s) => ({ ...s, agentId: id(s.agentId) })),
        })),
      })),
    },
    created,
    categories: cats,
  }
}
