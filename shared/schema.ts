import { z } from 'zod'

/**
 * Agent：一个可复用的「CLI + 模型 + 角色设定」组合。
 * 主 / 子 Agent 不在这里区分，而是在工作流里指定。
 */
export const AgentInput = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(40),
  description: z.string().trim().max(200).default(''),
  cli: z.string().min(1, '请选择 CLI'),
  model: z.string().trim().default(''),
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
 * 工作流：指定一个主 Agent 和若干子 Agent，再用一份 Markdown 文档描述执行步骤。
 * 项目分类会选择一个工作流，执行时主 Agent 按文档逐步推进，并把步骤分派给子 Agent。
 */
export const WorkflowInput = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(40),
  description: z.string().trim().max(200).default(''),
  /** 主 Agent；为空表示还没选 */
  mainAgentId: z.string().default(''),
  members: z.array(WorkflowMember).default([]),
  /** 工作流文档（Markdown），可以用 @Agent名称 指定某一步由谁执行 */
  document: z.string().max(50000).default(''),
})
export type WorkflowInput = z.infer<typeof WorkflowInput>

export const Workflow = WorkflowInput.extend(Meta.shape)
export type Workflow = z.infer<typeof Workflow>

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
  models: { id: string; label: string }[]
  docsUrl: string
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
}

/**
 * 任务：在某个项目里执行的一次工作。
 * - workflow：按工作流执行，主 Agent 按文档步骤推进，步骤分派给子 Agent
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

/** Agent 在一条消息里做的操作：读文件、改文件、跑命令、搜索 */
export const ToolUse = z.object({
  kind: z.enum(['read', 'edit', 'run', 'search', 'other']),
  label: z.string(),
  detail: z.string().default(''),
})
export type ToolUse = z.infer<typeof ToolUse>

export const TaskMessage = z.object({
  id: z.string(),
  role: z.enum(['user', 'agent', 'system']),
  agentId: z.string().default(''),
  /** 属于第几个步骤；-1 表示不属于任何步骤（追问、对话） */
  step: z.number().int().default(-1),
  text: z.string().default(''),
  tools: z.array(ToolUse).default([]),
  at: z.string(),
})
export type TaskMessage = z.infer<typeof TaskMessage>

export const TaskStep = z.object({
  title: z.string(),
  agentId: z.string().default(''),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']).default('pending'),
})
export type TaskStep = z.infer<typeof TaskStep>

export const FileChange = z.object({ path: z.string(), add: z.number().int(), del: z.number().int() })
export type FileChange = z.infer<typeof FileChange>

export const TaskStatus = z.enum(['running', 'done', 'failed', 'stopped'])
export type TaskStatus = z.infer<typeof TaskStatus>

export const TaskData = z.object({
  projectId: z.string(),
  title: z.string(),
  mode: TaskMode,
  workflowId: z.string().default(''),
  agentId: z.string().default(''),
  status: TaskStatus,
  steps: z.array(TaskStep).default([]),
  messages: z.array(TaskMessage).default([]),
  changes: z.array(FileChange).default([]),
  /** 模拟执行（设置里选了模拟，或在线演示） */
  simulated: z.boolean().default(true),
  /** 每个 Agent 在 CLI 里的会话 id，用于续接 */
  sessions: z.record(z.string(), z.string()).default({}),
  /** 用量：每个 Agent 最近一次的上下文占用，以及累计 token 和费用 */
  usage: z
    .object({
      agents: z
        .record(z.string(), z.object({ context: z.number(), window: z.number(), model: z.string().default('') }))
        .default({}),
      inputTokens: z.number().default(0),
      outputTokens: z.number().default(0),
      costUsd: z.number().default(0),
    })
    .default({ agents: {}, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
  /** 任务开始时项目里已有的未提交改动（git numstat），统计改动时排除 */
  baseline: z.record(z.string(), z.string()).default({}),
})
export type TaskData = z.infer<typeof TaskData>

export const Task = TaskData.extend(Meta.shape)
export type Task = z.infer<typeof Task>

/** 单个 CLI 的本机设置 */
export const CliSettings = z.object({
  enabled: z.boolean().default(true),
  /** 可执行文件；为空时用默认命令名（从 PATH 查找） */
  command: z.string().trim().default(''),
  /** Agent 没有指定模型时使用 */
  defaultModel: z.string().trim().default(''),
  /** 权限模式，取值见 shared/clis.ts 里各 CLI 的 permissions */
  permission: z.string().default(''),
  /** 每次调用都追加的参数 */
  extraArgs: z.array(z.string()).default([]),
  /** 追加的环境变量，例如 API Key、代理 */
  env: z.array(z.object({ key: z.string().trim(), value: z.string() })).default([]),
})
export type CliSettings = z.infer<typeof CliSettings>

export const Settings = z.object({
  /** real：真正调用本机 CLI；simulate：只生成示例输出，用来熟悉界面 */
  execution: z.enum(['real', 'simulate']).default('real'),
  /** 单个步骤最长运行时间（分钟），超时会停止 */
  stepTimeoutMinutes: z.number().int().min(1).max(600).default(60),
  clis: z.record(z.string(), CliSettings).default({}),
})
export type Settings = z.infer<typeof Settings>
