import type { Route } from '@/lib/data'

/**
 * 从盖住侧栏的项目工具页（PluginPage.cover，例如 UE、表格）回到项目时去哪：
 * 回到这个项目里最近看的对话；没看过或最近看的是别的项目，就回到项目首页（新建对话）。
 * 「技能与 MCP」「经验与文档」这类项目页不算对话，不记
 */
const NOT_CHAT = new Set(['capabilities', 'experience', 'settings'])
let last: Route | undefined

/** 侧栏每次渲染时记一下：只记项目里的对话页 */
export function rememberProjectRoute(route: Route) {
  if (route.page === 'projects' && route.id && !NOT_CHAT.has(route.sub ?? '')) last = route
}

export function projectReturnRoute(projectId: string): Route {
  return last?.id === projectId ? last : { page: 'projects', id: projectId }
}
