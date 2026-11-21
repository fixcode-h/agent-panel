/**
 * GitHub 下载来源（注册表）：同一份 GitHub 上的文件，换几个地方取。
 *
 * 为什么要有：国内 raw.githubusercontent.com 常被重置连接（2026-11-20 用户读 UEKit 插件目录，代理和直连都 ECONNRESET），
 * 但 github.com、api.github.com 往往还能通。面板所有出网都经 `netFetch`（server/net.ts），它在原地址（含代理回退）
 * 失败后按这里的顺序换来源再取，插件目录、插件升级包、面板自身更新都自动受益，调用方不用改。
 *
 * 加一种来源：在 BUILTIN_SOURCES 里加一项（rewrite 把解析好的地址换成这个来源的地址，不适用返回 null），
 * 设置页「网络与代理 · GitHub 下载来源」会自动列出、可调顺序和开关。镜像前缀（第三方加速站）是用户自己加的，
 * 不内置任何站点。
 */
import { z } from 'zod'
import { t } from '../i18n.ts'

/**
 * 解析出的 GitHub 地址。raw：仓库里的一个文件（能换 API、网页、jsDelivr 取）；
 * release：Release 附件；archive：源码包（codeload）；page：github.com 上别的地址；api：api.github.com。
 * 后三种（含 release）只能换镜像前缀，GitHub 自己的备用地址最后都会跳到同一个被墙的下载域名。
 */
export type GithubUrl =
  | { kind: 'raw'; url: string; owner: string; repo: string; ref: string; path: string }
  | { kind: 'release' | 'archive' | 'page' | 'api'; url: string }

export type GithubUrlKind = GithubUrl['kind']

/** 换来源后实际去取的地址；transform 表示取回来的不是文件本身，要再抽出来（见 web-blob.ts） */
export interface SourceCandidate {
  url: string
  headers?: Record<string, string>
  transform?: 'web-blob'
}

/** 设置里存的一项：内置来源按 id，镜像前缀 id 固定为 mirror、地址在 prefix */
export const GithubSourceSetting = z.object({
  id: z.string(),
  enabled: z.boolean(),
  prefix: z.string().trim().optional(),
})
export type GithubSourceSetting = z.infer<typeof GithubSourceSetting>

export interface SourceDef {
  id: string
  label: () => string
  desc: () => string
  /** 适用哪几种地址（设置页显示用；真正判断看 rewrite 返回不返回） */
  kinds: GithubUrlKind[]
  rewrite: (u: GithubUrl, prefix?: string) => SourceCandidate | null
}

const RAW_HOST = 'raw.githubusercontent.com'
const DOWNLOAD_HOSTS = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com']

/** 把地址里的路径段拆开（保留原来的编码，换地址时原样拼回去） */
function segments(pathname: string) {
  return pathname.split('/').filter(Boolean)
}

/** 分支写成 refs/heads/x、refs/tags/x 时 ref 取 x */
function splitRef(rest: string[]) {
  if (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') && rest.length > 3)
    return { ref: rest[2], path: rest.slice(3) }
  return { ref: rest[0], path: rest.slice(1) }
}

/** 认得的 GitHub 地址返回解析结果，别的（hf-mirror、npm……）返回 null，netFetch 照原样取 */
export function parseGithubUrl(url: string): GithubUrl | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase()
  const seg = segments(u.pathname)
  if (host === RAW_HOST) {
    if (seg.length < 4) return { kind: 'page', url }
    const { ref, path } = splitRef(seg.slice(2))
    if (!path.length) return { kind: 'page', url }
    return { kind: 'raw', url, owner: seg[0], repo: seg[1], ref, path: path.join('/') }
  }
  if (host === 'api.github.com') return { kind: 'api', url }
  if (host === 'codeload.github.com') return { kind: 'archive', url }
  if (DOWNLOAD_HOSTS.includes(host)) return { kind: 'release', url }
  if (host !== 'github.com' && host !== 'www.github.com') return null
  const [owner, repo, kind, ...rest] = seg
  // github.com/o/r/raw/<ref>/<path>，以及 blob/<ref>/<path>?raw=true：都是仓库里的文件
  if (owner && repo && (kind === 'raw' || (kind === 'blob' && /[?&]raw=true(&|$)/.test(u.search))) && rest.length > 1) {
    const { ref, path } = splitRef(rest)
    if (path.length) return { kind: 'raw', url, owner, repo, ref, path: path.join('/') }
  }
  if (kind === 'releases' && rest.includes('download')) return { kind: 'release', url }
  if (kind === 'archive') return { kind: 'archive', url }
  return { kind: 'page', url }
}

/** 镜像前缀补成以 / 结尾；不是 http(s) 地址返回空串（设置页提示不对） */
export function normalizePrefix(prefix = '') {
  const p = prefix.trim()
  if (!/^https?:\/\/[^/\s]+/i.test(p)) return ''
  return p.endsWith('/') ? p : `${p}/`
}

const isHead = (ref: string) => ref === 'HEAD'

export const BUILTIN_SOURCES: SourceDef[] = [
  {
    id: 'origin',
    label: () => t('原地址'),
    desc: () => t('按原来的地址取；「使用代理」打开时经过代理和本机代理回退，关着时直连'),
    kinds: ['raw', 'release', 'archive', 'page', 'api'],
    rewrite: (u) => ({ url: u.url }),
  },
  {
    id: 'api',
    label: () => 'GitHub API',
    desc: () => t('经 api.github.com 取仓库文件；不登录每小时限 60 次'),
    kinds: ['raw'],
    rewrite: (u) =>
      u.kind === 'raw'
        ? {
            url:
              `https://api.github.com/repos/${u.owner}/${u.repo}/contents/${u.path}` +
              (isHead(u.ref) ? '' : `?ref=${u.ref}`),
            // 要原始内容：默认返回的是 base64 包在 JSON 里，还有 1 MB 上限
            headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'agent-panel' },
          }
        : null,
  },
  {
    id: 'web',
    label: () => t('GitHub 网页'),
    desc: () => t('打开 github.com 上这个文件的网页，从页面里取出文件内容；只适用文本文件'),
    kinds: ['raw'],
    rewrite: (u) =>
      u.kind === 'raw'
        ? {
            url: `https://github.com/${u.owner}/${u.repo}/blob/${u.ref}/${u.path}`,
            headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 agent-panel' },
            transform: 'web-blob',
          }
        : null,
  },
  {
    id: 'jsdelivr',
    label: () => 'jsDelivr',
    desc: () => t('经 cdn.jsdelivr.net 取仓库文件；按分支名取时可能晚几个小时才更新'),
    kinds: ['raw'],
    // 分支写 HEAD 时 jsDelivr 会取最新的 tag 而不是默认分支，内容对不上，不用它
    rewrite: (u) =>
      u.kind === 'raw' && !isHead(u.ref)
        ? { url: `https://cdn.jsdelivr.net/gh/${u.owner}/${u.repo}@${u.ref}/${u.path}` }
        : null,
  },
]

/** 用户加的镜像前缀：前缀 + 原地址。API 不经镜像（多数加速站不转发 API，转了也要带令牌） */
export const MIRROR_SOURCE: SourceDef = {
  id: 'mirror',
  label: () => t('镜像前缀'),
  desc: () => t('原地址前面加上镜像站的前缀再取，Release 附件和源码包也能走'),
  kinds: ['raw', 'release', 'archive', 'page'],
  rewrite: (u, prefix) => {
    const p = normalizePrefix(prefix)
    return p && u.kind !== 'api' ? { url: `${p}${u.url}` } : null
  },
}

const BUILTIN_IDS = BUILTIN_SOURCES.map((s) => s.id)

/** 展开后的一项：key 在列表里唯一（镜像是 mirror:<前缀>） */
export interface ResolvedSource {
  key: string
  def: SourceDef
  enabled: boolean
  prefix?: string
}

/**
 * 设置里的列表 → 实际顺序：按存的顺序，认不得的 id、空的或重复的镜像丢掉；
 * 存的列表里没有的内置来源（第一次用、或以后新加的）按默认顺序接在后面，默认打开。
 */
export function resolveSources(list: GithubSourceSetting[] = []): ResolvedSource[] {
  const out: ResolvedSource[] = []
  const seen = new Set<string>()
  for (const e of list) {
    if (e.id === MIRROR_SOURCE.id) {
      const prefix = normalizePrefix(e.prefix)
      const key = `mirror:${prefix}`
      if (!prefix || seen.has(key)) continue
      seen.add(key)
      out.push({ key, def: MIRROR_SOURCE, enabled: e.enabled, prefix })
      continue
    }
    const def = BUILTIN_SOURCES.find((s) => s.id === e.id)
    if (!def || seen.has(def.id)) continue
    seen.add(def.id)
    out.push({ key: def.id, def, enabled: e.enabled })
  }
  for (const id of BUILTIN_IDS) {
    if (seen.has(id)) continue
    out.push({ key: id, def: BUILTIN_SOURCES.find((s) => s.id === id)!, enabled: true })
  }
  return out
}

/** 展开后的列表存回设置的样子 */
export function toSettingList(list: ResolvedSource[]): GithubSourceSetting[] {
  return list.map((s) =>
    s.prefix ? { id: s.def.id, enabled: s.enabled, prefix: s.prefix } : { id: s.def.id, enabled: s.enabled },
  )
}

/** 这个地址按顺序要试的来源（只算打开的、适用的；同一个地址只试一次） */
export function candidatesFor(u: GithubUrl, list: ResolvedSource[]) {
  const out: { source: ResolvedSource; candidate: SourceCandidate }[] = []
  const urls = new Set<string>()
  for (const source of list) {
    if (!source.enabled) continue
    const candidate = source.def.rewrite(u, source.prefix)
    if (!candidate || urls.has(candidate.url)) continue
    urls.add(candidate.url)
    out.push({ source, candidate })
  }
  return out
}

/** 来源显示名：镜像带上它的主机名，失败信息里分得清是哪一个 */
export function sourceLabel(s: ResolvedSource) {
  if (!s.prefix) return s.def.label()
  let host = s.prefix
  try {
    host = new URL(s.prefix).host
  } catch {
    // 前缀已经校验过，解析不了时原样显示
  }
  return `${s.def.label()} ${host}`
}

/** 设置页「检测」用的样例文件：面板自己仓库里的 package.json，小、公开、一定在 */
export const SAMPLE_RAW_URL = 'https://raw.githubusercontent.com/fixcode-h/agent-panel/main/package.json'
