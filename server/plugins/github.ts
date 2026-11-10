import { z } from 'zod'
import { netError, netFetch } from '../net.ts'

/**
 * 从 GitHub 装插件（ADR 0059）。插件仓库根上放 plugins.json（插件目录）：每个插件写 id、名字、版本、简介和下载方式，
 * 下载方式二选一：Release 附件（tag + asset，构建好的插件包 zip），或者仓库里的子目录（path，目录里就是构建好的包）。
 * 没有 plugins.json 的仓库当作单个插件：仓库根（或指定子目录）上要有 plugin.json。
 * 默认的插件市场是 fixcode-h/agent-plugins。
 */
export const DEFAULT_MARKET = 'fixcode-h/agent-plugins'

export const MarketEntry = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().default(''),
  icon: z.string().default('puzzle'),
  /** Release 附件：tag 和文件名 */
  tag: z.string().optional(),
  asset: z.string().optional(),
  /** 仓库里的子目录（没有 Release 附件时下载源码包取这个目录） */
  path: z.string().optional(),
  homepage: z.string().optional(),
})
export type MarketEntry = z.infer<typeof MarketEntry>
const MarketIndex = z.object({ plugins: z.array(MarketEntry) })

/** 「owner/repo」「https://github.com/owner/repo(.git)(/tree/<ref>/<path>)」都认 */
export function parseRepo(input: string): { repo: string; ref?: string; path?: string } {
  const s = input.trim().replace(/\.git$/, '')
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/.exec(s)
  if (!m) throw new Error('GitHub 地址要写成 owner/repo 或 https://github.com/owner/repo')
  return { repo: `${m[1]}/${m[2]}`, ...(m[3] && { ref: m[3] }), ...(m[4] && { path: m[4] }) }
}

const HEADERS = { 'User-Agent': 'agent-panel' }

async function get(url: string, what: string) {
  let res: Response
  try {
    res = await netFetch(url, { headers: HEADERS, timeoutMs: 60_000 })
  } catch (e) {
    throw new Error(`${what}失败：${netError(e)}`)
  }
  return res
}

/** 仓库的插件目录；仓库没有 plugins.json 时返回 undefined（当作单个插件） */
export async function readMarket(repo: string, ref = 'HEAD') {
  const res = await get(
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/plugins.json`,
    '读插件目录',
  )
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`读插件目录失败：HTTP ${res.status}`)
  const p = MarketIndex.safeParse(await res.json().catch(() => null))
  if (!p.success) throw new Error('仓库里的 plugins.json 格式不对')
  return p.data.plugins
}

async function download(url: string, what: string) {
  const res = await get(url, what)
  if (!res.ok) throw new Error(`${what}失败：HTTP ${res.status}（${url}）`)
  return Buffer.from(await res.arrayBuffer())
}

/** 源码包：分支或标签的 zip（GitHub 会包一层「仓库名-ref/」目录，packageRoot 会剥掉） */
export const downloadSource = (repo: string, ref = 'HEAD') =>
  download(`https://codeload.github.com/${repo}/zip/${ref === 'HEAD' ? 'HEAD' : encodeURIComponent(ref)}`, '下载源码包')

/** 插件目录里的一项：有 Release 附件下附件，否则下源码包取子目录 */
export async function downloadEntry(repo: string, e: MarketEntry, ref = 'HEAD') {
  if (e.tag && e.asset)
    return {
      zip: await download(
        `https://github.com/${repo}/releases/download/${encodeURIComponent(e.tag)}/${encodeURIComponent(e.asset)}`,
        '下载插件包',
      ),
      path: '',
    }
  return { zip: await downloadSource(repo, ref), path: e.path ?? e.id }
}
