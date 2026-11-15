import { useEffect } from 'react'
import type { Project } from '@shared/schema'
import { sortProjects } from '@shared/projects/order'
import { useData, useNav, type Route } from '@/lib/data'

/**
 * 侧栏的「当前项目」（设计稿：Agent侧栏与项目管理重设计 方案 B）：
 * 地址里有项目（项目首页、项目里的对话、项目工具页）就用它；否则用上次看过的项目，记在本机浏览器里；
 * 都没有时取排在最前面的项目。项目下拉、项目工具、项目对话列表、按项目的插件页都认这一个
 */
const KEY = 'current-project'

export function readLastProject() {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberProject(id: string) {
  try {
    localStorage.setItem(KEY, id)
  } catch {}
}

/** 地址里带的项目：项目页的 id，或项目工具页（按项目的插件页）的 project */
export function routeProject(route: Route) {
  if (route.page === 'projects') return route.id
  if (route.page === 'plugin') return route.project
  return undefined
}

export function pickCurrentProject(projects: Project[], route: Route, last = readLastProject()) {
  const byId = (id?: string) => (id ? projects.find((p) => p.id === id) : undefined)
  return byId(routeProject(route)) ?? byId(last) ?? sortProjects(projects)[0]
}

/** 当前项目；地址里换了项目时顺手记下来，下次从功能页、首页回来还是它 */
export function useCurrentProject() {
  const { route } = useNav()
  const { projects } = useData()
  const fromRoute = routeProject(route)
  const known = !!fromRoute && projects.some((p) => p.id === fromRoute)
  useEffect(() => {
    if (known && fromRoute) rememberProject(fromRoute)
  }, [known, fromRoute])
  return pickCurrentProject(projects, route)
}
