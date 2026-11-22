/**
 * 小工具「GitHub 加速下载」的共用部分：把用户贴进来的各种 GitHub 地址整理成能直接下载的地址，
 * 按「下载来源」（shared/github-sources/registry.ts）列出可以从哪里取，以及下载任务的形状。
 * 正式后端（server/tools/gh-download.ts）和演示后端用同一份。
 */
import { z } from 'zod'
import { t } from '../i18n.ts'
import {
  parseGithubUrl,
  resolveSources,
  sourceLabel,
  type GithubSourceSetting,
  type ResolvedSource,
  type SourceCandidate,
} from '../github-sources/registry.ts'

/** 「自动」：按设置里的来源顺序逐个试，卡住或失败就换下一个 */
export const AUTO_SOURCE = 'auto'

export interface NormalizedUrl {
  /** 实际去下载的地址（还没换来源） */
  url: string
  /** 存盘用的文件名 */
  name: string
}

// 模块状态：常量，加载后不改
const GITHUB_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'gist.githubusercontent.com',
])

/** 文件名里不能有的字符换成 _，空的给个兜底名 */
function safeName(name: string) {
  // 控制字符（码点 < 32）也换掉：Windows 的文件名里不许有
  const n = [...name.replace(/[\\/:*?"<>|]/g, '_')]
    .map((c) => (c.charCodeAt(0) < 32 ? '_' : c))
    .join('')
    .trim()
  return n && n !== '.' && n !== '..' ? n : 'download'
}

function lastSegment(pathname: string) {
  const seg = pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/**
 * 用户贴的地址 → 下载地址和文件名。认得：文件网页（blob，换成 raw）、仓库首页或某个分支（tree，换成源码 zip）、
 * Release 附件、源码包、raw 文件。没写 https:// 的补上；别的网站的地址返回错误说明。
 */
export function normalizeGithubInput(input: string): NormalizedUrl | { error: string } {
  let text = input.trim()
  if (!text) return { error: t('先填一个 GitHub 地址') }
  // 没写协议的补上；http:// 一律换成 https://（GitHub 只认 https）
  text = /^https?:\/\//i.test(text) ? text.replace(/^http:/i, 'https:') : `https://${text.replace(/^\/+/, '')}`
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { error: t('这不是一个有效的地址') }
  }
  const host = u.hostname.toLowerCase()
  if (!GITHUB_HOSTS.has(host)) return { error: t('只支持 GitHub 的地址（github.com、raw.githubusercontent.com 等）') }
  const seg = u.pathname.split('/').filter(Boolean)
  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repo, kind, ...rest] = seg
    if (!owner || !repo) return { error: t('地址里要有仓库：github.com/<用户>/<仓库>/…') }
    const name = repo.replace(/\.git$/i, '')
    // 文件网页：换成 raw 地址，下回来的才是文件本身而不是网页
    if (kind === 'blob' && rest.length > 1) {
      const url = `https://raw.githubusercontent.com/${owner}/${name}/${rest.join('/')}`
      return { url, name: safeName(lastSegment(url)) }
    }
    // 仓库首页、某个分支：下载源码 zip
    if (!kind || kind === 'tree') {
      const ref = kind === 'tree' && rest.length ? rest.join('/') : 'HEAD'
      return {
        url: `https://github.com/${owner}/${name}/archive/${ref}.zip`,
        name: safeName(`${name}-${ref.replace(/\//g, '-')}.zip`),
      }
    }
    if (kind === 'archive') {
      const file = lastSegment(u.pathname)
      return { url: u.toString(), name: safeName(file.startsWith(name) ? file : `${name}-${file}`) }
    }
    if (kind === 'releases' && rest.includes('download'))
      return { url: u.toString(), name: safeName(lastSegment(u.pathname)) }
    if (kind === 'raw') return { url: u.toString(), name: safeName(lastSegment(u.pathname)) }
    return { error: t('这个地址不是文件：请贴文件、Release 附件或仓库的地址') }
  }
  return { url: u.toString(), name: safeName(lastSegment(u.pathname)) }
}

/** 一个可选的下载来源：key 和设置里的一致，ResolvedSource 展开后的 key */
export interface DownloadCandidate {
  key: string
  label: string
  url: string
  headers?: Record<string, string>
  enabled: boolean
}

/**
 * 这个地址能从哪些来源下：按设置里的顺序，含关着的（界面上能手动挑）。
 * 网页来源（从页面里抠文本）不适合下载文件，不列。
 */
export function downloadCandidates(url: string, sources: GithubSourceSetting[]): DownloadCandidate[] {
  const parsed = parseGithubUrl(url)
  if (!parsed) return []
  const out: DownloadCandidate[] = []
  for (const s of resolveSources(sources) as ResolvedSource[]) {
    const c: SourceCandidate | null = s.def.rewrite(parsed, s.prefix)
    if (!c || c.transform || out.some((x) => x.url === c.url)) continue
    out.push({ key: s.key, label: sourceLabel(s), url: c.url, headers: c.headers, enabled: s.enabled })
  }
  return out
}

/** 按用户的选择挑要试的来源：自动 = 打开的全部按顺序；指定了就只用那一个（关着的也行，是用户点名的） */
export function pickCandidates(list: DownloadCandidate[], pick: string) {
  if (pick === AUTO_SOURCE) return list.filter((c) => c.enabled)
  return list.filter((c) => c.key === pick)
}

export const GhDownloadStatus = z.enum(['running', 'done', 'failed', 'cancelled'])
export type GhDownloadStatus = z.infer<typeof GhDownloadStatus>

export const GhDownloadJob = z.object({
  id: z.string(),
  /** 用户贴的地址 */
  input: z.string(),
  /** 整理后的下载地址 */
  url: z.string(),
  name: z.string(),
  /** 用户选的来源：auto 或某个来源的 key */
  pick: z.string(),
  status: GhDownloadStatus,
  /** 正在用（或最后用成）的来源 */
  source: z.string().optional(),
  /** 放弃过的来源和原因 */
  attempts: z.array(z.object({ source: z.string(), error: z.string() })).optional(),
  received: z.number(),
  total: z.number().optional(),
  /** 存到哪：开始时就定好（重名时自动加序号） */
  path: z.string(),
  error: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
})
export type GhDownloadJob = z.infer<typeof GhDownloadJob>

export const GhDownloadStart = z.object({
  url: z.string().min(1),
  source: z.string().default(AUTO_SOURCE),
  /** 存到哪个目录；空 = 默认的下载目录 */
  dir: z.string().optional(),
})
export type GhDownloadStart = z.infer<typeof GhDownloadStart>

export const GhDownloadOverview = z.object({
  jobs: z.array(GhDownloadJob),
  /** 默认的下载目录（本机「下载」文件夹） */
  defaultDir: z.string(),
  /** 设置里的下载来源，界面按它列出可选的来源 */
  sources: z.array(z.object({ id: z.string(), enabled: z.boolean(), prefix: z.string().optional() })),
})
export type GhDownloadOverview = z.infer<typeof GhDownloadOverview>
