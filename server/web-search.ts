/**
 * 联网搜索的代理端点：CLI 里的 web_search / web_fetch 打到面板，由面板带着设置里的密钥去搜、去抓。
 *
 * 为什么不让扩展自己连搜索服务：密钥会跟着扩展脚本下发到临时目录，模型也能读到；
 * 换搜索源、改地址还得重新注入。放在面板这一侧，密钥只在本机数据目录里，扩展只认面板给出的随机地址。
 *
 * 地址里带的是这一轮 CLI 的随机地址（和提问桥接同一个 token，见 server/ask-mcp.ts）：
 * 访问令牌打开时也能用，别的程序猜不到。
 */
import { Hono, type Context } from 'hono'
import { lookup as dnsLookup } from 'node:dns/promises'
import { netFetch, type NetInit } from './net.ts'
import { hasAskSession } from './ask-mcp.ts'
import { getSettings } from './settings.ts'
import { log } from './log.ts'
import { t } from '../shared/i18n.ts'
import {
  FETCH_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  SEARCH_TIMEOUT_MS,
  domainAllowed,
  formatPage,
  formatSearchResults,
  guardUrl,
  htmlTitle,
  htmlToText,
  isPrivateAddress,
  normalizeFetch,
  normalizeSearch,
  pageWindow,
  searchProvider,
  type FetchFormat,
  type PageWindow,
} from '../shared/web-search.ts'

/** 抓到的页面：缓存整篇正文（截断按 startIndex 在返回时做） */
interface FetchedPage {
  url: string
  finalUrl: string
  status: number
  contentType: string
  format: FetchFormat
  title: string
  body: string
  redirects: string[]
}

/** 同一页在 15 分钟内重复抓时直接用上次的正文（对齐 Command Code）；重启就没了，不落盘 */
const CACHE_TTL_MS = 15 * 60_000
/** 缓存最多存多少字符：整篇正文可能几 MB，只留最近用到的那些 */
const CACHE_BUDGET_CHARS = 8_000_000
const CACHE_MAX_ENTRIES = 20

const cache = new Map<string, { at: number; page: FetchedPage }>()

function cached(key: string) {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  // 重新插一遍：Map 的顺序就是最近用过的顺序
  cache.delete(key)
  cache.set(key, hit)
  return hit.page
}

function remember(key: string, page: FetchedPage) {
  cache.set(key, { at: Date.now(), page })
  let total = [...cache.values()].reduce((n, x) => n + x.page.body.length, 0)
  while (cache.size > CACHE_MAX_ENTRIES || (total > CACHE_BUDGET_CHARS && cache.size > 1)) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    total -= cache.get(oldest)?.page.body.length ?? 0
    cache.delete(oldest)
  }
}

/** 测试时替换网络和解析，不真的连外网 */
export interface WebSearchDeps {
  fetch: (url: string, init: NetInit) => Promise<Response>
  lookup: (host: string) => Promise<{ address: string }[]>
}

const defaultDeps: WebSearchDeps = {
  fetch: netFetch,
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
}

/** 带状态码的失败：参数不对是 400，搜索源/目标站的问题按 502 交给模型 */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const addr = (u: URL) => u.hostname.replace(/^\[|\]$/g, '')

/**
 * 地址守卫的第二道：IP 字面量在这里再判一次（纵深防御，不靠 guardUrl 那一处），域名查一遍解析结果。
 * 这里只做一次前置校验，不防 DNS rebinding：校验用的解析结果和真正建连时的解析不是同一个，
 * 短 TTL 的域名可以在两次之间换地址；真闭环得把解析结果固定进请求（走代理时也做不到），代价大于收益，是已知限制。
 * 导出给单测：IP 字面量这一道不经过 guardUrl 也能直接验。
 */
export async function assertPublicHost(url: URL, deps: WebSearchDeps) {
  const host = addr(url)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    // guardUrl 已经拦过一遍，这里再判一次：少一处依赖，漏改一个地方也不至于直接打通内网
    if (isPrivateAddress(host)) throw new HttpError(t('不抓取内网或本机地址：{url}', { url: host }), 403)
    return
  }
  let found: { address: string }[] = []
  try {
    found = await deps.lookup(host)
  } catch (e) {
    throw new HttpError(t('域名 {host} 解析失败：{error}', { host, error: (e as Error).message }), 502)
  }
  const bad = found.find((a) => isPrivateAddress(a.address))
  if (bad) throw new HttpError(t('域名 {host} 指向内网地址 {ip}，不抓取', { host, ip: bad.address }), 403)
}

/** 只读到上限为止：页面里塞了几十 MB 脚本时不能整个读进内存 */
async function readLimited(res: Response, limit: number) {
  const reader = res.body?.getReader()
  if (!reader) return { buf: Buffer.alloc(0), cut: false }
  const chunks: Buffer[] = []
  let size = 0
  let cut = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const room = limit - size
    if (value.byteLength > room) {
      chunks.push(Buffer.from(value.subarray(0, room)))
      size = limit
      cut = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(Buffer.from(value))
    size += value.byteLength
  }
  return { buf: Buffer.concat(chunks), cut }
}

/** 按 content-type 里的 charset 解码，认不出时按 UTF-8 */
function decodeBody(buf: Buffer, contentType: string) {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      return new TextDecoder(charset).decode(buf)
    } catch {
      // 不认识的 charset（或者 Node 没带这份编码表）：按 UTF-8 读，至少不整个失败
    }
  }
  return buf.toString('utf8')
}

/** 升级成 https：跟随重定向时 http 的位置也可能出现 */
const secure = (u: URL) => {
  if (u.protocol === 'http:') u.protocol = 'https:'
  guardUrl(u.toString())
  return u
}

async function fetchPage(url: string, format: FetchFormat, deps: WebSearchDeps, signal: AbortSignal) {
  let target = secure(new URL(url))
  const redirects: string[] = []
  for (let hop = 0; ; hop++) {
    await assertPublicHost(target, deps)
    const res = await deps
      .fetch(target.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          // 有些站点对没有 UA 的请求直接回 403；说清是谁在取，别伪装成浏览器
          'user-agent': 'AgentPanel/1.0 (+web_fetch tool)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
        },
      })
      .catch((e: Error) => {
        throw new HttpError(t('抓取 {url} 失败：{error}', { url: target.toString(), error: e.message }), 502)
      })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= FETCH_MAX_REDIRECTS)
        throw new HttpError(t('跳转超过 {n} 次，停止抓取：{url}', { n: FETCH_MAX_REDIRECTS, url: url }), 502)
      const next = secure(new URL(location, target))
      redirects.push(`${target.toString()} → ${next.toString()}`)
      target = next
      continue
    }
    const contentType = res.headers.get('content-type') ?? ''
    const { buf, cut } = await readLimited(res, FETCH_MAX_BYTES)
    const raw = decodeBody(buf, contentType)
    const isHtml = /html|xml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(raw.slice(0, 200))
    const body = (isHtml ? htmlToText(raw, format) : raw) + (cut ? '\n\n[页面太大，只读了前 5 MB]' : '')
    return {
      page: {
        url,
        finalUrl: target.toString(),
        status: res.status,
        contentType,
        format,
        title: isHtml ? htmlTitle(raw) : '',
        body,
        redirects,
      } satisfies FetchedPage,
      cut,
    }
  }
}

function bodyOf(c: Context) {
  return c.req.json().catch(() => null)
}

/** 搜索：参数、密钥、地址、上游错误都原样交给模型和用户，不吞成一句「搜索失败」 */
async function doSearch(input: unknown, deps: WebSearchDeps) {
  const q = normalizeSearch(input)
  const cfg = (await getSettings()).webSearch
  const provider = searchProvider(cfg.provider)
  const endpoint = cfg.endpoint.trim() || provider.endpoint
  if (!endpoint)
    throw new HttpError(
      t('搜索源 {provider} 需要填写地址，请在「设置 · 联网搜索」里补上', { provider: provider.label }),
      400,
    )
  if (provider.needsKey && !cfg.key.trim())
    throw new HttpError(
      t('搜索源 {provider} 需要密钥，请在「设置 · 联网搜索」里填写', { provider: provider.label }),
      400,
    )
  // 多取一些：域名过滤之后还要够 numResults 条（Brave 最多 20 条）
  const count = Math.min(20, Math.max(q.numResults, q.numResults * 2))
  const req = provider.build({ ...q, count, key: cfg.key.trim(), endpoint })
  const started = Date.now()
  const res = await deps
    .fetch(req.url, { ...req.init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) })
    .catch((e: Error) => {
      throw new HttpError(t('{provider} 请求失败：{error}', { provider: provider.label, error: e.message }), 502)
    })
  const text = await res.text()
  if (!res.ok)
    throw new HttpError(
      t('{provider} 返回 {status}：{body}', {
        provider: provider.label,
        status: res.status,
        body: text.slice(0, 1000),
      }),
      502,
    )
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(
      t('{provider} 返回的不是 JSON：{body}', { provider: provider.label, body: text.slice(0, 1000) }),
      502,
    )
  }
  const hits = provider
    .parse(parsed)
    .filter((h) => {
      try {
        return domainAllowed(new URL(h.url).hostname, q.allowedDomains, q.blockedDomains)
      } catch {
        return false
      }
    })
    .slice(0, q.numResults)
  log.info('web-search', '搜索完成', {
    provider: provider.id,
    query: q.query,
    results: hits.length,
    ms: Date.now() - started,
  })
  return {
    provider: provider.id,
    providerLabel: provider.label,
    results: hits,
    text: formatSearchResults(q.query, provider.label, hits),
  }
}

/** 抓取：同一地址 15 分钟内直接给上次的正文；窗口切片每次现算，续读不受缓存影响 */
async function doFetch(input: unknown, deps: WebSearchDeps) {
  const f = normalizeFetch(input)
  const key = `${f.format} ${f.url}`
  let page = cached(key)
  if (!page) {
    const fetched = await fetchPage(f.url, f.format, deps, AbortSignal.timeout(f.timeoutMs))
    page = fetched.page
    // 太大或失败的页面不缓存
    if (!fetched.cut && page.status >= 200 && page.status < 300) remember(key, page)
  }
  const window: PageWindow = pageWindow(page.body, f.startIndex)
  return {
    url: page.url,
    finalUrl: page.finalUrl,
    status: page.status,
    contentType: page.contentType,
    title: page.title,
    redirects: page.redirects,
    ...window,
    text: formatPage({ ...page, format: f.format, window }),
  }
}

export function webSearchApi(overrides: Partial<WebSearchDeps> = {}) {
  const deps: WebSearchDeps = { ...defaultDeps, ...overrides }
  return new Hono()
    .post('/:token/search', async (c) => {
      if (!hasAskSession(c.req.param('token'))) return c.json({ error: t('这一轮已经结束了') }, 404)
      try {
        return c.json(await doSearch(await bodyOf(c), deps))
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400
        log.warn('web-search', '搜索失败', { error: (e as Error).message })
        return c.json({ error: (e as Error).message }, status as 400)
      }
    })
    .post('/:token/fetch', async (c) => {
      if (!hasAskSession(c.req.param('token'))) return c.json({ error: t('这一轮已经结束了') }, 404)
      try {
        return c.json(await doFetch(await bodyOf(c), deps))
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400
        log.warn('web-search', '抓取失败', { error: (e as Error).message })
        return c.json({ error: (e as Error).message }, status as 400)
      }
    })
}
