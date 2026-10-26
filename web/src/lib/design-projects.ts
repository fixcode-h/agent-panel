/**
 * UI 项目主页用的纯逻辑：路由约定、设计列表排序、分类分组、折叠集合。
 * 侧栏（SidebarDesigns）和项目主页（DesignProjectHome）共用这一份，口径只在这里定。
 */
import { DESIGN_KINDS, type DesignKind, type DesignMeta } from '@shared/design'
import { t } from '@shared/i18n'

/**
 * 项目主页借用 `page: 'design'` 的 `id` 字段，和已有的 `'new'`（新建设计）同一个约定：
 * `id` 是 `'new'` 时是新建设计页，`'home'` 时是项目主页（项目 id 放在 `sub`），其余是设计器。
 */
export const DESIGN_HOME = 'home'

/** 打开某个 UI 项目的主页 */
export const designHomeRoute = (projectId: string) => ({ page: 'design' as const, id: DESIGN_HOME, sub: projectId })

/** 侧栏折叠集合里「分类」的键：项目和分类共用一份集合，项目用 id、分类用 `项目id:分类id` */
export const kindFoldKey = (projectId: string, kind: DesignKind) => `${projectId}:${kind}`

/**
 * 分类的显示名字：写成函数而不是常量表，切界面语言时跟着变（常量会在导入时就把当时的语言定下来）。
 * 映射跟着 DesignKind 走，新增一种界面类型只改 shared/design.ts 和这里
 */
const KIND_LABEL: Record<DesignKind, string> = { game: '游戏 UI', web: '网页 UI' }
export const kindLabel = (kind: DesignKind) => t(KIND_LABEL[kind])

/** 一个设计属于哪种界面：老数据没有 kind 时按游戏 UI 算 */
export const designKind = (d: Pick<DesignMeta, 'kind'>): DesignKind => d.kind ?? 'game'

/** 按项目分组的项目主页用列表：最近改过的排前面，同一个时间按标题排，结果稳定 */
export function projectDesigns(designs: DesignMeta[], projectId: string): DesignMeta[] {
  return designs
    .filter((d) => d.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
}

/** 项目主页按类型分组：只保留有设计的类型，顺序跟着 DESIGN_KINDS。组内顺序沿用传进来的（projectDesigns 已经排好） */
export function groupByKind(designs: DesignMeta[]): { kind: DesignKind; items: DesignMeta[] }[] {
  return DESIGN_KINDS.map((kind) => ({ kind, items: designs.filter((d) => designKind(d) === kind) })).filter(
    (g) => g.items.length,
  )
}

/** 项目主页头部的一句话概况：几个界面、最近一次改动是什么时候改的（传 null 表示还没改过） */
export function projectSummary(designs: DesignMeta[], lastEdit: string | null) {
  const games = designs.filter((d) => designKind(d) === 'game').length
  const webs = designs.length - games
  return { total: designs.length, games, webs, lastEdit }
}

/**
 * 折叠集合里点一下：侧栏的箭头按钮和分类行都走这里，只改集合本身，不做别的动作。
 * 项目行上的项目名现在打开项目主页，不再顺带折叠
 */
export function toggleFoldKey(folded: Set<string>, key: string): Set<string> {
  const next = new Set(folded)
  if (!next.delete(key)) next.add(key)
  return next
}
