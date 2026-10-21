import { t } from './i18n.ts'

/** 排序只关心这几项：添加时间、用户拖出来的顺序，以及兜底的 id */
export type OrderedProject = { id: string; createdAt: string; sortOrder?: number }

const byCreatedAt = (a: OrderedProject, b: OrderedProject) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/**
 * 项目在侧栏里的顺序：拖拽过（sortOrder > 0）的按它排，没拖过的按添加时间排在后面。
 * 刚新建的项目还没有 sortOrder，所以总是落在最后；从没拖过时全部按添加时间，和最近任务无关。
 */
export function compareProjects(a: OrderedProject, b: OrderedProject) {
  const ao = typeof a.sortOrder === 'number' && a.sortOrder > 0 ? a.sortOrder : 0
  const bo = typeof b.sortOrder === 'number' && b.sortOrder > 0 ? b.sortOrder : 0
  if (ao && bo) return ao - bo || byCreatedAt(a, b)
  if (ao !== bo) return ao ? -1 : 1
  return byCreatedAt(a, b)
}

/** 排好序的新数组，不改传入的列表 */
export function sortProjects<T extends OrderedProject>(list: T[]): T[] {
  return [...list].sort(compareProjects)
}

/**
 * 校验一次重排请求：每个 id 都要存在、不能重复，而且必须列出全部项目。
 * 全有或全无，才不会因为漏掉一个项目把它的顺序弄丢。返回错误文案，没问题时返回 null。
 */
export function projectOrderError(projects: { id: string }[], ids: string[]): string | null {
  const known = new Set(projects.map((p) => p.id))
  const seen = new Set<string>()
  for (const id of ids) {
    if (!known.has(id)) return t('项目顺序里有不存在的项目：{id}', { id })
    if (seen.has(id)) return t('项目顺序里有重复的项目：{id}', { id })
    seen.add(id)
  }
  if (seen.size !== known.size) return t('项目顺序里缺了项目，要列出全部项目')
  return null
}

/** 按给定顺序重新编号 1、2、3…，避免长期拖动后编号之间的空隙耗尽 */
export function orderProjects<T extends { id: string }>(list: T[], ids: string[]): T[] {
  const byId = new Map(list.map((p) => [p.id, p]))
  return ids.map((id, i) => ({ ...byId.get(id)!, sortOrder: i + 1 }))
}
