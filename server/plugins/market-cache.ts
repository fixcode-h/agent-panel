import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, writeJsonAtomic } from '../store.ts'
import { DEFAULT_MARKET, readMarket, type MarketEntry } from './github.ts'

/**
 * 插件市场的缓存：读到的 plugins.json 按「仓库@分支」存进数据目录，打开插件页先直接显示缓存，
 * 不用每次都等 GitHub（断网、限流时整块是空的）。只有点「刷新」或缓存太旧（前端判断）才重读；
 * 重读失败时仍然给缓存，并带上这次的错误，界面上写明「显示的是多久前的结果」。
 * 还记着用户最后用的市场仓库，换过的仓库下次打开还是它。
 */
export interface MarketResult {
  repo: string
  /** null：这个仓库没有 plugins.json，整个仓库当作一个插件 */
  plugins: MarketEntry[] | null
  /** 这份列表是什么时候从 GitHub 读到的 */
  fetchedAt: string
  /** 这次重读失败的原因（给的是旧缓存） */
  error?: string
}

interface CacheFile {
  repo?: string
  entries: Record<string, { plugins: MarketEntry[] | null; fetchedAt: string }>
}

/** 测试里换成临时目录 */
export const cacheDeps = {
  file: () => path.join(DATA_DIR, 'plugin-market-cache.json'),
  read: readMarket,
  now: () => new Date(),
}

async function load(): Promise<CacheFile> {
  try {
    const raw = JSON.parse(await readFile(cacheDeps.file(), 'utf8')) as Partial<CacheFile>
    return { repo: typeof raw.repo === 'string' ? raw.repo : undefined, entries: raw.entries ?? {} }
  } catch {
    return { entries: {} }
  }
}

const keyOf = (repo: string, ref = 'HEAD') => `${repo}@${ref}`

/** 最后用的市场仓库（没换过就是默认的） */
export async function currentMarketRepo() {
  return (await load()).repo || DEFAULT_MARKET
}

/**
 * 读市场：refresh 时一定去 GitHub 读；不 refresh 时有缓存给缓存，没有才读。
 * remember：记成「最后用的市场仓库」（插件页上换仓库时传；检查更新顺带读别的仓库时不传）
 */
export async function readMarketCached(
  repo: string,
  opts: { ref?: string; refresh?: boolean; remember?: boolean } = {},
): Promise<MarketResult> {
  const key = keyOf(repo, opts.ref)
  const cache = await load()
  const hit = cache.entries[key]
  const save = (next: CacheFile) => writeJsonAtomic(cacheDeps.file(), next).catch(() => {})
  if (opts.remember && cache.repo !== repo) {
    cache.repo = repo === DEFAULT_MARKET ? undefined : repo
    if (hit && !opts.refresh) await save(cache)
  }
  if (hit && !opts.refresh) return { repo, ...hit }
  try {
    const plugins = (await cacheDeps.read(repo, opts.ref)) ?? null
    const entry = { plugins, fetchedAt: cacheDeps.now().toISOString() }
    // 写之前再读一次：检查更新会同时读几个仓库，各自只改自己那一项
    const latest = await load()
    await save({ repo: opts.remember ? cache.repo : latest.repo, entries: { ...latest.entries, [key]: entry } })
    return { repo, ...entry }
  } catch (e) {
    if (hit) return { repo, ...hit, error: (e as Error).message }
    throw e
  }
}
