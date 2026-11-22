/**
 * 面板更新包的下载：按来源逐个试，卡住就换下一个。
 *
 * 为什么不直接交给 netFetch 的多来源兜底：那一层只在「请求出错」时换来源，连上了却一直不给数据
 * （国内连 release-assets.githubusercontent.com 常见）时它不知道，下载会挂在 0 字节好几分钟。
 * 这里每个来源单独计时，一段时间没收到数据就放弃它、记下原因、换下一个，页面上能看到正在用哪个来源。
 *
 * 顺序：GitHub API（用户定 2026-11-21：API 优先级最高）→ 原地址 → 设置里打开的镜像前缀。
 * API 的附件地址会 302 到一个带签名的下载地址：先只取跳转地址（一次 API 请求），再对它分片下载，
 * 不让每个分片都去消耗 API 每小时 60 次的配额。
 */
import { t } from '../../shared/i18n.ts'
import { normalizePrefix, resolveSources, type GithubSourceSetting } from '../../shared/github-sources/registry.ts'
import { downloadFile, type NetFetch } from '../download.ts'
import type { AppRelease, AppUpdateJob } from '../../shared/version.ts'

export interface PackageSource {
  label: string
  url: string
  /** GitHub API 的附件地址：先取跳转地址再下载 */
  api?: boolean
  /** 这个来源要额外带的请求头（GitHub API 取仓库文件要 Accept: raw） */
  headers?: Record<string, string>
}

/** 一段时间没收到数据就换来源：要够 netFetch 试完代理、本机代理、直连几条路（每条 20 秒） */
export const STALL_MS = 60_000

const UA = { 'User-Agent': 'agent-panel' }

/** 令牌（环境变量或已授权的 gh）由 netFetch 对 api.github.com 统一带上，这里不用管 */
function apiHeaders(): Record<string, string> {
  return { ...UA, Accept: 'application/octet-stream' }
}

/** 列出这个文件可以从哪些地方取，按优先级排；同一个地址只出现一次 */
export function packageSources(o: { apiUrl?: string; url: string; sources: GithubSourceSetting[] }) {
  const out: PackageSource[] = []
  if (o.apiUrl) out.push({ label: 'GitHub API', url: o.apiUrl, api: true })
  if (o.url) out.push({ label: t('原地址'), url: o.url })
  if (o.url)
    for (const s of resolveSources(o.sources)) {
      if (!s.enabled || s.def.id !== 'mirror') continue
      const prefix = normalizePrefix(s.prefix)
      if (!prefix) continue
      let host = prefix
      try {
        host = new URL(prefix).host
      } catch {
        // 前缀已经校验过，解析不了时原样显示
      }
      out.push({ label: s.preset ? s.preset.label() : t('镜像 {host}', { host }), url: prefix + o.url })
    }
  return out.filter((s, i) => out.findIndex((x) => x.url === s.url) === i)
}

/** API 附件地址 → 真正的下载地址（302 的 Location）；只发一次请求，不跟随跳转 */
export async function resolveApiAsset(fetch: NetFetch, url: string, signal?: AbortSignal) {
  const res = await fetch(url, { headers: apiHeaders(), redirect: 'manual', timeoutMs: 15_000, signal })
  const location = res.headers.get('location')
  await res.body?.cancel().catch(() => {})
  if (res.status >= 300 && res.status < 400 && location) return new URL(location, url).toString()
  if (res.status === 403 || res.status === 429)
    throw new Error(t('GitHub API 限流（HTTP {status}）', { status: res.status }))
  throw new Error(t('GitHub API 没有给出下载地址（HTTP {status}）', { status: res.status }))
}

export interface FetchPackageHooks {
  /** 换到一个来源；received 要从 0 重新算（续传时 downloadFile 会先报已有的部分） */
  onSource: (label: string) => void
  /** 放弃一个来源 */
  onFail: (label: string, error: string) => void
  onBytes: (n: number) => void
  onTotal: (n: number) => void
  /** 每个来源用的请求：只带代理回退、不再换来源（来源由这里管） */
  fetch: NetFetch
  stallMs?: number
  /** 全都失败时的报错（list 是每个来源的原因）；不传是面板更新包的那句 */
  failText?: (list: string) => string
}

/**
 * 按顺序从各来源下载到 to；全都失败时抛出一条列出每个来源原因的错误。
 * 换来源时已经下好的分片接着用（resumeKey 相同），不从头来。
 */
export async function fetchPackage(sources: PackageSource[], to: string, resumeKey: string, h: FetchPackageHooks) {
  const stallMs = h.stallMs ?? STALL_MS
  const failures: string[] = []
  for (const s of sources) {
    h.onSource(s.label)
    const ac = new AbortController()
    let stalled = false
    let timer: NodeJS.Timeout | undefined
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        stalled = true
        ac.abort()
      }, stallMs)
      timer.unref?.()
    }
    arm()
    try {
      const url = s.api ? await resolveApiAsset(h.fetch, s.url, ac.signal) : s.url
      await downloadFile(url, to, {
        headers: { ...UA, ...s.headers },
        signal: ac.signal,
        fetch: h.fetch,
        resumeKey,
        onTotal: h.onTotal,
        onBytes: (n) => {
          // 只有真收到数据才算有进展；分片失败扣回的负数不算
          if (n > 0) arm()
          h.onBytes(n)
        },
      })
      return s.label
    } catch (e) {
      const error = stalled
        ? t('{n} 秒没有收到数据', { n: Math.round(stallMs / 1000) })
        : (e as Error).message || String(e)
      failures.push(`${s.label}：${error}`)
      h.onFail(s.label, error)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const list = failures.join('；')
  throw new Error(
    h.failText?.(list) ??
      t(
        '下载安装包失败，试过的来源都不行：{list}。可以在「设置 · 网络与代理」里配代理或加镜像前缀，或先下载好安装包再用「用本地安装包更新」。',
        { list },
      ),
  )
}

/** 小文件（SHA256SUMS）：按同样的来源顺序取文本，每个来源限时 */
export async function fetchText(sources: PackageSource[], fetch: NetFetch, timeoutMs = 30_000) {
  const failures: string[] = []
  for (const s of sources) {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const url = s.api ? await resolveApiAsset(fetch, s.url, signal) : s.url
      const res = await fetch(url, { headers: { ...UA }, timeoutMs: 15_000, signal })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${res.status}`)
      }
      return await res.text()
    } catch (e) {
      failures.push(`${s.label}：${signal.aborted ? t('超时') : (e as Error).message}`)
    }
  }
  throw new Error(t('下载校验文件失败：{status}', { status: failures.join('；') }))
}

/** 从 Release feed 补上的版本没有 API 附件地址：按 tag 问一次 API 补上；问不到就只走原地址和镜像 */
export async function apiAssetUrls(fetch: NetFetch, apiBase: string, tag: string, names: string[]) {
  try {
    const res = await fetch(`${apiBase}/tags/${encodeURIComponent(tag)}`, {
      headers: { ...UA, Accept: 'application/vnd.github+json' },
      timeoutMs: 15_000,
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return {}
    }
    const assets = ((await res.json()) as { assets?: { name: string; url: string }[] }).assets ?? []
    return Object.fromEntries(names.map((n) => [n, assets.find((a) => a.name === n)?.url]))
  } catch {
    return {}
  }
}

const fileName = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')

/**
 * 下载一个版本的安装包和校验文件。job 上实时写正在用的来源、放弃过的来源和进度，页面照着显示。
 * 返回 SHA256SUMS 的内容，由调用方校验。
 */
export async function downloadRelease(
  rel: AppRelease,
  file: string,
  job: AppUpdateJob,
  o: { fetch: NetFetch; apiBase: string; sources: GithubSourceSetting[]; touch: () => void; stallMs?: number },
) {
  let { assetApiUrl, sumsApiUrl } = rel
  if (!assetApiUrl) {
    const found = await apiAssetUrls(o.fetch, o.apiBase, rel.tag, [fileName(rel.tarUrl), 'SHA256SUMS'])
    assetApiUrl = found[fileName(rel.tarUrl)]
    sumsApiUrl = found.SHA256SUMS
  }
  job.attempts = []
  const source = await fetchPackage(
    packageSources({ apiUrl: assetApiUrl, url: rel.tarUrl, sources: o.sources }),
    file,
    `${rel.tag}/${fileName(rel.tarUrl)}`,
    {
      fetch: o.fetch,
      stallMs: o.stallMs,
      onSource: (label) => {
        job.source = label
        job.received = 0
        o.touch()
      },
      onFail: (label, error) => {
        job.attempts = [...(job.attempts ?? []), { source: label, error }]
        o.touch()
      },
      onTotal: (n) => {
        if (n) job.total = n
      },
      onBytes: (n) => {
        job.received += n
        o.touch()
      },
    },
  )
  job.source = source
  return fetchText(packageSources({ apiUrl: sumsApiUrl, url: rel.sumsUrl ?? '', sources: o.sources }), o.fetch)
}
