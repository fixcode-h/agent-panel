import { z } from 'zod'

export const AgentRole = z.enum(['main', 'sub'])
export type AgentRole = z.infer<typeof AgentRole>

/** 用户可编辑的字段 */
export const AgentInput = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(40),
  description: z.string().trim().max(200).default(''),
  cli: z.string().min(1, '请选择 CLI'),
  model: z.string().trim().default(''),
  role: AgentRole.default('sub'),
  /** 卡片上显示的图标，可选值见 web/src/lib/agent-icons.ts */
  icon: z.string().default('bot'),
  /** 角色设定 / 系统提示词，执行时会拼在任务前面 */
  instructions: z.string().max(8000).default(''),
  /** 追加给 CLI 的参数，例如 --dangerously-skip-permissions */
  extraArgs: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
})
export type AgentInput = z.infer<typeof AgentInput>

export const Agent = AgentInput.extend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Agent = z.infer<typeof Agent>

export interface CliStatus {
  id: string
  name: string
  command: string
  installed: boolean
  version?: string
  models: { id: string; label: string }[]
  docsUrl: string
}
