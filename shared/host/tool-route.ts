/**
 * 工具卡片上的「实际走的路」（ToolUse.route，shared/capability-router/tool-route.ts）：经面板路由的工具（find，以后网关改写的调用）
 * 执行完把走过的路交给宿主，宿主挂到对话里那一行上再推送
 */
import type { ToolRoute } from '../capability-router/tool-route.ts'

/**
 * needle 是这次的查询词：服务端按它在最近几条回复里认出是哪一行
 * （工具调用不带行号，和 knowledge-push 的 tagTool 一样认）
 */
export type NoteToolRoute = (route: ToolRoute, needle: string) => void

export interface ToolRouteHost {
  noteRoute?: NoteToolRoute
}

export interface OrchToolRoute {
  noteRoute?: NoteToolRoute
}
