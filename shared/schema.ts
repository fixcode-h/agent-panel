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
  command: string
  installed: boolean
  version?: string
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
