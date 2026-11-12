import { z } from 'zod'
import { timeAgo } from './children/activity.ts'
import { t } from './i18n.ts'

/**
 * 经验、教训「用没用上」的记录：每次 project_experience / project_lessons 把某条的全文交给 Agent、
 * 或改文件时把管这个文件的教训推给模型，记一次命中（次数、最近一次、哪几个对话）。
 * 清理时有据可依：很久没命中的、路径已经不在的，设置页排在前面、标出来。
 * 记录存在面板数据目录（server/knowledge-hits.ts），不写进项目里的经验 / 教训文件：
 * 那些文件常跟项目一起提交，每查一次就改一次会让版本管理里全是噪音。
 */

/** 每条记下最近几个对话就够：用来点开看「谁用上了」，不是完整日志 */
export const HIT_TASKS_MAX = 5

export const KnowledgeHit = z.object({
  count: z.number().int().min(0).catch(0).default(0),
  lastAt: z.string().catch('').default(''),
  /** 最近命中的对话（顶层对话 id），新的在前 */
  taskIds: z.array(z.string()).max(HIT_TASKS_MAX).catch([]).default([]),
})
export type KnowledgeHit = z.infer<typeof KnowledgeHit>

export const KnowledgeHits = z.record(z.string(), KnowledgeHit).catch({})
export type KnowledgeHits = z.infer<typeof KnowledgeHits>

/** 一个项目的两份记录 */
export const ProjectKnowledgeHits = z
  .object({ experience: KnowledgeHits.default({}), lessons: KnowledgeHits.default({}) })
  .prefault({})
export type ProjectKnowledgeHits = z.infer<typeof ProjectKnowledgeHits>
export type KnowledgeKind = keyof ProjectKnowledgeHits

/** 记一次命中：同一批里重复的 id 只算一次 */
export function addHits(hits: KnowledgeHits, ids: string[], taskId: string, at: string): KnowledgeHits {
  const next = { ...hits }
  for (const id of new Set(ids)) {
    if (!id) continue
    const old = next[id] ?? { count: 0, lastAt: '', taskIds: [] }
    next[id] = {
      count: old.count + 1,
      lastAt: at,
      taskIds: taskId ? [taskId, ...old.taskIds.filter((x) => x !== taskId)].slice(0, HIT_TASKS_MAX) : old.taskIds,
    }
  }
  return next
}

/** 只留还在的条目：删掉的经验 / 教训不再占记录 */
export function pruneHits(hits: KnowledgeHits, keep: Iterable<string>): KnowledgeHits {
  const ids = new Set(keep)
  return Object.fromEntries(Object.entries(hits).filter(([id]) => ids.has(id)))
}

/**
 * 设置页「很久没用上」的排序键：没命中过的按建好的时间算（刚记下的不该排到最前），越小越该清。
 * 返回毫秒时间戳；都没有时是 0
 */
export function idleSince(hit: KnowledgeHit | undefined, createdAt = '') {
  const at = Date.parse(hit?.lastAt || createdAt || '')
  return Number.isNaN(at) ? 0 : at
}

/** 按「很久没用上」排：最久没命中的在前，一样时次数少的在前 */
export function sortByIdle<T extends { id: string; createdAt?: string }>(list: T[], hits: KnowledgeHits): T[] {
  return [...list].sort(
    (a, b) =>
      idleSince(hits[a.id], a.createdAt) - idleSince(hits[b.id], b.createdAt) ||
      (hits[a.id]?.count ?? 0) - (hits[b.id]?.count ?? 0),
  )
}

/** 列表里那一小行：「用上 3 次 · 2 天前」，没命中过时「还没用上」 */
export function hitLabel(hit: KnowledgeHit | undefined, now = Date.now()) {
  if (!hit?.count) return t('还没用上')
  const ago = timeAgo(hit.lastAt, now)
  return ago ? t('用上 {n} 次 · {ago}', { n: hit.count, ago }) : t('用上 {n} 次', { n: hit.count })
}

/** GET /projects/:id/knowledge-hits：命中记录，加上面板核对过、已经不存在的路径（条目 id → 路径） */
export interface KnowledgeHitsView extends ProjectKnowledgeHits {
  stale: { experience: Record<string, string[]>; lessons: Record<string, string[]> }
}
