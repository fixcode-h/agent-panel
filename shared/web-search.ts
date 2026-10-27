/**
 * 联网搜索：给 CLI 的 web_search / web_fetch 两个工具提供搜索源和抓取逻辑。
 *
 * 参数和限制对齐 Command Code 的 Web 工具（query / numResults / allowed_domains / blocked_domains，
 * 以及 url / format / startIndex / timeout），这样模型在两个 CLI 之间不用换写法。
 *
 * 搜索源写成注册表（SEARCH_PROVIDERS）：新增一个源只加一条，逻辑处遍历它，调用方不按源名分支。
 * 密钥只在面板这一侧用，扩展和模型都看不到；哪个源要密钥写在定义里，缺了直接报错，不发请求。
 */
import { t } from './i18n.ts'

/** 默认返回几条结果；和 Command Code 一致 */
export const SEARCH_DEFAULT_RESULTS = 5
/** 一次最多返回几条：太多了模型的上下文全被搜索结果占掉 */
export const SEARCH_MAX_RESULTS = 10
/** 搜索词至少几个字：一个字的查询基本搜不到有用的东西，还容易被搜索源限流 */
export const SEARCH_MIN_QUERY_CHARS = 2
/** 搜索词最多几个字：degoog 这类服务对超长查询会直接报错 */
export const SEARCH_MAX_QUERY_CHARS = 400
/** 域名过滤最多几个：再多就等于没过滤 */
export const SEARCH_MAX_DOMAINS = 10
/** 一条结果摘要最多留多长，长摘要留给 web_fetch 去取 */
export const SEARCH_SNIPPET_CHARS = 500
/** 搜索请求最多等多久：degoog 这类聚合服务要把查询转给几个引擎，给得比普通接口宽一些 */
export const SEARCH_TIMEOUT_MS = 20_000

/** DeepSeek 官方搜索的端点路径：官方文档给的固定路径；设置里的地址可以带自己的前缀路径（例如自建代理），这里只往后追加 */
const DEEPSEEK_SEARCH_PATH = '/v1/tools/search'
/** DeepSeek 一次只接受 1–50 条，超出范围上游直接报错 */
const DEEPSEEK_SEARCH_MIN_COUNT = 1
const DEEPSEEK_SEARCH_MAX_COUNT = 50

/** 抓取正文的默认超时（秒）；Command Code 是 60 秒 */
export const FETCH_DEFAULT_TIMEOUT_SECONDS = 60
/** 抓取正文最多等多久（秒） */
export const FETCH_MAX_TIMEOUT_SECONDS = 120
/** 正文一次返回多少字符，超出的用 startIndex 续读（和 Command Code 的窗口一致） */
export const FETCH_WINDOW_CHARS = 100_000
/** 手动跟随几次重定向；每一跳都重新过一遍地址守卫，防止跳到内网 */
export const FETCH_MAX_REDIRECTS = 5
/** 页面最多读多少字节：HTML 里塞了几十 MB 的脚本时不能整个读进内存 */
export const FETCH_MAX_BYTES = 5 * 1024 * 1024

export type FetchFormat = 'markdown' | 'text' | 'html'

/** 一个搜索源 */
export interface SearchProvider {
  id: string
  label: string
  /** 请求里要不要 API 密钥：要的话设置里没填就报错，不发请求 */
  needsKey: boolean
  /** 默认地址；为空表示必须由用户填（例如自建的 searxng） */
  endpoint: string
  /** 发出去的请求：各服务的参数和鉴权方式不同 */
  build: (q: SearchRequest & { count: number }) => { url: string; init: RequestInit }
  /** 从响应 JSON 里取结果，字段名不同的在这里对齐成 title / url / snippet */
  parse: (body: unknown) => SearchHit[]
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface NormalizedSearch {
  query: string
  numResults: number
  allowedDomains: string[]
  blockedDomains: string[]
}

export interface NormalizedFetch {
  url: string
  format: FetchFormat
  startIndex: number
  timeoutMs: number
}

/** 结果里的正文窗口：total 是整篇的长度，endIndex 是下一次续读的 startIndex */
export interface PageWindow {
  text: string
  startIndex: number
  endIndex: number
  total: number
  truncated: boolean
}

/** 从响应里按一组字段名取结果；字段缺失、类型不对的都跳过，不因为一条脏数据整次失败 */
function pick(body: unknown, at: (b: any) => unknown, fields: { title: string; url: string; snippet: string }) {
  const list = at(body)
  if (!Array.isArray(list)) return []
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return list
    .map((raw: any) => ({
      title: str(raw?.[fields.title]),
      url: str(raw?.[fields.url]),
      snippet: str(raw?.[fields.snippet]).slice(0, SEARCH_SNIPPET_CHARS),
    }))
    .filter((h) => h.url && /^https?:\/\//i.test(h.url))
}

/** degoog：免费的 metasearch 聚合（把查询转给 Brave 等），不需要密钥，默认源；
 * 返回固定 100 条，条数由面板自己截断；用户也可以换成自建实例 */
const Degoog: SearchProvider = {
  id: 'degoog',
  label: t('Degoog（免密钥）'),
  needsKey: false,
  endpoint: 'https://degoog.org/api/search',
  build: ({ query, endpoint }) => ({
    url: `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`,
    init: { method: 'GET', headers: { accept: 'application/json' } },
  }),
  parse: (body) => pick(body, (b) => b?.results, { title: 'title', url: 'url', snippet: 'snippet' }),
}

/** searxng：自己搭的实例，地址必须填（公共实例基本都关了 JSON 接口） */
const Searxng: SearchProvider = {
  id: 'searxng',
  label: t('SearXNG（自建实例）'),
  needsKey: false,
  endpoint: '',
  build: ({ query, count, endpoint }) => ({
    url: `${endpoint.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=all&safesearch=0&count=${count}`,
    init: { method: 'GET', headers: { accept: 'application/json' } },
  }),
  parse: (body) => pick(body, (b) => b?.results, { title: 'title', url: 'url', snippet: 'content' }),
}

/** Brave Search API：免费额度，按量计费，所以不设成默认 */
const Brave: SearchProvider = {
  id: 'brave',
  label: t('Brave Search API（需要密钥）'),
  needsKey: true,
  endpoint: 'https://api.search.brave.com/res/v1/web/search',
  build: ({ query, count, key, endpoint }) => ({
    url: `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}&count=${count}`,
    init: { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': key } },
  }),
  parse: (body) => pick(body, (b) => b?.web?.results, { title: 'title', url: 'url', snippet: 'description' }),
}

/** Tavily：按量计费，要密钥 */
const Tavily: SearchProvider = {
  id: 'tavily',
  label: t('Tavily（需要密钥）'),
  needsKey: true,
  endpoint: 'https://api.tavily.com/search',
  build: ({ query, count, key, endpoint }) => ({
    url: endpoint,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }),
    },
  }),
  parse: (body) => pick(body, (b) => b?.results, { title: 'title', url: 'url', snippet: 'content' }),
}

/**
 * DeepSeek 官方搜索：面板显式调它的搜索端点（不是模型侧联网，/chat/completions 也没有联网参数），
 * 用的是 DeepSeek 自己的 API 密钥，不是 litellm 中转的密钥；按量计费，所以不设成默认。
 */
const Deepseek: SearchProvider = {
  id: 'deepseek',
  label: t('DeepSeek 官方搜索（需要密钥）'),
  needsKey: true,
  // 地址可覆盖（可带自建代理的前缀路径），末尾统一追加官方端点；注意设置里那个地址是所有源共用的一个字段
  endpoint: 'https://api.deepseek.com',
  build: ({ query, count, key, endpoint }) => ({
    url: `${endpoint.replace(/\/+$/, '')}${DEEPSEEK_SEARCH_PATH}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        count: Math.min(DEEPSEEK_SEARCH_MAX_COUNT, Math.max(DEEPSEEK_SEARCH_MIN_COUNT, count)),
      }),
    },
  }),
  parse: (body) => pick(body, (b) => b?.results, { title: 'title', url: 'url', snippet: 'snippet' }),
}

/** 可选的搜索源：设置界面按这个列表显示，第一个是默认 */
export const SEARCH_PROVIDERS: SearchProvider[] = [Degoog, Searxng, Brave, Tavily, Deepseek]
export const DEFAULT_SEARCH_PROVIDER = Degoog.id

/** 可选的搜索源 id：设置文件里写成别的值时由 schema 回退到默认源 */
export const SEARCH_PROVIDER_IDS = SEARCH_PROVIDERS.map((p) => p.id) as [string, ...string[]]

export function searchProvider(id: string): SearchProvider {
  return SEARCH_PROVIDERS.find((p) => p.id === id) ?? Degoog
}

/**
 * 设置里的联网搜索。地址是所有源共用的一个字段，所以要另外记住它属于哪个源。
 * 和 schema 里的定义字段对齐（这里不 import schema：web-search 的地址守卫要给两边共用）。
 */
export interface SearchSettingsValue {
  provider: string
  key: string
  endpoint: string
  /** endpoint 属于哪个源；旧设置里是空串（升级前没有这个字段） */
  endpointProvider: string
}

/**
 * 换搜索源：留着上一源的地址，它就会被当成新源的基址，请求打到旧主机
 * （用户只看到上游 404 / 不是 JSON，看不出是地址残留）。所以切源时清空地址，
 * 让新源的默认地址生效；没有默认地址的源（searxng）则要求用户重新填。
 * 选中的源没变时原样返回：同一个源内手填的地址要留住。
 */
export function switchSearchProvider<T extends SearchSettingsValue>(value: T, nextId: string): T {
  const next = searchProvider(nextId)
  if (next.id === value.provider) return value
  return { ...value, provider: next.id, endpoint: '', endpointProvider: next.id }
}

/**
 * 实际请求用的地址：自定义地址只在它属于当前源时生效。
 * 归属对不上说明是上一源留下的（包括旧版本切源时没清掉的数据），用当前源的默认地址。
 * 没有归属的旧设置照旧采信：那可能是用户手填的代理地址，不能凭空丢掉。
 */
export function resolveSearchEndpoint(value: SearchSettingsValue): string {
  const provider = searchProvider(value.provider)
  const custom = value.endpoint.trim()
  if (custom && (!value.endpointProvider || value.endpointProvider === provider.id)) return custom
  return provider.endpoint
}

/** 查询参数带上密钥和地址：密钥只在面板里，不传给模型 */
export type SearchRequest = NormalizedSearch & { key: string; endpoint: string }

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function intIn(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * 域名过滤：写成一张表，工具参数名沿用 Command Code 的 allowed_domains / blocked_domains。
 * 只有一种情况会报错：两个同时给（含义自相矛盾，让模型自己选一个）。
 */
export function normalizeDomains(input: unknown, field: string): string[] {
  if (input === undefined || input === null || input === '') return []
  const list = Array.isArray(input) ? input : String(input).split(',')
  const out: string[] = []
  for (const raw of list) {
    const d = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\*?\./, '')
    if (!d) continue
    // 只认主机名：写成 URL 或带端口时明确报错，不然过滤会静默失效
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))
      throw new Error(
        t('{field} 里只能写域名，例如 example.com，不要带协议、端口或路径：{value}', { field, value: String(raw) }),
      )
    if (!out.includes(d)) out.push(d)
    if (out.length >= SEARCH_MAX_DOMAINS) break
  }
  return out
}

/** 一批结果里，这个域名是不是允许的：allowed 只留列表里的，blocked 去掉列表里的（含子域名） */
export function domainAllowed(host: string, allowed: string[], blocked: string[]): boolean {
  const h = host.toLowerCase()
  const hit = (list: string[]) => list.some((d) => h === d || h.endsWith(`.${d}`))
  if (blocked.length) return !hit(blocked)
  if (allowed.length) return hit(allowed)
  return true
}

/** 搜索工具的参数：一次校验完，错误直接给模型看 */
export function normalizeSearch(input: unknown): NormalizedSearch {
  const o = asRecord(input)
  const query = String(o.query ?? '').trim()
  if (query.length < SEARCH_MIN_QUERY_CHARS)
    throw new Error(t('query 至少要有 {n} 个字', { n: SEARCH_MIN_QUERY_CHARS }))
  if (query.length > SEARCH_MAX_QUERY_CHARS)
    throw new Error(t('query 太长了，最多 {n} 个字', { n: SEARCH_MAX_QUERY_CHARS }))
  const allowedDomains = normalizeDomains(o.allowed_domains, 'allowed_domains')
  const blockedDomains = normalizeDomains(o.blocked_domains, 'blocked_domains')
  if (allowedDomains.length && blockedDomains.length)
    throw new Error(t('allowed_domains 和 blocked_domains 不能同时给，选一个'))
  return {
    query,
    numResults: intIn(o.numResults, 1, SEARCH_MAX_RESULTS, SEARCH_DEFAULT_RESULTS),
    allowedDomains,
    blockedDomains,
  }
}

const FETCH_FORMATS: FetchFormat[] = ['markdown', 'text', 'html']

/** 抓取工具的参数：url 先做同步能查的部分，DNS 解析后的校验在服务端（shared 里没有 node:dns） */
export function normalizeFetch(input: unknown): NormalizedFetch {
  const o = asRecord(input)
  const raw = String(o.url ?? '').trim()
  if (!raw) throw new Error(t('url 是必填的'))
  // Command Code 同样把 http 升级成 https：明文请求会被中间人改内容，搜索抓到的正文不该是别人塞的
  const url = raw.replace(/^http:\/\//i, 'https://')
  guardUrl(url)
  const format = String(o.format ?? 'markdown') as FetchFormat
  // timeout 写 0 或负数表示「用默认值」：模型常把「不指定」写成 0，夹成 1 秒几乎必然超时
  const seconds = intIn(o.timeout, 0, FETCH_MAX_TIMEOUT_SECONDS, FETCH_DEFAULT_TIMEOUT_SECONDS)
  return {
    url,
    format: FETCH_FORMATS.includes(format) ? format : 'markdown',
    startIndex: intIn(o.startIndex, 0, Number.MAX_SAFE_INTEGER, 0),
    timeoutMs: (seconds || FETCH_DEFAULT_TIMEOUT_SECONDS) * 1000,
  }
}

// ── 地址守卫 ──────────────────────────────────────────────

/**
 * IPv6 展开成 8 个 16 位分组（含末尾点分 IPv4 的写法，例如 `::ffff:127.0.0.1`）；不是 IPv6 时返回 null。
 * 必须按数值判：WHATWG URL 会把 `[::ffff:127.0.0.1]` 归一成 `[::ffff:7f00:1]`，
 * 拿字符串去匹配点分写法拦不住映射地址。
 */
function ipv6Groups(input: string): number[] | null {
  let s = input
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (tail) {
    const v4 = tail[1]!.split('.').map((x) => Number.parseInt(x, 10))
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    s = `${s.slice(0, tail.index)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part ? part.split(':').map((x) => Number.parseInt(x, 16)) : [])
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  // 组数超了先返回 null：new Array(负数) 会抛 RangeError，不能把非法输入变成异常
  if (head.length + rest.length > 8) return null
  const groups = halves.length === 2 ? [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest] : head
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null
}

/** 128 位整数值：按前缀比较网段比逐段判清楚 */
const ipv6Value = (groups: number[]) => groups.reduce((n, x) => (n << 16n) | BigInt(x), 0n)

/** IPv6 的私有 / 保留网段：前缀 + 位数（2002::/16 是已废弃的 6to4，地址里嵌着 IPv4，一并拒掉） */
const V6_PRIVATE: { prefix: bigint; bits: number }[] = [
  { prefix: 0xfc00n << 112n, bits: 7 },
  { prefix: 0xfe80n << 112n, bits: 10 },
  { prefix: 0xff00n << 112n, bits: 8 },
  { prefix: (0x2001n << 112n) | (0x0db8n << 96n), bits: 32 },
  { prefix: 0x2002n << 112n, bits: 16 },
]

/**
 * 内嵌 IPv4 的 IPv6 形式：top 96 位是这些值时，低 32 位就是那个 IPv4。
 * ::ffff:0:0/96（IPv4 映射）、::/96（IPv4 兼容，已废弃）、64:ff9b::/96（NAT64）
 */
const V6_EMBEDDED = [0xffffn, 0n, 0x64ff9bn]

const ipv4Text = (n: bigint) => [24n, 16n, 8n, 0n].map((shift) => String((n >> shift) & 0xffn)).join('.')

/** 一个 IP 字面量是不是内网 / 回环 / 链路本地 / 保留地址 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (addr.includes(':')) {
    const groups = ipv6Groups(addr)
    if (!groups) return false
    const value = ipv6Value(groups)
    // 映射 / 兼容 / NAT64 的写法：低 32 位按 IPv4 再判一次，别让 [::ffff:127.0.0.1] 混过去
    if (V6_EMBEDDED.includes(value >> 32n)) return isPrivateAddress(ipv4Text(value & 0xffffffffn))
    return V6_PRIVATE.some(({ prefix, bits }) => value >> BigInt(128 - bits) === prefix >> BigInt(128 - bits))
  }
  const parts = addr.split('.').map((x) => Number.parseInt(x, 10))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true
  return false
}

/**
 * 地址守卫：抓网页前先挡掉不该由面板去访问的目标。
 * 只查 URL 本身能看出来的部分（协议、凭据、主机名形态、IP 字面量）；
 * 域名解析出来的地址由服务端再查一次（server/web-search.ts），因为解析结果是运行时才知道的。
 */
export function guardUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(t('这不是一个有效的网址：{url}', { url: raw }))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(t('只支持 http 和 https 网址：{url}', { url: raw }))
  // 地址里带用户名密码：一是会被拼进请求头，二是常被拿来绕过域名判断
  if (url.username || url.password) throw new Error(t('网址里不能带用户名和密码：{url}', { url: raw }))
  // 末尾带点的主机名（intranet.）解析结果和 intranet 一样，先去掉点再判单标签
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!host) throw new Error(t('网址里没有主机名：{url}', { url: raw }))
  // localhost 和单标签主机名（intranet、nas）只在本机内网有意义
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error(t('不抓取本机地址：{url}', { url: raw }))
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
  if (!isIp && !host.includes('.')) throw new Error(t('不抓取内网主机名：{url}', { url: raw }))
  if (isIp && isPrivateAddress(host)) throw new Error(t('不抓取内网或本机地址：{url}', { url: raw }))
  return url
}

// ── HTML → 正文 ──────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
}

function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 行内标签：粗体、斜体、行内代码在 markdown 里保留，其余去掉 */
function inline(s: string, md: boolean): string {
  let t = s
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) =>
      md ? `**${inline(inner, md)}**` : inline(inner, md),
    )
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) =>
      md ? `*${inline(inner, md)}*` : inline(inner, md),
    )
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => (md ? `\`${plain(inner)}\`` : plain(inner)))
  return decodeEntities(plain(t))
}

function plain(s: string) {
  return s.replace(/<[^>]*>/g, ' ')
}

/** 把空白压成一段：行内连续空格和换行只留一个空格 */
function squeeze(s: string) {
  return s.replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n')
}

/**
 * 网页正文：markdown 保留结构和链接，text 只要纯文字，html 原样返回。
 * 不追求完整的 HTML 解析（没有引入解析库）：去掉脚本样式和标签、块级标签转换行，够模型读正文。
 */
export function htmlToText(html: string, format: FetchFormat): string {
  if (format === 'html') return html
  const md = format === 'markdown'
  const out = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, n: string, inner: string) => `\n\n${md ? `${'#'.repeat(Number(n))} ` : ''}${inline(inner, md)}\n\n`,
    )
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const text = inline(inner, md)
      return md && text && !href.startsWith('javascript:') ? `[${text}](${href})` : text
    })
    .replace(/<li\b[^>]*>/gi, md ? '\n- ' : '\n· ')
    .replace(
      /<\/(p|div|section|article|header|footer|blockquote|pre|table|tr|ul|ol|dl|dt|dd|figure|figcaption|form|main|nav|aside|li)>/gi,
      '\n\n',
    )
    .replace(/<[^>]+>/g, ' ')
  const text = squeeze(decodeEntities(out))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return text
}

/** 网页标题：给结果加一行「这是什么页面」，取不到就空着 */
export function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m
    ? squeeze(decodeEntities(plain(m[1]!)))
        .trim()
        .slice(0, 200)
    : ''
}

/** 正文窗口：从 startIndex 起截 FETCH_WINDOW_CHARS 个字，告诉模型下一篇从哪继续 */
export function pageWindow(text: string, startIndex: number): PageWindow {
  const total = text.length
  const start = Math.min(Math.max(0, startIndex), total)
  const end = Math.min(total, start + FETCH_WINDOW_CHARS)
  return { text: text.slice(start, end), startIndex: start, endIndex: end, total, truncated: end < total }
}

// ── 给模型看的文本 ────────────────────────────────────────

/** 搜索结果文本：模型直接读这个，不再拼 JSON */
export function formatSearchResults(query: string, provider: string, hits: SearchHit[]): string {
  if (!hits.length)
    return `搜索「${query}」（来源 ${provider}）没有找到结果。可以换关键词，或者用 web_fetch 直接打开已知的网址。`
  const lines = hits.map(
    (h, i) => `${i + 1}. ${h.title || '(无标题)'}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`,
  )
  return `搜索「${query}」找到 ${hits.length} 条结果（来源 ${provider}）：\n\n${lines.join('\n\n')}`
}

/** 抓取结果文本：带上地址、格式和续读位置，模型知道正文是不是完整的 */
export function formatPage(p: {
  url: string
  finalUrl: string
  status: number
  format: FetchFormat
  title: string
  window: PageWindow
  redirects: string[]
}): string {
  const head = [`地址：${p.finalUrl}`]
  if (p.finalUrl !== p.url) head.push(`（原始地址 ${p.url} 跳转而来）`)
  if (p.title) head.push(`标题：${p.title}`)
  head.push(`状态：${p.status}，格式：${p.format}，共 ${p.window.total} 字`)
  if (p.redirects.length) head.push(`跳转：${p.redirects.join(' → ')}`)
  // 续读到末尾时不能只说「正文为空」：模型会以为页面没内容，看不出已经读完了
  const ended = p.window.total > 0 && p.window.startIndex >= p.window.total
  const body = p.window.text || (ended ? `(已经读到正文末尾，共 ${p.window.total} 字)` : '(正文为空)')
  const tail = p.window.truncated
    ? `\n\n[正文只返回了第 ${p.window.startIndex}–${p.window.endIndex} 字，还有 ${p.window.total - p.window.endIndex} 字：用 startIndex=${p.window.endIndex} 续读]`
    : ''
  return `${head.join('\n')}\n\n${body}${tail}`
}
