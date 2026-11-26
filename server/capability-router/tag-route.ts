/**
 * 把「实际走的路」（ToolUse.route）挂到对话里这次面板工具调用的那一行上：工具卡片在耗时旁画小标。
 * 面板工具执行时拿不到工具行的编号，只能按工具名和查询词在最近几条回复里认（和 server/hooks/knowledge-push.ts 的 tagTool 同一个办法）
 */
import type { Task, ToolUse } from '../../shared/schema.ts'
import type { ToolRoute } from '../../shared/capability-router/tool-route.ts'

/** 面板 find 的工具行：标题是「服务 · 工具名」（parsers.ts 的 otherTool），旧名 file_index 照样认 */
const FIND_ROW = /·\s*(find|file_index)$/

/**
 * 面板 find 的行按标题认、查询词按 JSON 字符串比（带引号），免得短词撞上别的字段。
 * 网关改道的行（route.from，ADR 0084 第二期）是 Agent 自己调的 Bash、Grep：不看标题，输入里原样有 needle 就是它
 * （命令行的输入就是命令原文，自带搜索的输入是 JSON，调用方已经把关键词写成带引号的）
 */
function rowOf(task: Pick<Task, 'messages'>, needle: string, rerouted: boolean): ToolUse | undefined {
  let seenAgent = 0
  for (let i = task.messages.length - 1; i >= 0 && seenAgent < 3; i--) {
    const m = task.messages[i]
    if (m.role !== 'agent') continue
    seenAgent++
    for (let j = m.tools.length - 1; j >= 0; j--) {
      const t = m.tools[j]
      if (t.route) continue
      const input = t.input ?? ''
      if (rerouted) {
        if (needle && input.includes(needle)) return t
        continue
      }
      if (!FIND_ROW.test(t.label.trim())) continue
      if (!needle || input.includes(JSON.stringify(needle))) return t
    }
  }
  return undefined
}

/** 挂上了返回 true；调用方挂上后推送一次（ctx.changed） */
export function tagRoute(task: Pick<Task, 'messages'>, route: ToolRoute, needle: string): boolean {
  const row = rowOf(task, needle, !!route.from)
  if (!row) return false
  row.route = route
  return true
}

/**
 * 工具行通常在工具执行前就到了（CLI 先报 tool_use 再执行）；个别 CLI 晚一点才报时，等一下再认一次，
 * 还认不出就算了：小标只是显示，路由记录里照样有
 */
export function noteRouteOn(task: Pick<Task, 'messages'>, changed: () => void, retryMs = 1500) {
  return (route: ToolRoute, needle: string) => {
    if (tagRoute(task, route, needle)) return changed()
    setTimeout(() => tagRoute(task, route, needle) && changed(), retryMs).unref?.()
  }
}
