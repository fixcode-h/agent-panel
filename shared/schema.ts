import { z } from 'zod'

/**
 * Agent：一个可复用的「CLI + 模型 + 角色设定」组合。
 * 主 / 子 Agent 不在这里区分，而是在工作流里指定。
 */
export const AgentInput = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(40),
  description: z.string().trim().max(200).default(''),
  /** 为空表示使用设置里的默认 CLI */
  cli: z.string().default(''),
  /** 具体模型名；@high / @medium / @low 表示档位；为空用 CLI 的默认模型 */
  model: z.string().trim().default(''),
  /** 思考强度；为空时跟随档位或 CLI 的默认设置 */
  effort: z.string().trim().default(''),
  /** 所属分类；为空表示未分类 */
  categoryId: z.string().default(''),
  /** 卡片上显示的图标，可选值见 web/src/lib/agent-icons.ts */
  icon: z.string().default('bot'),
  /** 角色设定 / 系统提示词，执行时会拼在任务前面 */
  instructions: z.string().max(8000).default(''),
  /** 追加给 CLI 的参数，例如 --permission-mode acceptEdits */
  extraArgs: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
})
export type AgentInput = z.infer<typeof AgentInput>

const Meta = z.object({ id: z.string(), createdAt: z.string(), updatedAt: z.string() })

export const Agent = AgentInput.extend(Meta.shape)
export type Agent = z.infer<typeof Agent>

/** Agent 分类，例如「开发」「测试」「文档」，只用于组织列表 */
export const CategoryInput = z.object({
  name: z.string().trim().min(1, '分类名不能为空').max(20),
})
export type CategoryInput = z.infer<typeof CategoryInput>

export const Category = CategoryInput.extend(Meta.shape)
export type Category = z.infer<typeof Category>

/** 工作流里的一个子 Agent，以及它在这个工作流中负责的内容 */
export const WorkflowMember = z.object({
  agentId: z.string(),
  responsibility: z.string().trim().max(200).default(''),
})
export type WorkflowMember = z.infer<typeof WorkflowMember>

/**
 * 引用一个流程：sub 是同一工作流里的另一个流程（按 id），workflow 是另一个工作流（执行它的主流程）。
 * 节点的开始 / 验收 / 结束入口和「流程节点」都用它。
 */
export const FlowRef = z.object({
  kind: z.enum(['sub', 'workflow']),
  id: z.string().min(1),
})
export type FlowRef = z.infer<typeof FlowRef>

/** 节点上可以挂的三个流程入口 */
export const NodeHooks = z.object({
  /** 开始前执行，结果作为这个节点的初始资料 */
  start: FlowRef.nullable().default(null),
  /** 节点完成后执行验收；不通过就把意见交回节点继续完善 */
  review: FlowRef.nullable().default(null),
  /** 验收通过后执行，结果并入这个节点的输出 */
  end: FlowRef.nullable().default(null),
  /** 验收最多几轮，超过仍不通过时节点失败 */
  maxRounds: z.number().int().min(1).max(10).default(3),
})
export type NodeHooks = z.infer<typeof NodeHooks>

/** 流程里的一个节点：交给某个 Agent 完成的一件事，或者执行另一个流程 */
export const FlowNode = z.object({
  id: z.string().min(1),
  title: z.string().trim().max(60).default(''),
  /** agent：由 Agent 执行；flow：执行引用的流程 */
  kind: z.enum(['agent', 'flow']).default('agent'),
  /** 执行的 Agent；为空表示由主 Agent 执行 */
  agentId: z.string().default(''),
  /** kind 为 flow 时执行的流程 */
  flow: FlowRef.nullable().default(null),
  /** 这个节点要做什么、产出什么（Markdown） */
  instructions: z.string().max(20000).default(''),
  x: z.number().default(0),
  y: z.number().default(0),
  hooks: NodeHooks.default({ start: null, review: null, end: null, maxRounds: 3 }),
})
export type FlowNode = z.infer<typeof FlowNode>

/** 连线：from 执行完才会执行 to；START / END 表示流程的开始和结束 */
export const FlowEdge = z.object({ id: z.string().min(1), from: z.string().min(1), to: z.string().min(1) })
export type FlowEdge = z.infer<typeof FlowEdge>

export const START = 'start'
export const END = 'end'

/**
 * 流程：节点和连线组成的有向图，自由摆放。从「开始」出发，一个节点的上游全部完成后才执行它，
 * 没有依赖关系的节点同时执行。一个工作流可以有多个流程，其中一个是主流程（任务从这里开始），
 * 其余是子流程，供节点的开始 / 验收 / 结束入口或流程节点调用。
 */
export const Flow = z.object({
  id: z.string().min(1),
  name: z.string().trim().max(40).default(''),
  description: z.string().trim().max(200).default(''),
  nodes: z.array(FlowNode).max(100).default([]),
  edges: z.array(FlowEdge).max(400).default([]),
  /** 开始、结束两个端点在画布上的位置 */
  startPos: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  endPos: z.object({ x: z.number(), y: z.number() }).default({ x: 600, y: 0 }),
})
export type Flow = z.infer<typeof Flow>

const rid = () => Math.random().toString(36).slice(2, 10)

/**
 * 旧版的「阶段」流程（阶段依次执行、阶段内并行）转换成连线：
 * 每个阶段的节点连到下一阶段的所有节点，位置按阶段排成列。
 */
export function stagesToFlow(stages: { title?: string; nodes?: Record<string, unknown>[] }[]) {
  const cols = stages.filter((s) => s.nodes?.length)
  const nodes: Record<string, unknown>[] = []
  const edges: { id: string; from: string; to: string }[] = []
  let prev: string[] = [START]
  const COL = 300
  const ROW = 150
  cols.forEach((c, ci) => {
    const ids: string[] = []
    c.nodes!.forEach((n, ni) => {
      const id = String(n.id ?? `nd_${rid()}`)
      ids.push(id)
      nodes.push({
        ...n,
        id,
        x: 240 + ci * COL,
        y: (ni - (c.nodes!.length - 1) / 2) * ROW,
      })
      for (const p of prev) edges.push({ id: `e_${rid()}`, from: p, to: id })
    })
    prev = ids
  })
  for (const p of prev) if (p !== START || !cols.length) edges.push({ id: `e_${rid()}`, from: p, to: END })
  return {
    id: 'main',
    name: '主流程',
    nodes,
    edges: cols.length ? edges : [],
    startPos: { x: 0, y: 0 },
    endPos: { x: 240 + cols.length * COL, y: 0 },
    description: '',
  }
}

/** 读旧数据时把阶段转换成流程 */
function migrateWorkflow(v: unknown) {
  if (!v || typeof v !== 'object') return v
  const w = v as Record<string, unknown>
  if (Array.isArray(w.flows) && w.flows.length) return w
  const stages = Array.isArray(w.stages) ? (w.stages as { nodes?: Record<string, unknown>[] }[]) : []
  const { stages: _, ...rest } = w
  return { ...rest, flows: [stagesToFlow(stages)], entryFlowId: 'main' }
}

/**
 * 工作流：一个主 Agent 和若干子 Agent 组成团队，用流程图编排执行顺序。
 * 主 Agent 执行没指定 Agent 的节点，并在流程完成后处理用户的追加要求。
 */
const WorkflowFields = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(40),
  description: z.string().trim().max(200).default(''),
  /** 主 Agent；为空表示还没选 */
  mainAgentId: z.string().default(''),
  members: z.array(WorkflowMember).default([]),
  /** 流程：第一个默认是主流程；entryFlowId 指定任务从哪个流程开始 */
  flows: z.array(Flow).min(1).max(20),
  entryFlowId: z.string().default('main'),
  /** 工作流说明（Markdown）：目标、规范、完成标准等，每个节点执行时都会带上 */
  document: z.string().max(50000).default(''),
})
export const WorkflowInput = z.preprocess(migrateWorkflow, WorkflowFields)
export type WorkflowInput = z.infer<typeof WorkflowFields>

export const Workflow = z.preprocess(migrateWorkflow, WorkflowFields.extend(Meta.shape))
export type Workflow = z.infer<typeof WorkflowFields> & z.infer<typeof Meta>

export interface CliStatus {
  id: string
  name: string
  /** 实际使用的可执行文件（设置里改过就是改后的值） */
  command: string
  /** 设置里是否启用 */
  enabled: boolean
  installed: boolean
  version?: string
  /** 检测失败的原因 */
  error?: string
  /** 是否是设置里的默认 CLI（Agent 选「系统默认」时使用） */
  isDefault?: boolean
  /** 实际运行的文件（按 PATH 找到的） */
  path?: string
  /** 安装方式：npm 全局包、Claude Code 官方安装脚本、Homebrew、其他；更新和卸载用对应的方式 */
  source?: 'npm' | 'native' | 'brew' | 'other'
  models: { id: string; label: string }[]
  docsUrl: string
}

/** 在设置里安装 / 卸载 CLI 的一次操作 */
export interface CliInstallJob {
  id: string
  cli: string
  action: 'install' | 'uninstall'
  status: 'running' | 'done' | 'failed'
  /** 实际执行的命令，失败时用户可以复制到终端自己运行 */
  command: string
  /** npm 的输出（只保留最后一段） */
  log: string
  error?: string
  /** 完成后重新检测到的状态 */
  cliStatus?: CliStatus
  /** 安装时本来就装着：其实是更新 */
  update?: boolean
  /** 完成时的补充说明，例如「已改用 npm 安装的那个」 */
  note?: string
}

/** 已安装版本和 npm 上的最新版本 */
export interface CliUpdate {
  current?: string
  latest?: string
  /** 有更新的版本可以装 */
  available: boolean
  /** 查不到最新版本的原因（没网等），这时不显示更新按钮 */
  error?: string
}

/** 从本机 CLI 读到的模型 */
export interface CliModel {
  id: string
  label: string
  description?: string
  /** 支持的思考强度；不知道时省略 */
  efforts?: string[]
  /** CLI 自己的默认模型 */
  isDefault?: boolean
  /** 这个模型默认的思考强度 */
  defaultEffort?: string
  /** 分组，例如 Command Code 的「Open Source」「Google」 */
  group?: string
  /** cli：CLI 自己提供的（账号可用的、内置的）；config：配置文件里接的第三方 API */
  origin?: 'cli' | 'config'
}

export interface CliModels {
  /** cli：从本机 CLI 读到；builtin：读不到时用内置的建议列表 */
  source: 'cli' | 'builtin'
  models: CliModel[]
  /** 这个 CLI 所有模型支持的思考强度的并集；空表示沿用内置列表 */
  efforts: string[]
  /** 读取失败的原因（这时 models 是内置列表） */
  error?: string
  /** 登录方式：account 是账号登录，列出账号能用的全部模型；api 是 API Key / 自定义接口，列出配置文件里配的模型 */
  auth?: 'account' | 'api'
  /** 模型从哪读的，例如「~/.codex/config.toml」，显示在设置里 */
  from?: string
}

/** 项目分类：同一类项目共用一个默认工作流，例如「Web 应用」「游戏客户端」 */
export const ProjectCategoryInput = z.object({
  name: z.string().trim().min(1, '分类名不能为空').max(20),
  description: z.string().trim().max(200).default(''),
  /** 默认工作流；为空表示还没指定 */
  workflowId: z.string().default(''),
})
export type ProjectCategoryInput = z.infer<typeof ProjectCategoryInput>

export const ProjectCategory = ProjectCategoryInput.extend(Meta.shape)
export type ProjectCategory = z.infer<typeof ProjectCategory>

/** 项目：本机上的一个目录，Agent 会在这个目录里按工作流执行任务 */
export const ProjectInput = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(40),
  description: z.string().trim().max(200).default(''),
  /** 本机绝对路径 */
  path: z.string().trim().default(''),
  categoryId: z.string().default(''),
  /** 单独指定的工作流；为空时使用分类的默认工作流 */
  workflowId: z.string().default(''),
})
export type ProjectInput = z.infer<typeof ProjectInput>

export const Project = ProjectInput.extend(Meta.shape)
export type Project = z.infer<typeof Project>

/** 本地目录检测结果 */
export interface DirInfo {
  path: string
  exists: boolean
  isDir: boolean
  /** 是 git 仓库时的当前分支（分离 HEAD 时为提交号前 7 位） */
  gitBranch: string | null
}

export interface DirListing {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
  /** 快速入口：Windows 上是各个盘符，其他系统是主目录和根目录 */
  roots?: { name: string; path: string }[]
}

/**
 * 任务：在某个项目里执行的一次工作。
 * - workflow：按工作流的流程图执行，阶段依次推进，阶段内的节点并行
 * - chat：直接和一个 Agent 对话
 * 创建后用户可以继续追加要求，每次追加会触发新一轮执行。
 */
export const TaskMode = z.enum(['workflow', 'chat'])
export type TaskMode = z.infer<typeof TaskMode>

export const NewTaskInput = z.object({
  projectId: z.string().min(1, '缺少项目'),
  mode: TaskMode,
  /** workflow 模式：为空时用项目的工作流 */
  workflowId: z.string().default(''),
  /** chat 模式：对话的 Agent */
  agentId: z.string().default(''),
  prompt: z.string().trim().min(1, '请描述任务').max(20000),
})
export type NewTaskInput = z.infer<typeof NewTaskInput>

export const FollowUpInput = z.object({ text: z.string().trim().min(1, '内容不能为空').max(20000) })
/** 可以直接修改的任务字段 */
export const TaskPatch = z.object({ title: z.string().trim().min(1, '标题不能为空').max(80) }).partial()

/** Agent 在一条消息里做的操作：读文件、改文件、跑命令、搜索 */
export const ToolUse = z.object({
  kind: z.enum(['read', 'edit', 'run', 'search', 'other']),
  label: z.string(),
  detail: z.string().default(''),
  /** 点开工具调用时显示：完整命令、参数或改动内容 */
  input: z.string().optional(),
  /** 工具的输出（命令输出、读到的内容、错误），过长时截断 */
  output: z.string().optional(),
  /** 工具执行失败 */
  failed: z.boolean().optional(),
})
export type ToolUse = z.infer<typeof ToolUse>

export const TaskMessage = z.object({
  id: z.string(),
  role: z.enum(['user', 'agent', 'system']),
  agentId: z.string().default(''),
  /** 属于哪个任务节点（task.steps 的 id）；为空表示不属于任何节点（追问、对话） */
  step: z.string().default(''),
  text: z.string().default(''),
  tools: z.array(ToolUse).default([]),
  /** 生成这段回复前的思考过程（CLI 给出的思考或推理摘要） */
  thinking: z.string().optional(),
  at: z.string(),
})
export type TaskMessage = z.infer<typeof TaskMessage>

export const StepStatus = z.enum(['pending', 'running', 'done', 'failed', 'skipped'])
export type StepStatus = z.infer<typeof StepStatus>

/**
 * 任务里执行过（或将要执行）的一个节点。主流程的节点在任务创建时就列出来；
 * 节点的开始 / 验收 / 结束流程、流程节点里的子节点在执行时才加进来，用 parentId 挂在发起它的节点下。
 */
export const TaskStep = z.object({
  /** 路径形式的唯一 id，也是 CLI 会话键：主流程节点就是节点 id，子节点形如 `n1/review.2/n5` */
  id: z.string(),
  parentId: z.string().default(''),
  /** 在父节点里的位置：start / review / end 是三个入口，body 是流程节点执行的流程 */
  slot: z.enum(['', 'start', 'review', 'end', 'body']).default(''),
  /** 验收的第几轮（从 1 开始）；不是验收流程里的节点为 0 */
  round: z.number().int().default(0),
  workflowId: z.string().default(''),
  flowId: z.string().default(''),
  nodeId: z.string().default(''),
  kind: z.enum(['agent', 'flow']).default('agent'),
  title: z.string(),
  agentId: z.string().default(''),
  status: StepStatus.default('pending'),
  startedAt: z.string().default(''),
  endedAt: z.string().default(''),
  /** 节点的最终输出（交给下游节点），续跑时直接复用 */
  output: z.string().default(''),
  /** 验收结果；节点上记录最后一轮的结论 */
  verdict: z.enum(['', 'pass', 'fail']).default(''),
  /** 已经验收了几轮 */
  rounds: z.number().int().default(0),
  /** 执行到一半被停止或面板重启打断；继续执行时续接这个节点的 CLI 会话，从中断的地方接着做 */
  interrupted: z.boolean().default(false),
})
export type TaskStep = z.infer<typeof TaskStep>

export const FileChange = z.object({ path: z.string(), add: z.number().int(), del: z.number().int() })
export type FileChange = z.infer<typeof FileChange>

export const TaskStatus = z.enum(['running', 'done', 'failed', 'stopped'])
export type TaskStatus = z.infer<typeof TaskStatus>

export const AgentUsage = z.object({
  context: z.number(),
  window: z.number(),
  model: z.string().default(''),
  /** 正在输出时的速度（token/秒），没在输出时为 0 */
  tps: z.number().default(0),
  /** 这个 Agent 累计输出的 token 和花在生成上的时间，用来算平均速度 */
  outputTokens: z.number().default(0),
  genMs: z.number().default(0),
})
export type AgentUsage = z.infer<typeof AgentUsage>

export const TaskTodo = z.object({
  text: z.string(),
  status: z.enum(['pending', 'running', 'done']),
  agentId: z.string().default(''),
})
export type TaskTodo = z.infer<typeof TaskTodo>

export const TaskData = z.object({
  projectId: z.string(),
  title: z.string(),
  mode: TaskMode,
  workflowId: z.string().default(''),
  agentId: z.string().default(''),
  status: TaskStatus,
  /** 所有节点：主流程的节点按执行顺序排在前面，执行中产生的子节点追加在后面 */
  steps: z.array(TaskStep).default([]),
  messages: z.array(TaskMessage).default([]),
  changes: z.array(FileChange).default([]),
  /** 在线演示里的任务，输出是示例 */
  simulated: z.boolean().default(true),
  /** CLI 会话 id，用于续接：工作流节点按节点 id 记，对话和追加要求按 Agent id 记 */
  sessions: z.record(z.string(), z.string()).default({}),
  /** 用量：每个 Agent 最近一次的上下文占用和实时速度，以及累计 token 和费用 */
  usage: z
    .object({
      agents: z.record(z.string(), AgentUsage).default({}),
      /** 输入 token（含缓存命中和缓存写入的部分） */
      inputTokens: z.number().default(0),
      outputTokens: z.number().default(0),
      /** 输入里命中缓存的部分 */
      cacheReadTokens: z.number().default(0),
      /** 输入里写入缓存的部分 */
      cacheWriteTokens: z.number().default(0),
      costUsd: z.number().default(0),
    })
    .default({ agents: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }),
  /** CLI 维护的待办清单（Claude Code 的 TodoWrite、Codex 的计划），对话任务的进度看它 */
  todos: z.array(TaskTodo).default([]),
  /** 任务开始时项目里已有的未提交改动（git numstat），统计改动时排除 */
  baseline: z.record(z.string(), z.string()).default({}),
})
export type TaskData = z.infer<typeof TaskData>

/** 旧任务的消息用节点下标记录所属节点，换成节点 id */
function migrateTask(v: unknown) {
  if (!v || typeof v !== 'object') return v
  const t = v as { steps?: { id?: string }[]; messages?: { step?: unknown }[] }
  const steps = (t.steps ?? []).map((s, i) => ({
    ...s,
    id: s.id ?? `s${i}`,
    nodeId: (s as any).nodeId ?? s.id ?? `s${i}`,
  }))
  const messages = (t.messages ?? []).map((m) =>
    typeof m.step === 'number' ? { ...m, step: m.step >= 0 ? (steps[m.step]?.id ?? '') : '' } : m,
  )
  return { ...t, steps, messages }
}

export const Task = z.preprocess(migrateTask, TaskData.extend(Meta.shape))
export type Task = z.infer<typeof TaskData> & z.infer<typeof Meta>

/** 一个档位：模型和思考强度；旧数据只有模型名 */
export const TierSetting = z.preprocess(
  (v) => (typeof v === 'string' ? { model: v } : (v ?? {})),
  z.object({ model: z.string().trim().default(''), effort: z.string().trim().default('') }),
)
export type TierSetting = z.infer<typeof TierSetting>

/** 单个 CLI 的本机设置 */
export const CliSettings = z.object({
  enabled: z.boolean().default(true),
  /** 可执行文件；为空时用默认命令名（从 PATH 查找） */
  command: z.string().trim().default(''),
  /** Agent 没有指定模型时使用；可以是具体模型，也可以是档位 @high / @medium / @low */
  defaultModel: z.string().trim().default(''),
  /** Agent 和档位都没指定思考强度时使用；为空不传 */
  defaultEffort: z.string().trim().default(''),
  /** 高 / 中 / 低三档对应的模型和思考强度；为空用内置的建议值 */
  tiers: z
    .object({ high: TierSetting, medium: TierSetting, low: TierSetting })
    .default({ high: { model: '', effort: '' }, medium: { model: '', effort: '' }, low: { model: '', effort: '' } }),
  /** 权限模式，取值见 shared/clis.ts 里各 CLI 的 permissions */
  permission: z.string().default(''),
  /** 每次调用都追加的参数 */
  extraArgs: z.array(z.string()).default([]),
  /** 追加的环境变量，例如 API Key、代理 */
  env: z.array(z.object({ key: z.string().trim(), value: z.string() })).default([]),
})
export type CliSettings = z.infer<typeof CliSettings>

export const Settings = z.object({
  /** 单个步骤最长运行时间（分钟），超时会停止 */
  stepTimeoutMinutes: z.number().int().min(1).max(600).default(60),
  /** Agent 选「系统默认」时使用的 CLI */
  defaultCli: z.string().default('claude'),
  clis: z.record(z.string(), CliSettings).default({}),
  /** CLI 的显示顺序（设置侧栏、默认 CLI、Agent 的 CLI 选项）；没列出的排在后面 */
  cliOrder: z.array(z.string()).default([]),
  /** 服务启动后用默认浏览器打开面板（只在托管了前端页面时生效，开发模式下页面在 Vite 那边） */
  openBrowser: z.boolean().default(true),
  /** AI 创建 / 优化 Agent 和工作流 */
  assist: z
    .object({
      /** 默认用哪个 CLI；为空时用第一个已安装的 */
      cli: z.string().default(''),
      model: z.string().trim().default(''),
      /** 用户补充的创建规则，会加进提示词 */
      agentRules: z.string().max(8000).default(''),
      workflowRules: z.string().max(8000).default(''),
    })
    .default({ cli: '', model: '', agentRules: '', workflowRules: '' }),
})
export type Settings = z.infer<typeof Settings>
