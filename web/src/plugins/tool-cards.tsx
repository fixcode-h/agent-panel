import type { ReactNode } from 'react'
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

/**
 * 有插件认领的工具调用：工具那一行和插件的卡片画成一个整体（同一个外框、左右对齐），
 * 一眼看出卡片就是这次调用的详情，不是另一件事（用户 2026-11-26 指出分成两个框还缩进一截看着不对）。
 * 没有插件认领时原样画那一行
 */
export function WithToolCard({
  tool,
  running,
  taskId,
  projectId,
  children,
}: {
  tool: ToolUse
  running: boolean
  taskId?: string
  projectId?: string
  children: ReactNode
}) {
  const card = pickToolCard(usePlugins().web, tool)
  if (!card) return <>{children}</>
  const { Card } = card
  return (
    <div data-tool-card={card.tool} className="my-0.5 overflow-hidden rounded-md border border-line">
      {children}
      <div className="border-t border-line">
        <Card
          args={toolArgs(tool)}
          output={tool.output ?? ''}
          running={running}
          failed={!!tool.failed}
          taskId={taskId || undefined}
          projectId={projectId}
        />
      </div>
    </div>
  )
}
