/**
 * GitHub 多来源兜底（来源注册表见 shared/github-sources/registry.ts）。
 *
 * `netFetch` 先按原地址取（它自己会在代理、本机代理、直连之间回退）；原地址连不上、5xx、限流时，
 * 按设置里的顺序换来源再取，取到就返回，全都不行时把每个来源的原因列在一条错误里。
 * 换来源取到的结果会记 10 分钟：分片下载的每一片、紧接着的下一次请求直接先走它，不用每次都等原地址超时。
 */
import { t } from '../../shared/i18n.ts'
import {
  candidatesFor,
  parseGithubUrl,
  resolveSources,
  sourceLabel,
  type GithubSourceSetting,
  type GithubUrl,
  type ResolvedSource,
  type SourceCandidate,
} from '../../shared/github-sources/registry.ts'
import { extractBlobText } from '../../shared/github-sources/web-blob.ts'

/** 和 netFetch 同样的参数（这里不 import net.ts，避免循环引用） */
export type BaseFetch = (
  url: string,
  init: RequestInit & { timeoutMs?: number; onAttempt?: () => void },
) => Promise<Response>

export interface SourcesDeps {
  /** 单个地址的请求（带代理回退的 netFetchWith） */
  fetch: BaseFetch
  /** 设置里的来源列表 */
  sources: () => Promise<GithubSourceSetting[]>
  /** 网络错误的简短原因（net.ts 的 netReason） */
  reason: (e: unknown) => string
  now?: () => number
}

const PREFER_TTL = 10 * 60_000
/** 换来源取成功后记住的来源：按地址种类记 */
const preferred = new Map<string, { key: string; at: number }>() // 模块状态：缓存，丢了重新试原地址

/** 测试用：清掉记住的来源 */
export function resetPreferred() {
  preferred.clear()
}

/** 这个响应要不要换下一个来源：5xx、429；API 的 403 多半是限流 */
function retryStatus(res: Response, candidate: SourceCandidate) {
  if (res.status >= 500 || res.status === 429) return true
  return res.status === 403 && candidate.url.startsWith('https://api.github.com/')
}

/** 网页来源：把网页换成文件内容；没有内容（太大、二进制、网页改版）返回 null */
async function applyTransform(res: Response, candidate: SourceCandidate): Promise<Response | null> {
  if (candidate.transform !== 'web-blob' || !res.ok) return res
  const text = extractBlobText(await res.text())
  if (text === null) return null
  const body = new TextEncoder().encode(text)
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.byteLength) },
  })
}

function withHeaders(init: RequestInit, extra?: Record<string, string>): RequestInit {
  if (!extra) return init
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  return { ...init, headers }
}

/** 记住的来源排到最前（还在列表里且没过期的话） */
function order<T extends { source: ResolvedSource }>(list: T[], kind: string, now: number) {
  const hit = preferred.get(kind)
  if (!hit || now - hit.at > PREFER_TTL) return list
  const i = list.findIndex((x) => x.source.key === hit.key)
  return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list
}

/** 只能换镜像前缀的地址（Release 附件、源码包），列表里又没有镜像时，失败信息里提示去加一个 */
function mirrorHint(u: GithubUrl, list: ResolvedSource[]) {
  if (u.kind !== 'release' && u.kind !== 'archive') return ''
  if (list.some((s) => s.enabled && s.def.id === 'mirror')) return ''
  return (
    ' ' +
    t('Release 附件和源码包只能经代理或镜像前缀下载：可以在「设置 · 网络与代理 · GitHub 下载来源」里加一个镜像前缀。')
  )
}

export async function fetchViaSources(
  deps: SourcesDeps,
  url: string,
  init: RequestInit & { timeoutMs?: number; onAttempt?: () => void } = {},
) {
  const parsed = parseGithubUrl(url)
  if (!parsed) return deps.fetch(url, init)
  const list = resolveSources(await deps.sources().catch(() => []))
  const now = (deps.now ?? Date.now)()
  const tries = order(candidatesFor(parsed, list), parsed.kind, now)
  // 只有一个来源可试（API 地址、用户把别的都关了）：和以前完全一样，错误原样抛出
  if (tries.length <= 1)
    return deps.fetch(tries[0]?.candidate.url ?? url, withHeaders(init, tries[0]?.candidate.headers))

  const failures: string[] = []
  let fallback: Response | undefined
  for (const [i, { source, candidate }] of tries.entries()) {
    if (init.signal?.aborted) break
    try {
      const res = await deps.fetch(candidate.url, withHeaders(init, candidate.headers))
      if (retryStatus(res, candidate)) {
        failures.push(`${sourceLabel(source)}：HTTP ${res.status}`)
        // 都不行时把第一个 HTTP 响应交回去，调用方照旧按状态码报错
        if (fallback) await res.body?.cancel().catch(() => {})
        else fallback = res
        continue
      }
      const out = await applyTransform(res, candidate)
      if (!out) {
        failures.push(`${sourceLabel(source)}：${t('网页上没有文件内容（文件太大或不是文本）')}`)
        continue
      }
      if (i > 0 || preferred.has(parsed.kind)) preferred.set(parsed.kind, { key: source.key, at: now })
      await fallback?.body?.cancel().catch(() => {})
      return out
    } catch (e) {
      // 调用方取消：不再换来源，原样抛出
      if (init.signal?.aborted) throw e
      if (preferred.get(parsed.kind)?.key === source.key) preferred.delete(parsed.kind)
      // 原地址的错误带着试过哪些代理路径，保留全文；其余来源只写原因
      failures.push(`${sourceLabel(source)}：${source.def.id === 'origin' ? (e as Error).message : deps.reason(e)}`)
    }
  }
  if (fallback) return fallback
  throw new Error(
    t('GitHub 的各个下载来源都没成功（{url}）。{list}', { url, list: failures.join('；') }) + mirrorHint(parsed, list),
  )
}

export interface SourceTestResult {
  key: string
  ok: boolean
  ms?: number
  error?: string
  /** 这个来源不适用样例地址 */
  skipped?: boolean
}

/**
 * 设置页「检测」：每个来源（含关着的）各取一次样例文件，看通不通、多快。
 * 直接按来源的地址取，不经过兜底，结果才是这个来源自己的。
 */
export async function testSources(
  deps: Pick<SourcesDeps, 'fetch' | 'reason'>,
  list: GithubSourceSetting[],
  sample: string,
) {
  const parsed = parseGithubUrl(sample)
  const sources = resolveSources(list)
  return Promise.all(
    sources.map(async (source): Promise<SourceTestResult> => {
      const candidate = parsed ? source.def.rewrite(parsed, source.prefix) : null
      if (!candidate) return { key: source.key, ok: false, skipped: true }
      const started = Date.now()
      try {
        const res = await deps.fetch(candidate.url, { ...withHeaders({}, candidate.headers), timeoutMs: 15_000 })
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          return { key: source.key, ok: false, error: `HTTP ${res.status}` }
        }
        const out = await applyTransform(res, candidate)
        const text = out ? await out.text() : ''
        // 样例是 JSON：解析得了才算真拿到了文件（镜像站出错时常返回一张 200 的网页）
        JSON.parse(text)
        return { key: source.key, ok: true, ms: Date.now() - started }
      } catch (e) {
        const msg =
          e instanceof SyntaxError
            ? t('返回的不是文件内容')
            : source.def.id === 'origin'
              ? (e as Error).message
              : deps.reason(e)
        return { key: source.key, ok: false, error: msg }
      }
    }),
  )
}
