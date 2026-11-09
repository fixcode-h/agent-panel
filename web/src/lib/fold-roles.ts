/**
 * 回复里每样东西在折叠里算哪一类：干活、派单、收尾 / 协调、要人看（设计稿：回复折叠与派单行重设计 §3）。
 * 只看工具种类和消息种类，不看回复写了什么（ADR 0041 / 0049）
 */
import type { TaskMessage, ToolUse } from '@shared/schema'
import { PANEL_TOOL_ROLE, isToolLookup, type PanelToolName, type ToolRole } from '@shared/panel-tools'
import { panelCallName } from './tasks'

/** 一次工具调用算哪一类：面板工具查表，别的工具（读、改、跑、搜、网页、别家 MCP、CLI 自己的子 Agent）都算干活 */
export function toolRole(tool: ToolUse): ToolRole {
  // 按需加载工具定义（ToolSearch）和压缩上下文不是干活：AI 写完总结再查一下 spawn_agents 的用法很常见，
  // 算成干活的话总结又会被当成过程里的说明
  if (tool.kind === 'compact' || isToolLookup(tool.name ?? '')) return 'wrap'
  const name = panelCallName(tool)
  if (!name) return 'work'
  return PANEL_TOOL_ROLE[name as PanelToolName] ?? 'work'
}

/**
 * 这条消息算不算「干了活」：Agent 自己调了干活的工具。面板推回的结果（子对话汇报、后台命令结果）不算：
 * 它们常在总结之后才进来（父对话已经收尾、子对话这时才汇报），算成干活的话总结就没了
 */
export function didWork(m: TaskMessage) {
  return m.role === 'agent' && m.tools.some((x) => toolRole(x) === 'work')
}

/** 这条消息里有没有派单：派单工具，或者记着派出子任务的那条系统消息 */
export const hasDispatch = (m: TaskMessage) =>
  !!m.spawned?.length || (m.role === 'agent' && m.tools.some((x) => toolRole(x) === 'dispatch'))
