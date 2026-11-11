import type { Task } from '../../shared/schema.ts'

/** 工具行上留的进度行数：只要看到最近到哪了，太多会把对话撑长 */
const PROGRESS_LINES = 30

/**
 * 插件工具报的进度写进对话里这次调用那一行（插件框架改进 G2）。MCP 调用不带 CLI 的工具调用 id，
 * 按「还在跑、标签是 <服务> · <工具>」从最近的往前找（Claude Code 的 MCP 工具行就是这个标签，见 parsers.ts 的 otherTool）；
 * 找不到（别的 CLI 标签不一样）就不显示，不影响工具本身。工具结束时 CLI 报的结果会盖掉这些进度
 */
export function pluginProgress(task: Pick<Task, 'messages'>, server: string, tool: string, text: string) {
  const label = `${server} · ${tool}`
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const row = [...(task.messages[i]!.tools ?? [])].reverse().find((x) => x.running && x.label === label)
    if (!row) continue
    const lines = [...(row.output ? row.output.split('\n') : []), ...text.split('\n')]
    row.output = lines.slice(-PROGRESS_LINES).join('\n')
    return true
  }
  return false
}
