import { activePlugins } from '../plugins/index.ts'
import { BUILTIN_AGENTS, type BuiltinAgent } from './agents.ts'
import { BUILTIN_WORKFLOWS, type BuiltinWorkflow } from './workflows.ts'

/**
 * 内置角色和工作流的完整列表 = 核心的 + 开着的插件带的（ADR 0059）。
 * 添加、升级、同步内置副本，内置列表的界面，都从这里取；插件关着时它带的东西不算内置
 * （本机留下的、用户改过的副本当普通角色 / 工作流对待）。
 */
export const builtinAgents = (): BuiltinAgent[] => [...BUILTIN_AGENTS, ...activePlugins().flatMap((p) => p.agents)]

export const builtinWorkflows = (): BuiltinWorkflow[] => [
  ...BUILTIN_WORKFLOWS,
  ...activePlugins().flatMap((p) => p.workflows),
]
