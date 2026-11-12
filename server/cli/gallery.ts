import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import {
  GALLERY_SORTS,
  matchQuery,
  mergeItems,
  pageOf,
  parseSearch,
  sortItems,
  type GalleryItem,
  type GalleryPage,
  type GallerySort,
  type GallerySpec,
} from '../../shared/cli/gallery.ts'
import { npmName } from '../../shared/cli-spec.ts'
import { getCli } from '../../shared/clis.ts'
import { t } from '../../shared/i18n.ts'
import { listPackages } from './packages.ts'
import { log } from '../log.ts'
import { netFetch } from '../net.ts'
import { NPMJS } from '../npm-env.ts'
import { CACHE_DIR, readJson, writeJsonAtomic } from '../store.ts'

/**
 * 插件市场（ADR 0050）：从 npm 搜索接口按定义里的关键词取插件。
 * 不全量翻页（Pi 的关键词下有一万多个包，大多数没人用）：没有搜索词时取 npm 默认排序（按热度）的前 1000 个，
 * 在本地按下载、发布时间等排；有搜索词时直接问 npm。走面板的出网（代理回退），和 CLI 的「离线运行」无关
 */

/** 没有搜索词时取这么多（npm 一页最多 250 个） */
export const TOP_PAGES = 4
const PER_PAGE = 250
/** 前 1000 个缓存一小时（npm 的下载数一天才更新一次），搜索结果缓存 10 分钟 */
const TOP_TTL = 60 * 60_000
const QUERY_TTL = 10 * 60_000
const TIMEOUT_MS = 20_000

type Cached = { at: string; items: GalleryItem[] }

export interface GalleryDeps {
  /** 取一个地址的 JSON（测试里换成假的） */
  fetchJson: (url: string) => Promise<unknown>
  /** 前 1000 个的磁盘缓存：面板重启后不用马上重新取 */
  load: (cli: string) => Promise<Cached | null>
  save: (cli: string, c: Cached) => Promise<void>
  now: () => number
}

const searchUrl = (spec: GallerySpec, q: string, from: number) =>
  `${NPMJS}-/v1/search?${new URLSearchParams({
    text: `keywords:${spec.npmKeyword}${q ? ` ${q}` : ''}`,
    size: String(PER_PAGE),
    from: String(from),
  })}`

/** 一个 CLI 的市场数据：内存里一份前 1000 个、一份按搜索词的；过期了重新取，取不到用旧的并说明原因 */
export function makeGallery(deps: GalleryDeps) {
  const top = new Map<string, Cached>()
  const queries = new Map<string, Cached>()

  async function fetchTop(cli: string, spec: GallerySpec): Promise<GalleryItem[]> {
    const pages = await Promise.all(
      Array.from({ length: TOP_PAGES }, (_, i) =>
        deps.fetchJson(searchUrl(spec, '', i * PER_PAGE)).then((j) => parseSearch(j, spec)),
      ),
    )
    const items = mergeItems(pages)
    if (!items.length) throw new Error(t('npm 没有返回 {keyword} 关键词下的包', { keyword: spec.npmKeyword }))
    log.info('cli', '插件市场：更新了热门插件', { cli, count: items.length })
    return items
  }

  async function data(cli: string, spec: GallerySpec, q: string, refresh: boolean) {
    const key = `${cli}\n${q}`
    const ttl = q ? QUERY_TTL : TOP_TTL
    const mem = q ? queries.get(key) : (top.get(cli) ?? (await deps.load(cli)) ?? undefined)
    if (mem && !refresh && deps.now() - Date.parse(mem.at) < ttl) return { ...mem }
    try {
      const items = q ? parseSearch(await deps.fetchJson(searchUrl(spec, q, 0)), spec) : await fetchTop(cli, spec)
      const fresh = { at: new Date(deps.now()).toISOString(), items }
      if (q) queries.set(key, fresh)
      else {
        top.set(cli, fresh)
        await deps.save(cli, fresh).catch(() => {})
      }
      return fresh
    } catch (e) {
      // 联网失败：有旧数据就用旧的，并照实告诉用户没能更新；没有就报错
      const reason = reasonOf(e)
      log.warn('cli', '插件市场：没能从 npm 更新', { cli, error: reason })
      if (mem) return { ...mem, stale: reason }
      throw new Error(
        t('没能从 npm 取到插件列表：{reason}。连不上 npm 时可以在「设置 · 网络与代理」里填写本机代理', { reason }),
      )
    }
  }

  return {
    async page(
      cli: string,
      spec: GallerySpec,
      o: { q?: string; sort?: string; page?: number; refresh?: boolean },
    ): Promise<GalleryPage> {
      const q = (o.q ?? '').trim().slice(0, 100)
      const sort: GallerySort = (GALLERY_SORTS as readonly string[]).includes(o.sort ?? '')
        ? (o.sort as GallerySort)
        : 'monthly'
      const d: Cached & { stale?: string } = await data(cli, spec, q, !!o.refresh)
      return { ...pageOf(sortItems(matchQuery(d.items, q), sort), o.page ?? 1), at: d.at, stale: d.stale }
    },
  }
}

/** 失败原因：报错加上底层原因（netError 的提示是写给 GitHub 的，这里不用） */
function reasonOf(e: unknown) {
  const err = e as Error & { cause?: { message?: string; code?: string } }
  const cause = err.cause?.code || err.cause?.message || ''
  return cause && !err.message.includes(cause) ? `${err.message}（${cause}）` : err.message
}

const fileOf = (cli: string) => path.join(CACHE_DIR, 'cli-gallery', `${cli.replace(/[^\w-]/g, '_')}.json`)

const gallery = makeGallery({
  fetchJson: async (url) => {
    const r = await netFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  },
  load: async (cli) => {
    const c = (await readJson(fileOf(cli)).catch(() => undefined)) as Cached | undefined
    return c && Array.isArray(c.items) && typeof c.at === 'string' ? c : null
  },
  save: async (cli, c) => {
    await mkdir(path.dirname(fileOf(cli)), { recursive: true })
    await writeJsonAtomic(fileOf(cli), c)
  },
  now: () => Date.now(),
})

/** 已装的 npm 包在 npm 上的最新版本：包名 → 版本，取不到的不列 */
export async function latestVersions(
  names: string[],
  fetchJson: (url: string) => Promise<unknown>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    [...new Set(names)].map(async (name) => {
      const v = await fetchJson(`${NPMJS}${name}/latest`)
        .then((j) => (j as { version?: unknown })?.version)
        .catch(() => undefined)
      if (typeof v === 'string' && v) out[name] = v
    }),
  )
  return out
}

export function galleryApi() {
  const app = new Hono()
  app.get('/:id/gallery', async (c) => {
    const def = getCli(c.req.param('id'))
    const spec = def?.packages?.gallery
    if (!def || !spec) return c.json({ error: t('这个 Agent 没有插件市场') }, 400)
    try {
      return c.json(
        await gallery.page(def.id, spec, {
          q: c.req.query('q'),
          sort: c.req.query('sort'),
          page: Number(c.req.query('page')) || 1,
          refresh: c.req.query('refresh') === '1',
        }),
      )
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })
  // 已装的 npm 包的最新版本：设置页的已装列表标「有新版本」
  app.get('/:id/packages/latest', async (c) => {
    const def = getCli(c.req.param('id'))
    if (!def?.packages) return c.json({})
    const names = (await listPackages(def as Parameters<typeof listPackages>[0])).map((p) => npmName(p.source))
    return c.json(
      await latestVersions(names.filter(Boolean), async (url) => {
        const r = await netFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      }),
    )
  })
  return app
}
