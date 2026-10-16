import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CACHE_DIR } from './store.ts'
import { REPO, pickUpdate, type AppRelease, type AppReleases, type AppUpdateJob } from '../shared/version.ts'
import { capture } from './exec/process.ts'
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

function currentVersion() {
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
const FILES = ['server.mjs', 'package.json', 'start.sh', 'README.md', '使用说明.txt']
/** 托盘程序约定的「请重启我」退出码，和 scripts/tray/AgentPanel.cs 里的 RestartCode 一致 */
export const TRAY_RESTART = 75
/** Windows 托盘启动程序：正在运行时不能覆盖，但可以改名，所以先挪开再放新的 */
const TRAY_EXE = 'AgentPanel.exe'
/** 更新前把当前版本整个留在这里：新版本起不来时自动退回，设置里也可以手动回到上一个版本 */
const PREVIOUS = () => path.join(CACHE_DIR, 'updates', 'previous')
const VERSION_FILE = 'version.txt'

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

/** 用 src 里的程序文件替换 dir 里的：先放好新的 dist 再换名，data/ 不动 */
async function apply(src: string, dir: string) {
  const dist = path.join(dir, 'dist')
  const next = path.join(dir, 'dist.next')
  const old = path.join(dir, 'dist.old')
  await rm(next, { recursive: true, force: true })
  await rm(old, { recursive: true, force: true })
  await cp(path.join(src, 'dist'), next, { recursive: true })
  if (existsSync(dist)) await rename(dist, old)
  await rename(next, dist)
  for (const f of FILES) if (existsSync(path.join(src, f))) await cp(path.join(src, f), path.join(dir, f))
  if (existsSync(path.join(src, TRAY_EXE))) {
    const exe = path.join(dir, TRAY_EXE)
    const moved = `${exe}.old`
    await rm(moved, { force: true }).catch(() => {})
    if (existsSync(exe)) await rename(exe, moved)
    await cp(path.join(src, TRAY_EXE), exe)
  }
  // 换成托盘程序后不再需要命令行启动文件
  if (existsSync(path.join(dir, TRAY_EXE))) await rm(path.join(dir, 'start.cmd'), { force: true }).catch(() => {})
  if (existsSync(path.join(dir, 'start.sh'))) await chmod(path.join(dir, 'start.sh'), 0o755).catch(() => {})
  await rm(old, { recursive: true, force: true }).catch(() => {})
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

/** 版本更新：对比 GitHub Releases 上的包，下载后替换当前目录里的程序文件并重启 */
export function updateApi(deps: { running: () => number; restart: () => void }) {
  let cache: { at: number; list: AppRelease[] } | undefined
  const jobs = new Map<string, AppUpdateJob>()

  async function releases(refresh: boolean): Promise<AppRelease[]> {
    // GitHub 匿名访问每小时 60 次，缓存 10 分钟
    if (!refresh && cache && Date.now() - cache.at < 600_000) return cache.list
    const res = await fetch(`${API()}?per_page=30`, {
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
        const asset = (ext: string) => (r.assets ?? []).find((a: any) => String(a.name).endsWith(ext))
        return {
          tag: r.tag_name,
          version: String(r.tag_name).replace(/^v/, ''),
          prerelease: !!r.prerelease,
          publishedAt: r.published_at ?? r.created_at ?? '',
          notes: r.body ?? '',
          url: r.html_url ?? '',
          tarUrl: asset('.tar.gz')?.browser_download_url ?? '',
          zipUrl: asset('.zip')?.browser_download_url ?? '',
          sumsUrl: asset('SHA256SUMS')?.browser_download_url ?? '',
          size: asset('.tar.gz')?.size ?? 0,
        }
      })
      .filter((r) => r.tarUrl)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    cache = { at: Date.now(), list }
    return list
  }

  async function install(job: AppUpdateJob, rel: AppRelease) {
    const dir = appDir()
    // 下载的包放在数据目录的缓存里，设置的「数据」里能看到占用、可以清理
    await mkdir(path.join(CACHE_DIR, 'updates'), { recursive: true })
    const work = await mkdtemp(path.join(CACHE_DIR, 'updates', 'update-'))
    try {
      // 1. 下载
      job.phase = t('下载中')
      const res = await fetch(rel.tarUrl, { headers: { 'User-Agent': 'agent-panel' } })
      if (!res.ok || !res.body) throw new Error(t('下载失败：{status}', { status: res.status }))
      job.total = Number(res.headers.get('content-length')) || rel.size
      const file = path.join(work, 'package.tar.gz')
      const out = createWriteStream(file)
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        job.received += chunk.length
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))

      // 校验：和 Release 里的 SHA256SUMS 对一下，下载不完整或被改过就不装。早期的包没有这个文件，跳过
      if (rel.sumsUrl) {
        job.phase = t('校验中')
        const sums = await fetch(rel.sumsUrl, { headers: { 'User-Agent': 'agent-panel' } })
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

      // 2. 解压：Windows 10 起自带 tar，macOS / Linux 都有
      job.phase = t('解压中')
      const stage = path.join(work, 'stage')
      await mkdir(stage)
      const r = await capture('tar', ['-xzf', file, '-C', stage], work, process.env, 120_000)
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
        await apply(PREVIOUS(), dir).catch(() => {})
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

  return (
    new Hono()
      .get('/version', (c) => c.json({ current: currentVersion(), packaged: packaged(), previous: previousVersion() }))
      .get('/releases', async (c) => {
        const current = currentVersion()
        const base: AppReleases = { current, packaged: packaged(), previous: previousVersion(), releases: [] }
        try {
          const list = await releases(c.req.query('refresh') === '1')
          return c.json({
            ...base,
            releases: list.slice(0, 5),
            update: pickUpdate(current, list),
          } satisfies AppReleases)
        } catch (e) {
          return c.json({
            ...base,
            error: t('检查更新失败：{error}', { error: (e as Error).message }),
          } satisfies AppReleases)
        }
      })
      .post('/install', async (c) => {
        const { tag } = (await c.req.json().catch(() => ({}))) as { tag?: string }
        if (!packaged()) return c.json({ error: t('从源码运行时请用 git 更新，只有发布的包能在这里更新') }, 400)
        if ([...jobs.values()].some((j) => j.status === 'running')) return c.json({ error: t('正在更新，请稍等') }, 409)
        if (deps.running() > 0) return c.json({ error: t('有任务正在执行，请等它完成或先停止再更新') }, 409)
        let rel: AppRelease | undefined
        try {
          rel = (await releases(false)).find((r) => r.tag === tag) ?? (await releases(true)).find((r) => r.tag === tag)
        } catch (e) {
          return c.json({ error: t('读取版本列表失败：{error}', { error: (e as Error).message }) }, 502)
        }
        if (!rel) return c.json({ error: t('找不到版本 {tag}', { tag: tag ?? '' }) }, 404)
        const job: AppUpdateJob = {
          id: randomUUID(),
          tag: rel.tag,
          status: 'running',
          phase: t('准备中'),
          received: 0,
          total: 0,
        }
        // 只有页面正在看的这一次有用，以前的记录丢掉
        for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id)
        jobs.set(job.id, job)
        install(job, rel).catch((e) => {
          job.status = 'failed'
          job.error = (e as Error).message
        })
        return c.json(job, 201)
      })
      // 回到上一个版本：和当前版本互换，换完还可以再换回来
      .post('/rollback', async (c) => {
        if (!packaged()) return c.json({ error: t('从源码运行时请用 git 切换版本') }, 400)
        if ([...jobs.values()].some((j) => j.status === 'running')) return c.json({ error: t('正在更新，请稍等') }, 409)
        if (deps.running() > 0) return c.json({ error: t('有任务正在执行，请等它完成或先停止再更新') }, 409)
        const version = previousVersion()
        if (!version || !existsSync(path.join(PREVIOUS(), 'dist')))
          return c.json({ error: t('没有可以退回的版本') }, 404)
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
      .get('/install/:id', (c) => {
        const j = jobs.get(c.req.param('id'))
        return j ? c.json(j) : c.json({ error: t('找不到这次更新') }, 404)
      })
  )
}

/**
 * 重启：关掉监听，用同样的参数启动新的服务进程（共用当前的终端窗口），然后退出。
 * 新进程起来时端口可能还没释放，它会重试几次（见 index.ts）。
 */
/** 上次更新时挪开的旧托盘程序：托盘重新启动后就不再占用，可以删掉 */
export function cleanupOldTray(dir = appDir()) {
  void rm(path.join(dir, `${TRAY_EXE}.old`), { force: true }).catch(() => {})
}

export function restartProcess(close: () => void) {
  close()
  // 由托盘程序启动时交给它重启：退出码 75 表示要重启，托盘会用同样的方式再启动一次
  if (process.env.AGENT_PANEL_TRAY) {
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
