import { mcpToolOf, toolArgs } from '@/lib/tasks'
import type { ToolUse } from '@shared/schema'
import { usePlugins } from './registry'
import type { ToolCard, WebPlugin } from './sdk'

/**
 * 插件登记的工具卡片（WebPlugin.toolCards）：对话里一次 MCP 工具调用归哪张卡片画。
 * 按工具名认（不看服务名：同一个插件的工具在不同 CLI 里挂的服务名不一样），两个插件登记了同一个工具时用先登记的
 */
export function pickToolCard(
  plugins: Iterable<[string, Pick<WebPlugin, 'toolCards'>]>,
  tool: Pick<ToolUse, 'name' | 'label' | 'input'>,
): ToolCard | undefined {
  const mcp = mcpToolOf(tool)
  if (!mcp) return undefined
  const args = toolArgs(tool as ToolUse)
  for (const [, p] of plugins)
    for (const c of p.toolCards ?? []) if (c.tool === mcp.tool && (!c.match || c.match(args))) return c
  return undefined
}

/** 工具行下面插件画的卡片；没有插件认领时不画 */
export function PluginToolCard({
  tool,
  running,
  taskId,
  projectId,
}: {
  tool: ToolUse
  running: boolean
  taskId?: string
  projectId?: string
}) {
  const card = pickToolCard(usePlugins().web, tool)
  if (!card) return null
  const { Card } = card
  return (
    <Card
      args={toolArgs(tool)}
      output={tool.output ?? ''}
      running={running}
      failed={!!tool.failed}
      taskId={taskId || undefined}
      projectId={projectId}
    />
  )
}
