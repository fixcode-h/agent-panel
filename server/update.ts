import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CACHE_DIR } from './store.ts'
import {
  REPO,
  STALE_UPDATE_MS,
  compareVersions,
  minutesUntil,
  parseVersion,
  pickUpdate,
  rateLimitUntil,
  RECENT_RELEASES,
  type AppRelease,
  type AppReleases,
  type AppUpdateBusy,
  type AppUpdateJob,
  type LocalPackageInfo,
} from '../shared/version.ts'
import { capture } from './exec/process.ts'
import { recordInterrupted, type InterruptedEntry } from './interrupted.ts'
import { netFetch } from './net.ts'
import { downloadFile } from './download.ts'
import { dropStaged, extractPackage, inspectPackage, saveBody, type LocalPackage } from './update-local.ts'
import { log } from './log.ts'
import { t } from '../shared/i18n.ts'

// 出包时由 esbuild 写入版本号；从源码运行时没有
declare const __APP_VERSION__: string | undefined
const BUILT = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

/**
 * 包的根目录（server.mjs 所在目录）：按 server.mjs 自己的位置算，不看当前目录，
 * 在别的目录执行 node /path/server.mjs 也能找到 dist；从源码运行时是仓库根目录。测试时可以用环境变量指定
 */
export const appDir = () =>
  process.env.AGENT_PANEL_APP_DIR ?? (BUILT ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd())
const packaged = () => !!BUILT || !!process.env.AGENT_PANEL_APP_DIR

export function currentVersion() {
  if (process.env.AGENT_PANEL_VERSION) return process.env.AGENT_PANEL_VERSION
  if (BUILT) return BUILT
  try {
    return JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version as string
  } catch {
    return ''
  }
}

const API = () => process.env.AGENT_PANEL_RELEASES_URL ?? `https://api.github.com/repos/${REPO}/releases`
/**
 * Release 的 Atom feed：GitHub API 被限流 / 不可用时用它判断有没有新版本。
 * 它走的是网页 feed，不受 API 的每小时配额限制，但只有版本号、没有安装包地址
 */
const FEED = () => process.env.AGENT_PANEL_RELEASES_FEED_URL ?? `https://github.com/${REPO}/releases.atom`

/** 包里会被替换的文件；data/ 等其他内容不动 */
const FILES = ['server.mjs', 'package.json', 'start.sh', 'install-service.sh', 'README.md', '使用说明.txt']
/** 托盘程序约定的「请重启我」退出码，和 scripts/tray/AgentPanel.cs 里的 RestartCode 一致 */
export const TRAY_RESTART = 75
/** Windows 托盘启动程序：正在运行时不能覆盖，但可以改名，所以先挪开再放新的 */
const TRAY_EXE = 'AgentPanel.exe'
/** 更新前把当前版本整个留在这里：新版本起不来时自动退回，设置里也可以手动回到上一个版本 */
const PREVIOUS = () => path.join(CACHE_DIR, 'updates', 'previous')
const VERSION_FILE = 'version.txt'
/** 上次检查更新的时间和结果 */
const CACHE_FILE = () => path.join(CACHE_DIR, 'updates', 'releases.json')
/** 自动检查更新的间隔 */
const CHECK_EVERY = 6 * 3600_000
/** feed 结果的缓存时间：限流冷却期内连点「检查更新」不反复请求 feed */
const FEED_CACHE_MS = 15 * 60_000

/** 从 feed 读到的最新版本；at 是真正读到它的时间 */
interface FeedLatest {
  at: number
  release: AppRelease
}

interface ReleasesCache {
  at: number
  list: AppRelease[]
  /** 发布列表的 ETag：下次带上 If-None-Match，没变化时 GitHub 回 304，不计入配额 */
  etag?: string
  /** GitHub 限流到这一刻（毫秒）：这期间点「检查更新」也只回缓存，不再撞它的限流 */
  limitedUntil?: number
  /** Release feed 最近一次读到的版本：API 被限流 / 不可用时用它判断有没有新版本 */
  feed?: FeedLatest
}

/** 一次检查的结果：列表，以及它是从 API 还是 feed 兜底拿到的 */
interface ReleasesResult {
  list: AppRelease[]
  source: 'api' | 'feed'
  /** feed 读到的时间（毫秒）：只有 source 为 feed 时才有 */
  feedAt?: number
}

const decodeXml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')

/**
 * 发布的安装包和校验文件按固定的名字放在 Release 下面（名字见 scripts/package.mjs 的 archives，两边要一起改）。
 * 下载地址走 github.com/…/releases/download，不经过 API，限流时照样能下；SHA256SUMS 也在同一处，安装前照常校验
 */
export function releaseAssets(tag: string): Asset[] {
  const base = `agent-panel-${tag.replace(/^v/, '')}`
  const dir = `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/`
  return [`${base}.zip`, `${base}-mac.tar.gz`, `${base}-mac.zip`, `${base}-linux.tar.gz`, 'SHA256SUMS'].map((name) => ({
    name,
    browser_download_url: dir + name,
    size: 0,
  }))
}

/**
 * GitHub 渲染好的更新说明（HTML）转回 Markdown：面板的更新说明按 Markdown 显示。
 * 只认发布说明里会出现的几种标签（标题、列表、段落、加粗、代码、链接），其余标签去掉、只留文字
 */
export function htmlToMarkdown(html: string): string {
  const out = html
    .replace(/\r?\n/g, ' ')
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, n: string, x: string) => `\n\n${'#'.repeat(Number(n))} ${x.trim()}\n\n`,
    )
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, x: string) => `\n- ${x.trim()}`)
    .replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
  return decodeXml(out)
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从 Release 的 Atom feed 里取最新版本：只看第一个 <entry>。
 * feed 里没有安装包列表，地址按发布的固定命名拼出来（releaseAssets）；更新说明取 <content> 里渲染好的 HTML。
 * 大小不知道（0），下载时按响应头补上
 */
export function parseFeed(xml: string, platform: string = process.platform): AppRelease | undefined {
  const entry = /<entry\b[^>]*>([\s\S]*?)<\/entry>/.exec(xml)?.[1]
  if (!entry) return undefined
  const tag = decodeXml(/<title\b[^>]*>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? '').trim()
  const parsed = parseVersion(tag)
  if (!parsed) return undefined
  const updated = /<updated\b[^>]*>([\s\S]*?)<\/updated>/.exec(entry)?.[1]?.trim() ?? ''
  // <link rel="alternate" type="text/html" href="…">：release 页面；属性顺序不固定，按整段找
  const link = [...entry.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).find((t) => /\brel="alternate"/.test(t))
  const href = link ? /href="([^"]*)"/.exec(link)?.[1] : undefined
  // <content type="html"> 里是转义过的 HTML：先还原成 HTML 再转 Markdown
  const content = /<content\b[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1] ?? ''
  const assets = releaseAssets(tag)
  const main = platformAsset(assets, platform)
  return {
    tag,
    version: tag.replace(/^v/, ''),
    prerelease: !!parsed.dev,
    publishedAt: updated,
    notes: htmlToMarkdown(decodeXml(content)),
    url: decodeXml(href ?? ''),
    tarUrl: main.url,
    zipUrl: assets.find((a) => a.name === main.zip)?.browser_download_url ?? '',
    sumsUrl: assets.find((a) => a.name === 'SHA256SUMS')?.browser_download_url ?? '',
    size: 0,
  }
}

function readCache(): ReleasesCache | undefined {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE(), 'utf8'))
    return typeof c?.at === 'number' && Array.isArray(c.list) ? c : undefined
  } catch {
    return undefined
  }
}

/** 限流又没缓存可回退时的报错：告诉用户大概什么时候能恢复，不只说「稍后再试」 */
function rateLimited(status: number, until: number) {
  return new Error(
    t('GitHub 返回 {status}（访问太频繁，约 {minutes} 分钟后恢复）', {
      status,
      minutes: minutesUntil(until),
    }),
  )
}

/** 上一个版本的版本号；没有留下时为空 */
function previousVersion() {
  try {
    return readFileSync(path.join(PREVIOUS(), VERSION_FILE), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 把当前的程序文件（dist、server.mjs 等，不含数据）复制到 to，记下版本号 */
async function backup(dir: string, to: string) {
  await rm(to, { recursive: true, force: true })
  await mkdir(to, { recursive: true })
  if (existsSync(path.join(dir, 'dist'))) await cp(path.join(dir, 'dist'), path.join(to, 'dist'), { recursive: true })
  for (const f of [...FILES, TRAY_EXE]) if (existsSync(path.join(dir, f))) await cp(path.join(dir, f), path.join(to, f))
  await writeFile(path.join(to, VERSION_FILE), currentVersion())
}

/**
 * Windows 上刚解压、刚复制的文件常被杀毒软件或索引服务短暂打开，这时改名、覆盖会报 EPERM / EBUSY；
 * 等一会儿再试通常就好了（和 npm 的 graceful-fs 一样的做法）
 */
async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (i >= tries || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw e
      await new Promise((r) => setTimeout(r, Math.min(200 * i, 1500)))
    }
  }
}

/** 目录改名；一直改不了时（目录里有文件被占用）改成复制过去再删掉原来的 */
async function moveDir(from: string, to: string) {
  try {
    await retry(() => rename(from, to), 8)
  } catch {
    await retry(() => cp(from, to, { recursive: true }))
    await rm(from, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
}

/** 两个文件内容一样（托盘程序大多数版本没有变化，不用换） */
async function sameFile(a: string, b: string) {
  if (!existsSync(a) || !existsSync(b)) return false
  return (await sha256(a)) === (await sha256(b))
}

/**
 * 换托盘程序：它正在运行，不能覆盖，但可以改名，所以先挪开再放新的。
 * 托盘重启服务时自己不退出，上次挪开的 AgentPanel.exe.old 可能就是正在运行的那个，删不掉也不能被覆盖，
 * 这时挪到一个新名字（AgentPanel.exe.old-时间），下次启动时再清理
 */
async function replaceTray(src: string, exe: string) {
  if (await sameFile(src, exe)) return
  if (existsSync(exe)) {
    const old = `${exe}.old`
    await rm(old, { force: true }).catch(() => {})
    const moved = existsSync(old) ? `${old}-${Date.now()}` : old
    await retry(() => rename(exe, moved))
  }
  await retry(() => cp(src, exe))
}

/** 用 src 里的程序文件替换 dir 里的：先放好新的 dist 再换名，data/ 不动 */
async function apply(src: string, dir: string) {
  const dist = path.join(dir, 'dist')
  const next = path.join(dir, 'dist.next')
  const old = path.join(dir, 'dist.old')
  await rm(next, { recursive: true, force: true, maxRetries: 5 })
  await rm(old, { recursive: true, force: true, maxRetries: 5 })
  await retry(() => cp(path.join(src, 'dist'), next, { recursive: true }))
  if (existsSync(dist)) await moveDir(dist, old)
  await moveDir(next, dist)
  for (const f of FILES) if (existsSync(path.join(src, f))) await retry(() => cp(path.join(src, f), path.join(dir, f)))
  // 浏览器扩展（UI 设计用网页生图）：浏览器是从这个目录加载的，原地覆盖文件，目录不换
  if (existsSync(path.join(src, 'extension')))
    await retry(() => cp(path.join(src, 'extension'), path.join(dir, 'extension'), { recursive: true, force: true }))
  if (existsSync(path.join(src, TRAY_EXE))) await replaceTray(path.join(src, TRAY_EXE), path.join(dir, TRAY_EXE))
  // 换成托盘程序后不再需要命令行启动文件
  if (existsSync(path.join(dir, TRAY_EXE))) await rm(path.join(dir, 'start.cmd'), { force: true }).catch(() => {})
  for (const sh of ['start.sh', 'install-service.sh'])
    if (existsSync(path.join(dir, sh))) await chmod(path.join(dir, sh), 0o755).catch(() => {})
  await rm(old, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}

/** 新的 server.mjs 能不能在这台电脑的 Node 上加载：只加载模块就退出，不监听端口 */
async function selfCheck(dir: string) {
  const r = await capture(process.execPath, [path.join(dir, 'server.mjs'), '--self-check'], dir, process.env, 60_000)
  if (r.spawnError || r.code !== 0) {
    const lines = (r.spawnError ?? r.stderr).trim().split('\n').filter(Boolean)
    throw new Error(lines.find((l) => /Error/.test(l)) ?? lines.at(-1) ?? t('退出码 {code}', { code: r.code ?? '' }))
  }
}

const sha256 = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })

/** 一个 Release 里的文件 */
interface Asset {
  name: string
  browser_download_url: string
  size: number
}

/**
 * 这个系统该下载哪个包：三个平台各自一个包，Windows 是 zip（带托盘程序），
 * macOS 是 <名字>-mac.tar.gz，Linux 是 <名字>-linux.tar.gz。
 * 早期版本只有一个通用包（名字里没有平台后缀），找不到本平台的包时才用它。
 * 返回主要下载地址，以及 zip 的名字（Windows 装的就是 zip；macOS / Linux 用它兜底）
 */
export function platformAsset(assets: Asset[], platform: string): { url: string; size: number; zip: string } {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
  const names = assets.map((a) => a.name)
  // 先找带本平台后缀的，再找不带任何平台后缀的通用包
  const pick = (ext: string) =>
    names.find((n) => n.includes(`-${os}.`) && n.endsWith(ext)) ??
    names.find((n) => n.endsWith(ext) && !/-(mac|linux|win)\./.test(n))
  // Windows 只发 zip；macOS / Linux 发 tar.gz，没有时退到 zip
  const tar = os === 'win' ? undefined : pick('.tar.gz')
  const zip = pick('.zip')
  const hit = assets.find((a) => a.name === (os === 'win' ? zip : (tar ?? zip)))
  return { url: hit?.browser_download_url ?? '', size: hit?.size ?? 0, zip: zip ?? '' }
}

/**
 * 强制更新：先记下被打断的任务再停 CLI，新版本启动后据此问用户要不要继续。
 * 记录失败也照常停：最多丢一次「接着跑」的提示，不能因为写文件失败就不更新
 */
export async function stopForUpdate(
  job: { phase: string },
  deps: {
    interrupted: () => InterruptedEntry[] | Promise<InterruptedEntry[]>
    stopAll: () => Promise<void>
  },
) {
  job.phase = t('正在停止正在执行的任务…')
  // 名单可能要从任务文件里读（见 tasksApi 的 interruptedTasks）：读不出来也照常停 CLI
  const list = await Promise.resolve(deps.interrupted()).catch(() => [] as InterruptedEntry[])
  await recordInterrupted(list).catch((e) => log.warn('update', '记录被打断的任务失败', e))
  await deps.stopAll()
}

/** 版本更新：对比 GitHub Releases 上的包，下载后替换当前目录里的程序文件并重启 */
export function updateApi(deps: {
  running: () => number
  restart: () => void
  /** 停掉所有正在执行的 CLI：用户点「强制更新」时用 */
  stopAll: () => Promise<void>
  /** 正在执行的任务和它正在做的节点：强制更新打断它们之前记下来 */
  interrupted: () => InterruptedEntry[] | Promise<InterruptedEntry[]>
}) {
  // 上次检查的结果存在缓存目录里，重启面板也记得，不会每次打开都去问 GitHub
  let cache: ReleasesCache | undefined = readCache()
  /**
   * 限流到什么时候、是哪次的状态码。独立于缓存：没有缓存可回退时也要记住，
   * 否则用户连点「检查更新」每次都真打到 GitHub，继续 403
   */
  let limited: { until: number; status: number } | undefined = cache?.limitedUntil
    ? { until: cache.limitedUntil, status: 403 }
    : undefined
  /** 记下检查结果；写不进去只影响下次要不要重新请求，不影响这次已经拿到的结果 */
  async function saveCache(next: ReleasesCache) {
    cache = next
    await mkdir(path.dirname(CACHE_FILE()), { recursive: true })
    await writeFile(CACHE_FILE(), JSON.stringify(next)).catch((e) => log.warn('update', '记录检查结果失败', e))
  }
  /** force：用户点了「强制更新」，停掉正在执行的任务后不再等 */
  const jobs = new Map<string, AppUpdateJob & { force?: boolean }>()
  /** 收下并检查过、等用户确认安装的本地安装包；work 是它的临时目录 */
  let staged: { id: string; work: string; pkg: LocalPackage } | undefined

  /**
   * 记一次进展。更新卡住时靠它判断：下载没动静、等任务结束等了很久，
   * 都会让 updatedAt 停住，超过 STALE_UPDATE_MS 就当这次更新已经死了
   */
  const touch = (job: AppUpdateJob) => {
    job.updatedAt = new Date().toISOString()
  }

  /** 还没结束的更新；按最近有进展的时间排序，新的在前 */
  const runningJobs = () =>
    [...jobs.values()]
      .filter((j) => j.status === 'running')
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

  const isStale = (job: AppUpdateJob & { force?: boolean }) =>
    Date.now() - Date.parse(job.updatedAt ?? '') > STALE_UPDATE_MS

  /**
   * 版本号大的在前，同号按发布时间：几个提交连着推时出包有快有慢，按发布时间排会把 0.28.997 排到 0.28.999 上面
   */
  const newestFirst = (a: AppRelease, b: AppRelease) =>
    compareVersions(b.version, a.version) || b.publishedAt.localeCompare(a.publishedAt)

  /**
   * 读 Release 的 Atom feed：API 被限流 / 不可用时用它判断有没有新版本。
   * 结果单独缓存 FEED_CACHE_MS，冷却期内连点「检查更新」不会反复请求；
   * feed 只是补充，不能动 API 列表的 at / etag
   */
  async function feedRelease(): Promise<FeedLatest | undefined> {
    const now = Date.now()
    if (cache?.feed && now - cache.feed.at < FEED_CACHE_MS) return cache.feed
    try {
      const res = await netFetch(FEED(), {
        headers: { Accept: 'application/atom+xml', 'User-Agent': 'agent-panel' },
        timeoutMs: 15_000,
      })
      if (!res.ok) {
        log.warn('update', `读取 Release feed 失败：${res.status}`)
        return cache?.feed
      }
      const release = parseFeed(await res.text())
      if (!release) {
        log.warn('update', 'Release feed 里没有可用的版本')
        return cache?.feed
      }
      const feed = { at: Date.now(), release }
      await saveCache({ ...(cache ?? { at: 0, list: [] }), feed })
      return feed
    } catch (e) {
      log.warn('update', '读取 Release feed 失败', e)
      return cache?.feed
    }
  }

  /** 把 feed 里的最新版本并进列表：缓存里已经有同一版本时沿用缓存（它带安装包地址） */
  const withFeed = (list: AppRelease[], release: AppRelease) =>
    list.some((r) => r.tag === release.tag) ? list : [...list, release].sort(newestFirst)

  async function releases(refresh: boolean): Promise<ReleasesResult> {
    const now = Date.now()
    // 自动检查最多每 6 小时一次；设置里打开「版本更新」或点「检查更新」时 refresh，马上检查
    if (!refresh && cache && now - cache.at < CHECK_EVERY) return { list: cache.list, source: 'api' }
    // GitHub 说过要等到什么时候：这期间点「检查更新」也不撞 API，退到 Release feed 判断有没有新版本
    if (limited && limited.until > now) {
      const feed = await feedRelease()
      if (feed) return { list: withFeed(cache?.list ?? [], feed.release), source: 'feed', feedAt: feed.at }
      if (cache?.list.length) return { list: cache.list, source: 'api' }
      throw rateLimited(limited.status, limited.until)
    }
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-panel' }
    // 带上上次的 ETag：列表没变化时 GitHub 回 304，conditional request 不计入配额
    if (cache?.etag) headers['If-None-Match'] = cache.etag
    // 有 token 就用认证请求：配额从 60 次/小时提到 5000 次/小时。只读环境变量，不落盘
    const token = process.env.GITHUB_TOKEN
    if (token) headers.Authorization = `Bearer ${token}`
    let res: Response
    try {
      // 用 netFetch 自己的超时：它超时后要能换代理重试，AbortSignal.timeout 一旦触发就再也发不出请求
      res = await netFetch(`${API()}?per_page=30`, { headers, timeoutMs: 15_000 })
    } catch (e) {
      // 连不上 GitHub（网络 / 代理都不通）也算 API 不可用，先看 feed 能不能判断新版本
      const feed = await feedRelease()
      if (feed) return { list: withFeed(cache?.list ?? [], feed.release), source: 'feed', feedAt: feed.at }
      throw e
    }
    if (res.status === 304 && cache) {
      // 没变化：沿用上次的列表，只把检查时间挪到现在（304 也算一次成功的检查）；
      // 请求成功说明限流已经过去，把冷却和缓存里的残留一起清掉
      limited = undefined
      await saveCache({ ...cache, at: Date.now(), limitedUntil: undefined })
      return { list: cache.list, source: 'api' }
    }
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        const until = rateLimitUntil(res)
        limited = { until, status: res.status }
        // 限流时先看 feed：能拿到最新版本就照常提示有没有更新，并记住恢复时间
        const feed = await feedRelease()
        if (feed) {
          await saveCache({ ...(cache ?? { at: 0, list: [] }), limitedUntil: until, feed })
          return { list: withFeed(cache?.list ?? [], feed.release), source: 'feed', feedAt: feed.at }
        }
        // feed 也读不到时，有上次的完整结果就先给用户看；冷却期内不再请求 GitHub
        if (cache?.list.length) {
          await saveCache({ ...cache, limitedUntil: until })
          return { list: cache.list, source: 'api' }
        }
        throw rateLimited(res.status, until)
      }
      // 其他错误（5xx 等）也先试 feed：能判断有没有新版本就不算检查失败
      const feed = await feedRelease()
      if (feed) return { list: withFeed(cache?.list ?? [], feed.release), source: 'feed', feedAt: feed.at }
      throw new Error(t('GitHub 返回 {status}', { status: res.status }))
    }
    const data = (await res.json()) as any[]
    const list = data
      .filter((r) => !r.draft)
      .map((r): AppRelease => {
        const assets = (r.assets ?? []) as { name: string; browser_download_url: string; size: number }[]
        const main = platformAsset(assets, process.platform)
        return {
          tag: r.tag_name,
          version: String(r.tag_name).replace(/^v/, ''),
          prerelease: !!r.prerelease,
          publishedAt: r.published_at ?? r.created_at ?? '',
          notes: r.body ?? '',
          url: r.html_url ?? '',
          tarUrl: main.url,
          zipUrl: assets.find((a) => a.name === main.zip)?.browser_download_url ?? '',
          sumsUrl: assets.find((a) => a.name === 'SHA256SUMS')?.browser_download_url ?? '',
          size: main.size,
        }
      })
      .filter((r) => r.tarUrl)
      .sort(newestFirst)
    limited = undefined
    await saveCache({ at: Date.now(), list, etag: res.headers.get('etag') ?? undefined })
    return { list, source: 'api' }
  }

  /**
   * 用 src 里已经解压好的程序文件替换当前的：在线更新和本地安装包共用。
   * 替换会换掉正在运行的程序，有任务在执行时先等它们结束（用户可以强制更新）；
   * 替换前把当前版本整个留一份，新版本装不好或加载不了就换回来，data/ 不动
   */
  async function replaceWith(job: AppUpdateJob & { force?: boolean }, src: string, onWait?: () => void) {
    const dir = appDir()
    let running = deps.running()
    if (running > 0) {
      onWait?.()
      job.waiting = true
      touch(job)
      while (running > 0) {
        // 用户点了「强制更新」：中断所有正在执行的 CLI，不再等它们自然结束
        if (job.force) {
          await stopForUpdate(job, deps)
          break
        }
        job.phase = t('等待任务结束（还有 {n} 个）', { n: running })
        // 等任务结束也算有进展：任务数在变、用户还在看着，这段时间不能算卡住
        touch(job)
        await new Promise((r) => setTimeout(r, 1000))
        running = deps.running()
      }
      job.waiting = false
    }

    // 先把当前版本整个留一份，再替换程序文件；中途出错或新版本加载不了就换回来
    job.phase = t('替换文件')
    await backup(dir, PREVIOUS())
    try {
      await apply(src, dir)
      job.phase = t('检查新版本')
      await selfCheck(dir)
    } catch (e) {
      log.error('update', '新版本没能装好，退回原来的版本', e)
      // 退回也失败时要说出来：程序文件可能是新旧混在一起的，不能当作已经退回
      const back = await apply(PREVIOUS(), dir).then(
        () => '',
        (b: Error) => b.message,
      )
      if (back)
        throw new Error(
          t('新版本没能装好：{error}。退回原来的版本也失败了：{back}。请关掉 Agent 面板后重新解压原来的包', {
            error: (e as Error).message,
            back,
          }),
        )
      throw new Error(t('新版本没能装好，已经退回原来的版本：{error}', { error: (e as Error).message }))
    }

    job.phase = t('正在重启')
    job.status = 'done'
    // 留时间让页面拿到「完成」，再重启
    setTimeout(() => deps.restart(), 800)
  }

  async function install(job: AppUpdateJob & { force?: boolean }, rel: AppRelease, onWait?: () => void) {
    // 下载的包放在数据目录的缓存里，设置的「数据」里能看到占用、可以清理
    await mkdir(path.join(CACHE_DIR, 'updates'), { recursive: true })
    const work = await mkdtemp(path.join(CACHE_DIR, 'updates', 'update-'))
    try {
      // 没有 SHA256SUMS 就不装：没法确认下载的包完整、没被改过，装上就是把来路不明的程序替换进来。
      // 以前对早期的包跳过校验，现在发布流程每次都带这个文件，缺了多半是发布出了问题，下载之前就停
      if (!rel.sumsUrl)
        throw new Error(
          t(
            '这个版本的发布里没有校验文件（SHA256SUMS），无法确认安装包完整、没被改过，已取消更新。可以到 GitHub Releases 手动下载',
          ),
        )
      // 1. 下载
      job.phase = t('下载中')
      job.total = rel.size
      touch(job)
      // 扩展名按实际下载的包来：Windows 是 zip，macOS / Linux 是 tar.gz
      const isZip = /\.zip$/i.test(new URL(rel.tarUrl).pathname)
      const file = path.join(work, isZip ? 'package.zip' : 'package.tar.gz')
      await downloadFile(rel.tarUrl, file, {
        headers: { 'User-Agent': 'agent-panel' },
        onTotal: (n) => {
          if (n) job.total = n
        },
        onBytes: (n) => {
          job.received += n
          touch(job)
        },
      })

      // 校验：和 Release 里的 SHA256SUMS 对一下，下载不完整或被改过就不装（没有这个文件的上面已经拒绝了）
      {
        job.phase = t('校验中')
        const sums = await netFetch(rel.sumsUrl, { headers: { 'User-Agent': 'agent-panel' }, timeoutMs: 15_000 })
        if (!sums.ok) throw new Error(t('下载校验文件失败：{status}', { status: sums.status }))
        const name = decodeURIComponent(new URL(rel.tarUrl).pathname.split('/').pop() ?? '')
        const want = (await sums.text())
          .split('\n')
          .map((l) => l.trim().split(/\s+\*?/))
          .find(([, n]) => n === name)?.[0]
        if (!want) throw new Error(t('校验文件里没有 {name}', { name }))
        if ((await sha256(file)).toLowerCase() !== want.toLowerCase())
          throw new Error(t('下载的包校验不通过，可能下载不完整，请重试'))
      }

      // 2. 解压：只解到临时目录，不动程序文件，任务执行中也可以做；包有问题时不用等任务结束就能报出来
      job.phase = t('解压中')
      const { src } = await extractPackage(file, path.join(work, 'stage'))
      await replaceWith(job, src, onWait)
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 开始装某个版本；不能装时返回原因和状态码。
   * busy 是还没结束的那次更新：让页面能显示它的进度和「强制更新」，不是只给一句提示。
   * 它已经超过 STALE_UPDATE_MS 没有进展时作废它，让这次能重新开始。
   */
  function startInstall(rel: AppRelease, onWait?: () => void) {
    return startJob(rel.tag, (job) => install(job, rel, onWait))
  }

  /** 还没结束、也没卡住的那次更新挡着时的报错；没有就是 undefined */
  function busyError(): { error: string; status: 409; busy: AppUpdateBusy } | undefined {
    const live = runningJobs()[0]
    if (live && !isStale(live))
      return {
        error: live.waiting
          ? t('新版本已经下载完，正在等任务结束（{phase}）；可以直接强制更新', { phase: live.phase })
          : t('正在更新到 {tag}（{phase}），请稍等', { tag: live.tag, phase: live.phase }),
        status: 409,
        busy: { job: live, stale: false },
      }
  }

  /** 开始一次更新：run 负责拿到程序文件并交给 replaceWith。在线更新和本地安装包共用 */
  function startJob(
    tag: string,
    run: (job: AppUpdateJob & { force?: boolean }) => Promise<void>,
  ): { job: AppUpdateJob; done: Promise<void> } | { error: string; status: 400 | 409; busy?: AppUpdateBusy } {
    if (!packaged()) return { error: t('从源码运行时请用 git 更新，只有发布的包能在这里更新'), status: 400 }
    const blocked = busyError()
    if (blocked) return blocked
    const live = runningJobs()[0]
    if (live) {
      // 卡住的更新：作废它，让这次重新开始。它自己的循环还在跑，但不会再挡住新的一次
      live.status = 'failed'
      live.error = t('超过 {n} 分钟没有进展，已作废，重新开始', { n: Math.round(STALE_UPDATE_MS / 60_000) })
      log.warn('update', `更新卡住了，作废后重新开始：${live.tag}`)
    }
    const job: AppUpdateJob = {
      id: randomUUID(),
      tag,
      status: 'running',
      phase: t('准备中'),
      received: 0,
      total: 0,
      updatedAt: new Date().toISOString(),
    }
    // 只有页面正在看的这一次有用，以前的记录丢掉
    for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id)
    jobs.set(job.id, job)
    log.info('update', `开始更新到 ${tag}`)
    const done = run(job).catch((e) => {
      log.error('update', `更新到 ${tag} 失败`, e)
      job.status = 'failed'
      job.error = (e as Error).message
      touch(job)
    })
    return { job, done }
  }

  /**
   * 托盘菜单的「检查更新」：马上问一次 GitHub，有新版本就直接下载安装（装好后重启），
   * 每一步用 report 告诉托盘，由它弹出通知。和设置页里的检查更新各走各的，不用打开页面
   */
  async function checkAndInstall(report: (state: TrayUpdateState, text: string) => void) {
    if (!packaged()) return report('failed', t('从源码运行时请用 git 更新，只有发布的包能在这里更新'))
    report('checking', t('正在检查更新…'))
    let list: AppRelease[]
    try {
      list = (await releases(true)).list
    } catch (e) {
      log.warn('update', '检查更新失败', e)
      return report('failed', t('检查更新失败：{error}', { error: (e as Error).message }))
    }
    const current = currentVersion()
    const rel = pickUpdate(current, list)
    if (!rel) return report('latest', t('已经是最新版本（{version}）', { version: current }))
    // 拿不到安装包地址的版本（例如定义改过、拼不出本平台的包）：能提醒用户有新版本，但不能在这里自动下载安装
    if (!rel.tarUrl)
      return report(
        'failed',
        t('发现新版本 {version}，但暂时拿不到 GitHub API 的安装包地址，请到 GitHub Releases 手动下载', {
          version: rel.version,
        }),
      )
    const started = startInstall(rel, () =>
      report('waiting', t('新版本 {version} 已下载，等所有任务结束后再替换并重启', { version: rel.version })),
    )
    if ('error' in started)
      return report(
        'busy',
        t('发现新版本 {version}，但现在不能更新：{error}', { version: rel.version, error: started.error }),
      )
    report('downloading', t('发现新版本 {version}，正在下载…', { version: rel.version }))
    await started.done
    if (started.job.status === 'done') report('done', t('已更新到 {version}，正在重启', { version: rel.version }))
    else report('failed', started.job.error ?? t('更新失败'))
  }

  const api = new Hono()
    .get('/version', (c) => c.json({ current: currentVersion(), packaged: packaged(), previous: previousVersion() }))
    .get('/releases', async (c) => {
      const current = currentVersion()
      const base: AppReleases = { current, packaged: packaged(), previous: previousVersion(), releases: [] }
      try {
        // cached=1：只回上次检查存下的列表，不访问 GitHub。关着自动检查时打开设置用它，
        // 列表不至于每次都是空的；从没检查过就回空列表，等用户点「检查更新」
        const result: ReleasesResult =
          c.req.query('cached') === '1'
            ? { list: cache?.list ?? [], source: 'api' }
            : await releases(c.req.query('refresh') === '1')
        // 冷却期还没过：这次显示的是上次的列表，页面据此把失败提示换成温和说明
        const limitedUntil = cache?.limitedUntil && cache.limitedUntil > Date.now() ? cache.limitedUntil : undefined
        return c.json({
          ...base,
          // 只有 feed 结果、还没有 API 缓存时 at 是 0，不能显示成 1970 年
          checkedAt: cache?.at ? new Date(cache.at).toISOString() : undefined,
          feedCheckedAt: result.feedAt ? new Date(result.feedAt).toISOString() : undefined,
          source: result.source,
          limitedUntil: limitedUntil ? new Date(limitedUntil).toISOString() : undefined,
          // 缓存里可能是旧版按发布时间排的列表，这里再按版本号排一次
          releases: [...result.list].sort(newestFirst).slice(0, RECENT_RELEASES),
          update: pickUpdate(current, result.list),
        } satisfies AppReleases)
      } catch (e) {
        log.warn('update', '检查更新失败', e)
        return c.json({
          ...base,
          error: t('检查更新失败：{error}', { error: (e as Error).message }),
        } satisfies AppReleases)
      }
    })
    .post('/install', async (c) => {
      const { tag } = (await c.req.json().catch(() => ({}))) as { tag?: string }
      if (!packaged()) return c.json({ error: t('从源码运行时请用 git 更新，只有发布的包能在这里更新') }, 400)
      let rel: AppRelease | undefined
      try {
        rel =
          (await releases(false)).list.find((r) => r.tag === tag) ??
          (await releases(true)).list.find((r) => r.tag === tag)
      } catch (e) {
        return c.json({ error: t('读取版本列表失败：{error}', { error: (e as Error).message }) }, 502)
      }
      if (!rel) return c.json({ error: t('找不到版本 {tag}', { tag: tag ?? '' }) }, 404)
      // 没有安装包地址时不能假装能装，让用户去 GitHub Releases 手动下载
      if (!rel.tarUrl) return c.json({ error: t('这个版本没有可用的安装包地址，请到 GitHub Releases 手动下载') }, 502)
      const started = startInstall(rel)
      if ('error' in started)
        return c.json({ error: started.error, ...(started.busy ? { busy: started.busy } : {}) }, started.status)
      return c.json(started.job, 201)
    })
    // 本地安装包（离线、连不上 GitHub 时用）：先收下、解压、检查格式和平台，告诉页面包里是哪个版本；
    // 用户确认后再走和在线更新一样的替换流程（有任务在执行时先等）。请求体就是安装包本身
    .post('/local-package', async (c) => {
      if (!packaged()) return c.json({ error: t('从源码运行时请用 git 更新，只有发布的包能在这里更新') }, 400)
      const blocked = busyError()
      if (blocked) return c.json({ error: blocked.error, busy: blocked.busy }, 409)
      // 一次只留一个待装的包：上次选了没装的、面板重启前留下的都清掉
      staged = undefined
      const updates = path.join(CACHE_DIR, 'updates')
      await mkdir(updates, { recursive: true })
      for (const n of await readdir(updates).catch(() => [] as string[]))
        if (n.startsWith('local-')) await dropStaged(path.join(updates, n))
      const work = await mkdtemp(path.join(updates, 'local-'))
      try {
        const file = path.join(work, 'package')
        await saveBody(c.req.raw.body, file)
        const pkg = await inspectPackage(file, path.join(work, 'stage'))
        // 解压好就只用解出来的文件，压缩包不用留着占空间
        await rm(file, { force: true })
        staged = { id: randomUUID(), work, pkg }
        log.info('update', `收到本地安装包 v${pkg.version}`)
        return c.json({ id: staged.id, version: pkg.version, os: pkg.os ?? '' } satisfies LocalPackageInfo)
      } catch (e) {
        await dropStaged(work)
        log.warn('update', '本地安装包不能用', e)
        return c.json({ error: (e as Error).message }, 400)
      }
    })
    .post('/local-package/:id/install', (c) => {
      const pkg = staged?.id === c.req.param('id') ? staged : undefined
      if (!pkg) return c.json({ error: t('这个安装包已经失效，请重新选择') }, 404)
      const started = startJob(`v${pkg.pkg.version}`, (job) =>
        replaceWith(job, pkg.pkg.src).finally(() => dropStaged(pkg.work)),
      )
      if ('error' in started)
        return c.json({ error: started.error, ...(started.busy ? { busy: started.busy } : {}) }, started.status)
      staged = undefined
      return c.json(started.job, 201)
    })
    // 选了包又不装：删掉解压出来的文件
    .delete('/local-package/:id', async (c) => {
      if (staged?.id === c.req.param('id')) {
        await dropStaged(staged.work)
        staged = undefined
      }
      return c.json({ ok: true })
    })
    // 回到上一个版本：和当前版本互换，换完还可以再换回来
    .post('/rollback', async (c) => {
      if (!packaged()) return c.json({ error: t('从源码运行时请用 git 切换版本') }, 400)
      const live = runningJobs()[0]
      if (live && !isStale(live))
        return c.json(
          {
            error: t('正在更新到 {tag}（{phase}），等它结束再退回', { tag: live.tag, phase: live.phase }),
            busy: { job: live, stale: false },
          },
          409,
        )
      if (deps.running() > 0) return c.json({ error: t('有任务正在执行，请等它完成或先停止再更新') }, 409)
      const version = previousVersion()
      if (!version || !existsSync(path.join(PREVIOUS(), 'dist'))) return c.json({ error: t('没有可以退回的版本') }, 404)
      const dir = appDir()
      const swap = path.join(CACHE_DIR, 'updates', 'rollback')
      try {
        await backup(dir, swap)
        await apply(PREVIOUS(), dir)
        await rm(PREVIOUS(), { recursive: true, force: true })
        await rename(swap, PREVIOUS())
      } catch (e) {
        await apply(swap, dir).catch(() => {})
        await rm(swap, { recursive: true, force: true }).catch(() => {})
        return c.json({ error: t('退回失败：{error}', { error: (e as Error).message }) }, 500)
      }
      setTimeout(() => deps.restart(), 800)
      return c.json({ version })
    })
    // 当前正在跑的那次更新：页面刷新后 job 丢了，靠它把进度条和「强制更新」接回来。
    // 必须放在 /install/:id 前面，否则会被当成 id 匹配
    .get('/install-current', (c) => {
      const live = runningJobs()[0]
      return c.json(live ? ({ job: live, stale: isStale(live) } satisfies AppUpdateBusy) : null)
    })
    .get('/install/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(j) : c.json({ error: t('找不到这次更新') }, 404)
    })
    // 下载完了但还有任务在执行：中断所有 CLI，马上替换并重启
    .post('/install/:id/force', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return c.json({ error: t('找不到这次更新') }, 404)
      if (j.status !== 'running') return c.json({ error: t('这次更新已经结束') }, 409)
      if (!j.waiting) return c.json({ error: t('还在下载，下载完才能强制更新') }, 409)
      j.force = true
      return c.json(j)
    })
  return { api, checkAndInstall }
}

/** 托盘「检查更新」每一步的状态：checking、downloading 之后还会有下文，其余是最终结果 */
export type TrayUpdateState = 'checking' | 'downloading' | 'waiting' | 'latest' | 'done' | 'busy' | 'failed'

/**
 * 重启：关掉监听，用同样的参数启动新的服务进程（共用当前的终端窗口），然后退出。
 * 新进程起来时端口可能还没释放，它会重试几次（见 index.ts）。
 */
/** 上次更新时挪开的旧托盘程序：托盘重新启动后就不再占用，可以删掉 */
export function cleanupOldTray(dir = appDir()) {
  // 包括换不了名时挪到的 AgentPanel.exe.old-时间；还在运行的那个删不掉，下次再试
  void readdir(dir)
    .then((names) =>
      Promise.all(
        names
          .filter((n) => n.startsWith(`${TRAY_EXE}.old`))
          .map((n) => rm(path.join(dir, n), { force: true }).catch(() => {})),
      ),
    )
    .catch(() => {})
  void rm(path.join(dir, 'dist.old'), { recursive: true, force: true }).catch(() => {})
}

export function restartProcess(close: () => void) {
  close()
  // 由托盘程序或系统服务（launchd / systemd，见 install-service.sh）启动时交给它们重启：
  // 退出码 75 表示要重启。自己再起一个进程的话，systemd 会在主进程退出时把它一起结束
  if (process.env.AGENT_PANEL_TRAY || process.env.AGENT_PANEL_SUPERVISED) {
    setTimeout(() => process.exit(TRAY_RESTART), 200)
    return
  }
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_PANEL_RESTARTED: '1' },
    stdio: 'inherit',
    // 面板起的进程一律不弹窗口（没有控制台时 Windows 会给新进程开一个）
    windowsHide: true,
  })
  child.on('spawn', () => setTimeout(() => process.exit(0), 200))
  child.on('error', (e) => console.error(`重启失败：${e.message}`))
}
