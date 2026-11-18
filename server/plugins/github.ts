import { createHash } from 'node:crypto'
import { z } from 'zod'
import { t } from '../../shared/i18n.ts'
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
  /**
   * 包装配方（插件仓库 wraps/，ADR 0068）：上游仓库 owner/repo。安装走「从 GitHub 包装」，没有插件包可下载、
   * 不参加检查更新和依赖安装（installable 过滤掉）。plugins.json 里写在单独的 wraps 数组，旧面板读不到就不显示
   */
  wrap: z.string().optional(),
})
export type MarketEntry = z.infer<typeof MarketEntry>
/** plugins.json 的 wraps：只列配方，版本跟着上游走，不写版本号 */
const MarketWrap = z.object({
  repo: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  icon: z.string().default('puzzle'),
  homepage: z.string().optional(),
})
const MarketIndex = z.object({ plugins: z.array(MarketEntry), wraps: z.array(MarketWrap).catch([]).default([]) })

/** 能直接下载插件包的条目（去掉包装配方）：检查更新、装依赖、按 id 安装只看这些 */
export const installable = (list: MarketEntry[]) => list.filter((e) => !e.wrap)

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

/**
 * 把分支名（默认 HEAD）换成提交号：raw.githubusercontent.com 按地址缓存约 5 分钟，用分支名读，刚发版后点「刷新」
 * 还会拿到旧的 plugins.json（市场显示旧版本，一键更新装上旧版）；按提交号读每次都是最新内容。
 * 换不到（限流、断网、私有仓库）就照旧用分支名，不因此读不了市场。
 */
export async function resolveRef(repo: string, ref = 'HEAD') {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref
  try {
    const res = await netFetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: { ...HEADERS, Accept: 'application/vnd.github.sha' },
      timeoutMs: 15_000,
    })
    const sha = res.ok ? (await res.text()).trim() : ''
    return /^[0-9a-f]{40}$/.test(sha) ? sha : ref
  } catch {
    return ref
  }
}

/** 仓库的插件目录；仓库没有 plugins.json 时返回 undefined（当作单个插件） */
export async function readMarket(repo: string, ref = 'HEAD') {
  const res = await get(
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(await resolveRef(repo, ref))}/plugins.json`,
    '读插件目录',
  )
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`读插件目录失败：HTTP ${res.status}`)
  return parseMarketIndex(await res.json().catch(() => null))
}

/** plugins.json → 市场条目：配方排在插件后面，和插件同一张列表给界面（标「包装」，安装走包装流程）；和插件同 id 的配方不列 */
export function parseMarketIndex(json: unknown): MarketEntry[] {
  const p = MarketIndex.safeParse(json)
  if (!p.success) throw new Error('仓库里的 plugins.json 格式不对')
  const wraps = p.data.wraps
    .filter((w) => !p.data.plugins.some((e) => e.id === w.id))
    .map(({ repo, ...w }): MarketEntry => ({ ...w, version: '', wrap: repo }))
  return [...p.data.plugins, ...wraps]
}

/** 单个插件的仓库：读 ref 上（子目录里）plugin.json 的版本号；没有这个文件返回 undefined */
export async function readRepoVersion(repo: string, ref = 'HEAD', sub = '') {
  const dir = sub.replace(/^\/+|\/+$/g, '')
  const file = `${dir ? `${dir}/` : ''}plugin.json`
  const res = await get(
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${file.split('/').map(encodeURIComponent).join('/')}`,
    '读插件清单',
  )
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`读插件清单失败：HTTP ${res.status}`)
  const raw = (await res.json().catch(() => null)) as { version?: unknown } | null
  return typeof raw?.version === 'string' ? raw.version : undefined
}

async function download(url: string, what: string) {
  const res = await get(url, what)
  if (!res.ok) throw new Error(`${what}失败：HTTP ${res.status}（${url}）`)
  return Buffer.from(await res.arrayBuffer())
}

/** 源码包：分支或标签的 zip（GitHub 会包一层「仓库名-ref/」目录，packageRoot 会剥掉） */
export const downloadSource = (repo: string, ref = 'HEAD') =>
  download(`https://codeload.github.com/${repo}/zip/${ref === 'HEAD' ? 'HEAD' : encodeURIComponent(ref)}`, '下载源码包')

/**
 * Release 附件旁边的校验文件 <附件>.sha256（插件仓库发布时一起上传，内容是 sha256 的十六进制，后面可以跟文件名）。
 * 旧的 Release 没有这个文件：返回空，不校验
 */
async function expectedSha(url: string) {
  const res = await get(`${url}.sha256`, '下载插件包的校验文件')
  if (res.status === 404) return ''
  if (!res.ok) throw new Error(`下载插件包的校验文件失败：HTTP ${res.status}`)
  const hex = (await res.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('插件包的校验文件格式不对')
  return hex
}

/** 下载的包和发布时的 sha256 对不上就不装：传输损坏、附件被换过都会在这里拦下 */
export function verifySha(zip: Buffer, expected: string, name: string) {
  if (!expected) return
  const got = createHash('sha256').update(zip).digest('hex')
  if (got !== expected)
    throw new Error(`插件包 ${name} 的校验和对不上（应为 ${expected}，下载到的是 ${got}），没有安装`)
}

/** 插件目录里的一项：有 Release 附件下附件（有校验文件就核对），否则下源码包取子目录 */
export async function downloadEntry(repo: string, e: MarketEntry, ref = 'HEAD') {
  if (e.tag && e.asset) {
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(e.tag)}/${encodeURIComponent(e.asset)}`
    const [zip, sha] = await Promise.all([download(url, '下载插件包'), expectedSha(url)])
    verifySha(zip, sha, e.asset)
    return { zip, path: '' }
  }
  return { zip: await downloadSource(repo, ref), path: e.path ?? e.id }
}

/**
 * 市场条目写的版本和下载到的包里 plugin.json 的版本要一致：插件仓库改了版本号、但发布没出来（tag / asset 还指着上一版）时，
 * 下载到的其实是旧包，装上去版本不变、界面上却像升级成功了，用户反复点也升不上去。这里直接拦下并说清原因
 */
export function checkEntryVersion(e: MarketEntry, got: string) {
  if (got === e.version) return
  throw new Error(
    t(
      '插件市场写着 {id} v{want}，但下载到的包是 v{got}（{tag}），没有安装：插件仓库的新版本可能还没发布成功，过几分钟点「刷新」再试，还不行请到插件仓库检查发布',
      { id: e.id, want: e.version, got, tag: e.tag && e.asset ? `${e.tag}/${e.asset}` : (e.path ?? e.id) },
    ),
  )
}
