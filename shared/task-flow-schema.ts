import { z } from 'zod'

/** 工作流的种类（ADR 0044）：change 改代码，跑完由执行角色评审、测试、合回；readonly 一个文件都不写 */
export const WorkflowKind = z.enum(['change', 'readonly'])
export type WorkflowKind = z.infer<typeof WorkflowKind>

/**
 * 工作流子对话（ADR 0044）：父对话 start_workflow 起的那个工作流，记在子对话的任务上。
 * run 是这次的运行号（task.runs 里的 id，还没开始是 0）；handed 是流程图跑完、交给执行角色收尾了；
 * cancelled 是被父对话终止（stop_workflow），之后的消息交给执行角色处理，不再接着跑流程图
 */
export const TaskFlow = z.object({
  workflowId: z.string(),
  workflowName: z.string().default(''),
  input: z.string().default(''),
  kind: WorkflowKind.default('change'),
  run: z.number().int().default(0),
  handed: z.boolean().default(false),
  cancelled: z.boolean().optional(),
})
export type TaskFlow = z.infer<typeof TaskFlow>
