/**
 * 路由记录：每次路由走了哪几条路、用了哪条、为什么跳过（设计稿第 3.7 节）。只给人排查用，不推给对话。
 * 内存里每个项目留最近 RING 条，写一行面板日志；设置页（第三期）从 routeLog 取
 */
import type { RouteLogEntry } from '../../shared/capability-router/types.ts'
import { log } from '../log.ts'

const RING = 100
const byProject = new Map<string, RouteLogEntry[]>() // 模块状态：最近的路由记录，进程内

export function recordRoute(e: RouteLogEntry) {
  const list = byProject.get(e.projectId) ?? []
  list.push(e)
  if (list.length > RING) list.splice(0, list.length - RING)
  byProject.set(e.projectId, list)
  const skipped = e.steps.filter((s) => s.outcome === 'skipped' || s.outcome === 'failed')
  log.info('route', `${e.capability} ${e.what} → ${e.served ?? '没有结果'}（${e.ms}ms）`, {
    entry: e.entry,
    ...(skipped.length && { skipped: skipped.map((s) => `${s.source}：${s.why ?? s.outcome}`) }),
  })
}

/** 最近的路由记录，新的在前 */
export function routeLog(projectId: string): RouteLogEntry[] {
  return [...(byProject.get(projectId) ?? [])].reverse()
}
