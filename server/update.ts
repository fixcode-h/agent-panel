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
  pickUpdate,
  type AppRelease,
  type AppReleases,
  type AppUpdateBusy,
  type AppUpdateJob,
} from '../shared/version.ts'
import { capture } from './exec/process.ts'
import { recordInterrupted } from './interrupted.ts'
import { netFetch } from './net.ts'
import { downloadFile } from './download.ts'
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

function readCache(): { at: number; list: AppRelease[] } | undefined {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE(), 'utf8'))
    return typeof c?.at === 'number' && Array.isArray(c.list) ? c : undefined
  } catch {
    return undefined
  }
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
  deps: { interrupted: () => { id: string; doing: string }[]; stopAll: () => Promise<void> },
) {
  job.phase = t('正在停止正在执行的任务…')
  await recordInterrupted(deps.interrupted()).catch((e) => log.warn('update', '记录被打断的任务失败', e))
  await deps.stopAll()
}

/** 版本更新：对比 GitHub Releases 上的包，下载后替换当前目录里的程序文件并重启 */
export function updateApi(deps: {
  running: () => number
  restart: () => void
  /** 停掉所有正在执行的 CLI：用户点「强制更新」时用 */
  stopAll: () => Promise<void>
  /** 正在执行的任务和它正在做的节点：强制更新打断它们之前记下来 */
  interrupted: () => { id: string; doing: string }[]
}) {
  // 上次检查的结果存在缓存目录里，重启面板也记得，不会每次打开都去问 GitHub
  let cache: { at: number; list: AppRelease[] } | undefined = readCache()
  /** force：用户点了「强制更新」，停掉正在执行的任务后不再等 */
  const jobs = new Map<string, AppUpdateJob & { force?: boolean }>()

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

  async function releases(refresh: boolean): Promise<AppRelease[]> {
    // 自动检查最多每 6 小时一次；设置里打开「版本更新」或点「检查更新」时 refresh，马上检查
    if (!refresh && cache && Date.now() - cache.at < CHECK_EVERY) return cache.list
    const res = await netFetch(`${API()}?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-panel' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok)
      throw new Error(
        res.status === 403
          ? t('GitHub 返回 {status}（访问太频繁，稍后再试）', { status: res.status })
          : t('GitHub 返回 {status}', { status: res.status }),
      )
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
    cache = { at: Date.now(), list }
    await mkdir(path.dirname(CACHE_FILE()), { recursive: true })
    await writeFile(CACHE_FILE(), JSON.stringify(cache)).catch((e) => log.warn('update', '记录检查结果失败', e))
    return list
  }

  async function install(job: AppUpdateJob & { force?: boolean }, rel: AppRelease, onWait?: () => void) {
    const dir = appDir()
    // 下载的包放在数据目录的缓存里，设置的「数据」里能看到占用、可以清理
    await mkdir(path.join(CACHE_DIR, 'updates'), { recursive: true })
    const work = await mkdtemp(path.join(CACHE_DIR, 'updates', 'update-'))
    try {
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

      // 校验：和 Release 里的 SHA256SUMS 对一下，下载不完整或被改过就不装。早期的包没有这个文件，跳过
      if (rel.sumsUrl) {
        job.phase = t('校验中')
        const sums = await netFetch(rel.sumsUrl, { headers: { 'User-Agent': 'agent-panel' } })
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

      // 下载和校验都不动程序文件，任务执行中也可以继续；
      // 解压和替换会换掉正在运行的程序，等所有任务结束再做
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

      // 2. 解压：Windows 10 起自带 tar，也能解 zip（bsdtar）；macOS / Linux 都有 tar
      job.phase = t('解压中')
      const stage = path.join(work, 'stage')
      await mkdir(stage)
      const r = await capture('tar', ['-xf', file, '-C', stage], work, process.env, 120_000)
      if (r.spawnError || r.code !== 0)
        throw new Error(t('解压失败：{error}', { error: r.spawnError ?? r.stderr.trim() }))
      const [top] = await readdir(stage)
      const src = path.join(stage, top ?? '')
      if (!top || !existsSync(path.join(src, 'server.mjs')) || !existsSync(path.join(src, 'dist', 'index.html')))
        throw new Error(t('包里缺少 server.mjs 或 dist，可能下载不完整'))

      // 3. 先把当前版本整个留一份，再替换程序文件；中途出错或新版本加载不了就换回来
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
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 开始装某个版本；不能装时返回原因和状态码。
   * busy 是还没结束的那次更新：让页面能显示它的进度和「强制更新」，不是只给一句提示。
   * 它已经超过 STALE_UPDATE_MS 没有进展时作废它，让这次能重新开始。
   */
  function startInstall(
    rel: AppRelease,
    onWait?: () => void,
  ): { job: AppUpdateJob; done: Promise<void> } | { error: string; status: 400 | 409; busy?: AppUpdateBusy } {
    if (!packaged()) return { error: t('从源码运行时请用 git 更新，只有发布的包能在这里更新'), status: 400 }
    const live = runningJobs()[0]
    if (live && !isStale(live))
      return {
        error: live.waiting
          ? t('新版本已经下载完，正在等任务结束（{phase}）；可以直接强制更新', { phase: live.phase })
          : t('正在更新到 {tag}（{phase}），请稍等', { tag: live.tag, phase: live.phase }),
        status: 409,
        busy: { job: live, stale: false },
      }
    if (live) {
      // 卡住的更新：作废它，让这次重新开始。它自己的循环还在跑，但不会再挡住新的一次
      live.status = 'failed'
      live.error = t('超过 {n} 分钟没有进展，已作废，重新开始', { n: Math.round(STALE_UPDATE_MS / 60_000) })
      log.warn('update', `更新卡住了，作废后重新开始：${live.tag}`)
    }
    const job: AppUpdateJob = {
      id: randomUUID(),
      tag: rel.tag,
      status: 'running',
      phase: t('准备中'),
      received: 0,
      total: 0,
      updatedAt: new Date().toISOString(),
    }
    // 只有页面正在看的这一次有用，以前的记录丢掉
    for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id)
    jobs.set(job.id, job)
    log.info('update', `开始更新到 ${rel.tag}`)
    const done = install(job, rel, onWait).catch((e) => {
      log.error('update', `更新到 ${rel.tag} 失败`, e)
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
      list = await releases(true)
    } catch (e) {
      log.warn('update', '检查更新失败', e)
      return report('failed', t('检查更新失败：{error}', { error: (e as Error).message }))
    }
    const current = currentVersion()
    const rel = pickUpdate(current, list)
    if (!rel) return report('latest', t('已经是最新版本（{version}）', { version: current }))
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
        const list = await releases(c.req.query('refresh') === '1')
        return c.json({
          ...base,
          checkedAt: cache ? new Date(cache.at).toISOString() : undefined,
          // 缓存里可能是旧版按发布时间排的列表，这里再按版本号排一次
          releases: [...list].sort(newestFirst).slice(0, 5),
          update: pickUpdate(current, list),
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
        rel = (await releases(false)).find((r) => r.tag === tag) ?? (await releases(true)).find((r) => r.tag === tag)
      } catch (e) {
        return c.json({ error: t('读取版本列表失败：{error}', { error: (e as Error).message }) }, 502)
      }
      if (!rel) return c.json({ error: t('找不到版本 {tag}', { tag: tag ?? '' }) }, 404)
      const started = startInstall(rel)
      if ('error' in started)
        return c.json({ error: started.error, ...(started.busy ? { busy: started.busy } : {}) }, started.status)
      return c.json(started.job, 201)
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
  })
  child.on('spawn', () => setTimeout(() => process.exit(0), 200))
  child.on('error', (e) => console.error(`重启失败：${e.message}`))
}
