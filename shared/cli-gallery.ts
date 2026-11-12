import { z } from 'zod'

/**
 * 插件市场（ADR 0050）：CLI 的插件按 npm 关键词收录（Pi 是 pi-package，pi.dev/packages 也是这么收的），
 * 面板从 npm 搜索接口取数据、在本地排序。这里只放定义里的字段和纯函数；联网、缓存在 server/cli/gallery.ts
 */
export const GallerySpec = z.object({
  /** npm 关键词：带这个关键词的包算这个 CLI 的插件 */
  npmKeyword: z.string().min(1),
  /** 装的时候来源前面加什么（Pi 是 npm:） */
  sourcePrefix: z.string().default(''),
  /** 官方的插件页，界面上放个链接 */
  pageUrl: z.string().default(''),
  /** npm 关键词 → 类型标签（界面文案）：包自己在关键词里写了才显示 */
  types: z.record(z.string(), z.string()).default({}),
})
export type GallerySpec = z.infer<typeof GallerySpec>

/** 和面板自己的功能重复的包：match 是包名（不带来源前缀），note 写面板哪里已经有了 */
export const GalleryOverlap = z.object({ match: z.string().min(1), note: z.string() })
export type GalleryOverlap = z.infer<typeof GalleryOverlap>

export interface GalleryItem {
  name: string
  /** 装的时候交给命令的来源（前缀 + 包名） */
  source: string
  version: string
  desc: string
  publisher: string
  /** 最近一次发布 */
  date: string
  monthly: number
  weekly: number
  dependents: number
  npmUrl: string
  repoUrl: string
  /** 关键词里认出的类型标签 */
  types: string[]
  /** 包自己写的 npm 关键词：搜索时也比对 */
  keywords: string[]
  /** npm 标了不安全 */
  insecure: boolean
}

export const GALLERY_SORTS = ['monthly', 'weekly', 'recent', 'dependents', 'name'] as const
export type GallerySort = (typeof GALLERY_SORTS)[number]
export const GALLERY_PAGE_SIZE = 50

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** npm 搜索接口（/-/v1/search）的一页结果换成市场里的条目；字段缺了按空的算，不让整页失败 */
export function parseSearch(json: unknown, spec: GallerySpec): GalleryItem[] {
  const objects = (json as { objects?: unknown[] })?.objects
  if (!Array.isArray(objects)) return []
  return objects.flatMap((o: any) => {
    const p = o?.package ?? {}
    const name = str(p.name)
    if (!name) return []
    const keywords: string[] = Array.isArray(p.keywords) ? p.keywords.filter((k: unknown) => typeof k === 'string') : []
    const types = [...new Set(keywords.map((k) => spec.types[k]).filter(Boolean))]
    return [
      {
        name,
        source: `${spec.sourcePrefix}${name}`,
        version: str(p.version),
        desc: str(p.description),
        publisher: str(p.publisher?.username) || str(p.maintainers?.[0]?.username),
        date: str(p.date),
        monthly: num(o.downloads?.monthly),
        weekly: num(o.downloads?.weekly),
        dependents: num(o.dependents),
        npmUrl: str(p.links?.npm) || `https://www.npmjs.com/package/${name}`,
        repoUrl: str(p.links?.repository),
        types,
        keywords,
        insecure: num(o.flags?.insecure) > 0,
      },
    ]
  })
}

/** 合并几页结果：同名的只留第一次出现的 */
export function mergeItems(pages: GalleryItem[][]): GalleryItem[] {
  const seen = new Set<string>()
  return pages.flat().filter((x) => !seen.has(x.name) && !!seen.add(x.name))
}

/**
 * 按搜索词过滤：每个词都要出现在名称、描述、关键词或作者里。npm 按相关度排、但会把关键词下排不上的热门包也带回来，
 * 本地再按下载排就会把不相关的顶到前面
 */
export function matchQuery(items: GalleryItem[], q: string): GalleryItem[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return items
  return items.filter((x) => {
    const text = [x.name, x.desc, x.publisher, ...x.keywords].join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

/** 本地排序；同分时按名字，翻页时顺序稳定 */
export function sortItems(items: GalleryItem[], sort: GallerySort): GalleryItem[] {
  const by: Record<GallerySort, (a: GalleryItem, b: GalleryItem) => number> = {
    monthly: (a, b) => b.monthly - a.monthly,
    weekly: (a, b) => b.weekly - a.weekly,
    recent: (a, b) => b.date.localeCompare(a.date),
    dependents: (a, b) => b.dependents - a.dependents,
    name: () => 0,
  }
  return [...items].sort((a, b) => by[sort](a, b) || a.name.localeCompare(b.name))
}

/** 第几页（从 1 起）；超出范围的落到最后一页 */
export function pageOf<T>(items: T[], page: number, size = GALLERY_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const p = Math.min(Math.max(1, Math.trunc(page) || 1), pages)
  return { items: items.slice((p - 1) * size, p * size), page: p, pages, total: items.length }
}

/** 这个包和面板哪项功能重复（定义里的 overlaps），没有就是空串 */
export const overlapNote = (name: string, overlaps: GalleryOverlap[]) =>
  overlaps.find((o) => o.match.toLowerCase() === name.toLowerCase())?.note ?? ''

/** 装之前要先看源码的理由：npm 标了不安全、或者没有仓库链接（看不到源码） */
export function cautionOf(x: Pick<GalleryItem, 'insecure' | 'repoUrl'>): 'insecure' | 'noRepo' | '' {
  if (x.insecure) return 'insecure'
  if (!x.repoUrl) return 'noRepo'
  return ''
}

/** 市场接口返回的一页 */
export interface GalleryPage {
  items: GalleryItem[]
  page: number
  pages: number
  total: number
  /** 数据取到的时间 */
  at: string
  /** 这次没能更新、用的是旧数据时的原因 */
  stale?: string
}
