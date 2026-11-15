import { createHash } from 'node:crypto'
import { WrapRecipe, recipeFile, type WrapRecipe as Recipe } from '../../../shared/plugins/wrap/recipe.ts'
import { netError, netFetch } from '../../net.ts'
import { downloadSource } from '../github.ts'
import { readZip } from '../zip.ts'
import type { ReleaseInfo, RepoFile } from './detect.ts'

/**
 * 包装器取仓库（ADR 0068）：先把要包装的版本固定到一个提交（发了 Release 的取最新 Release 的标签、否则默认分支），
 * 再下载那个提交的源码包，只读不执行。仓库的简介、许可、Release 附件的 sha256 从 GitHub 接口读。
 * 同一个提交十分钟内不重复下载：预览里改勾选会重新生成，不必每次都下。
 */

export interface RepoSnapshot {
  repo: string
  /** 要包装的那个提交 */
  commit: string
  /** 提交对应的标签或分支名（界面上写「main」「v3.2.0」） */
  ref: string
  /** 提交时间（ISO） */
  date: string
  description: string
  /** SPDX 名（Apache-2.0）；没有许可证为空 */
  license: string
  homepage: string
  release?: ReleaseInfo
  /** 相对仓库根，已剥掉 GitHub 源码包外面那层目录 */
  files: RepoFile[]
}

const API = 'https://api.github.com'
const HEADERS = (): Record<string, string> => ({
  'User-Agent': 'agent-panel',
  Accept: 'application/vnd.github+json',
  // 匿名每小时 60 次，设了 GITHUB_TOKEN 的用它（和面板自己查更新同一个变量）
  ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
})

async function api<T>(path: string, what: string, allow404 = false): Promise<T | undefined> {
  let res: Response
  try {
    res = await netFetch(`${API}${path}`, { headers: HEADERS(), timeoutMs: 30_000 })
  } catch (e) {
    throw new Error(`${what}失败：${netError(e)}`)
  }
  if (res.status === 404 && allow404) return undefined
  if (res.status === 404) throw new Error(`${what}失败：仓库不存在或不是公开仓库`)
  if (res.status === 403 || res.status === 429)
    throw new Error(`${what}失败：GitHub 接口限流了（匿名每小时 60 次），稍后再试，或设置环境变量 GITHUB_TOKEN`)
  if (!res.ok) throw new Error(`${what}失败：HTTP ${res.status}`)
  return (await res.json()) as T
}

/** 「owner/repo」「https://github.com/owner/repo(/tree/<ref>)」都认；ref 写了就固定到它 */
export function parseWrapUrl(input: string): { repo: string; ref?: string } {
  const s = input
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
  const m =
    /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/(?:tree|releases\/tag)\/([^/]+))?(?:\/.*)?$/.exec(
      s,
    )
  if (!m) throw new Error('GitHub 链接要写成 https://github.com/owner/repo')
  return { repo: `${m[1]}/${m[2]}`, ...(m[3] && { ref: decodeURIComponent(m[3]) }) }
}

/** 剥掉源码包外面那层「仓库名-提交/」目录 */
function stripTop(entries: { name: string; data: Buffer }[]): RepoFile[] {
  const tops = new Set(entries.map((e) => e.name.split('/')[0]))
  const top = tops.size === 1 ? `${[...tops][0]}/` : ''
  return entries
    .filter((e) => e.name.startsWith(top) && e.name.length > top.length)
    .map((e) => ({ path: e.name.slice(top.length), data: e.data }))
}

type Repo = { description?: string; default_branch: string; homepage?: string; license?: { spdx_id?: string } | null }
type Release = { tag_name: string; assets?: { name: string; digest?: string | null }[] }
type Commit = { sha: string; commit: { committer?: { date?: string }; author?: { date?: string } } }

const cache = new Map<string, { at: number; snap: RepoSnapshot }>() // 模块状态：缓存，丢了重新下载
const CACHE_MS = 10 * 60_000

/**
 * 取仓库快照。track 决定「最新」指什么：release 用最新 Release 的标签（没有 Release 退回默认分支），
 * tag / branch 用传入的 ref 或默认分支
 */
export async function fetchRepo(input: { repo: string; ref?: string; track?: Recipe['track'] }): Promise<RepoSnapshot> {
  const { repo } = input
  const meta = (await api<Repo>(`/repos/${repo}`, '读仓库信息'))!
  const release =
    !input.ref && (input.track ?? 'release') === 'release'
      ? await api<Release>(`/repos/${repo}/releases/latest`, '读最新 Release', true)
      : input.ref
        ? await api<Release>(`/repos/${repo}/releases/tags/${encodeURIComponent(input.ref)}`, '读 Release', true)
        : undefined
  const ref = input.ref ?? release?.tag_name ?? meta.default_branch
  const commit = (await api<Commit>(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, '读提交'))!
  const key = `${repo}@${commit.sha}`
  for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k)
  const hit = cache.get(key)
  if (hit) return { ...hit.snap, ref }
  const files = stripTop(readZip(await downloadSource(repo, commit.sha)))
  const snap: RepoSnapshot = {
    repo,
    commit: commit.sha,
    ref,
    date: commit.commit.committer?.date ?? commit.commit.author?.date ?? '',
    description: meta.description ?? '',
    license: meta.license?.spdx_id && meta.license.spdx_id !== 'NOASSERTION' ? meta.license.spdx_id : '',
    homepage: meta.homepage ?? '',
    ...(release && {
      release: {
        tag: release.tag_name,
        assets: (release.assets ?? []).map((a) => ({
          name: a.name,
          sha256: /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? '')?.[1] ?? '',
        })),
      },
    }),
    files,
  }
  cache.set(key, { at: Date.now(), snap })
  return snap
}

/**
 * 插件市场里的社区配方（wraps/<owner>__<repo>.json）：有就按配方，没有返回 undefined。
 * 格式不对直接报错（配方是审核过才合进市场的，坏了要让人知道，不悄悄退回识别器）
 */
export async function readCommunityRecipe(market: string, repo: string): Promise<Recipe | undefined> {
  const file = recipeFile(repo)
  let res: Response
  try {
    res = await netFetch(`https://raw.githubusercontent.com/${market}/HEAD/${file}`, {
      headers: { 'User-Agent': 'agent-panel' },
      timeoutMs: 30_000,
    })
  } catch (e) {
    throw new Error(`读社区配方失败：${netError(e)}`)
  }
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`读社区配方失败：HTTP ${res.status}`)
  const p = WrapRecipe.safeParse(await res.json().catch(() => null))
  if (!p.success) throw new Error(`插件市场里的配方 ${file} 格式不对：${p.error.issues[0]?.message ?? ''}`)
  if (p.data.repo.toLowerCase() !== repo.toLowerCase())
    throw new Error(`配方 ${file} 写的仓库是 ${p.data.repo}，对不上`)
  return p.data
}

/** 下载 Release 附件并核对 sha256（确认安装后才调） */
export async function downloadAsset(repo: string, tag: string, asset: string, sha256: string) {
  const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`
  let res: Response
  try {
    res = await netFetch(url, { headers: { 'User-Agent': 'agent-panel' }, timeoutMs: 120_000 })
  } catch (e) {
    throw new Error(`下载 ${asset} 失败：${netError(e)}`)
  }
  if (!res.ok) throw new Error(`下载 ${asset} 失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== sha256) throw new Error(`${asset} 的校验和对不上（应为 ${sha256}，下载到的是 ${got}），没有安装`)
  return buf
}

/** 测试用 */
export const resetWrapCache = () => cache.clear()

/**
 * 上游现在的「最新」：release 看最新 Release 的标签，tag 看最新的标签，branch 看分支头的提交。
 * 只读接口不下载，查更新用
 */
export async function upstreamHead(repo: string, track: Recipe['track'], ref?: string) {
  if (track === 'release') {
    const r = await api<Release>(`/repos/${repo}/releases/latest`, '读最新 Release', true)
    if (r) return { ref: r.tag_name, commit: '' }
  }
  if (track === 'tag') {
    const tags = await api<{ name: string; commit: { sha: string } }[]>(`/repos/${repo}/tags?per_page=1`, '读标签')
    if (tags?.[0]) return { ref: tags[0].name, commit: tags[0].commit.sha }
  }
  const head = ref ?? (await api<Repo>(`/repos/${repo}`, '读仓库信息'))!.default_branch
  const c = (await api<Commit>(`/repos/${repo}/commits/${encodeURIComponent(head)}`, '读提交'))!
  return { ref: head, commit: c.sha }
}
