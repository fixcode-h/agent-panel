import { FlowRun } from '@shared/task-flow-schema'
import type { NewTaskInput, Workflow } from '@shared/schema'

/**
 * 演示里的工作流任务按「工作流运行」建（带 flowRun）。工作流改成独立运行后（4304d14），引擎只跑带 flowRun 的工作流任务，
 * 没带的当旧版任务直接报「不能继续执行」：演示里的工作流任务全成了失败、没有运行记录，界面检查里靠它们造数据的用例
 * （运行区的工作流行、子对话里的运行视图、节点与子 Agent）前提都不成立。演示没有真的父对话派它，归属记在请求里的父对话上；
 * 演示没有真的仓库可合回，按只读运行跑完直接完成
 */
export const demoFlowRun = (input: NewTaskInput, workflow: Workflow) =>
  FlowRun.parse({ owner: input.parentTaskId ?? '', workflowName: workflow.name, kind: 'readonly', input: input.prompt })
