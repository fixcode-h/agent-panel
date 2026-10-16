import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO, pickUpdate, type AppRelease, type AppReleases, type AppUpdateJob } from '../shared/version.ts'
import { capture } from './exec/process.ts'

// 出包时由 esbuild 写入版本号；从源码运行时没有
declare const __APP_VERSION__: string | undefined
const BUILT = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

/** 包的根目录（server.mjs 所在目录）；测试时可以用环境变量指定 */
const appDir = () => process.env.AGENT_PANEL_APP_DIR ?? path.dirname(process.argv[1] ?? '.')
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
const FILES = ['server.mjs', 'package.json', 'start.sh', 'start.cmd', 'README.md', '使用说明.txt']

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
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}${res.status === 403 ? '（访问太频繁，稍后再试）' : ''}`)
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
    const work = await mkdtemp(path.join(tmpdir(), 'agent-panel-update-'))
    try {
      // 1. 下载
      job.phase = '下载中'
      const res = await fetch(rel.tarUrl, { headers: { 'User-Agent': 'agent-panel' } })
      if (!res.ok || !res.body) throw new Error(`下载失败：${res.status}`)
      job.total = Number(res.headers.get('content-length')) || rel.size
      const file = path.join(work, 'package.tar.gz')
      const out = createWriteStream(file)
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        job.received += chunk.length
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))

      // 2. 解压：Windows 10 起自带 tar，macOS / Linux 都有
      job.phase = '解压中'
      const stage = path.join(work, 'stage')
      await mkdir(stage)
      const r = await capture('tar', ['-xzf', file, '-C', stage], work, process.env, 120_000)
      if (r.spawnError || r.code !== 0) throw new Error(`解压失败：${r.spawnError ?? r.stderr.trim()}`)
      const [top] = await readdir(stage)
      const src = path.join(stage, top ?? '')
      if (!top || !existsSync(path.join(src, 'server.mjs')) || !existsSync(path.join(src, 'dist', 'index.html')))
        throw new Error('包里缺少 server.mjs 或 dist，可能下载不完整')

      // 3. 替换程序文件：先放好新的 dist 再换名，data/ 不动
      job.phase = '替换文件'
      const dist = path.join(dir, 'dist')
      const next = path.join(dir, 'dist.next')
      const old = path.join(dir, 'dist.old')
      await rm(next, { recursive: true, force: true })
      await rm(old, { recursive: true, force: true })
      await cp(path.join(src, 'dist'), next, { recursive: true })
      if (existsSync(dist)) await rename(dist, old)
      await rename(next, dist)
      for (const f of FILES) if (existsSync(path.join(src, f))) await cp(path.join(src, f), path.join(dir, f))
      if (existsSync(path.join(dir, 'start.sh'))) await chmod(path.join(dir, 'start.sh'), 0o755).catch(() => {})
      await rm(old, { recursive: true, force: true }).catch(() => {})

      job.phase = '正在重启'
      job.status = 'done'
      // 留时间让页面拿到「完成」，再重启
      setTimeout(() => deps.restart(), 800)
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }

  return new Hono()
    .get('/version', (c) => c.json({ current: currentVersion(), packaged: packaged() }))
    .get('/releases', async (c) => {
      const current = currentVersion()
      const base: AppReleases = { current, packaged: packaged(), releases: [] }
      try {
        const list = await releases(c.req.query('refresh') === '1')
        return c.json({ ...base, releases: list.slice(0, 5), update: pickUpdate(current, list) } satisfies AppReleases)
      } catch (e) {
        return c.json({ ...base, error: `检查更新失败：${(e as Error).message}` } satisfies AppReleases)
      }
    })
    .post('/install', async (c) => {
      const { tag } = (await c.req.json().catch(() => ({}))) as { tag?: string }
      if (!packaged()) return c.json({ error: '从源码运行时请用 git 更新，只有发布的包能在这里更新' }, 400)
      if ([...jobs.values()].some((j) => j.status === 'running')) return c.json({ error: '正在更新，请稍等' }, 409)
      if (deps.running() > 0) return c.json({ error: '有任务正在执行，请等它完成或先停止再更新' }, 409)
      let rel: AppRelease | undefined
      try {
        rel = (await releases(false)).find((r) => r.tag === tag) ?? (await releases(true)).find((r) => r.tag === tag)
      } catch (e) {
        return c.json({ error: `读取版本列表失败：${(e as Error).message}` }, 502)
      }
      if (!rel) return c.json({ error: `找不到版本 ${tag ?? ''}` }, 404)
      const job: AppUpdateJob = {
        id: randomUUID(),
        tag: rel.tag,
        status: 'running',
        phase: '准备中',
        received: 0,
        total: 0,
      }
      jobs.set(job.id, job)
      install(job, rel).catch((e) => {
        job.status = 'failed'
        job.error = (e as Error).message
      })
      return c.json(job, 201)
    })
    .get('/install/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(j) : c.json({ error: '找不到这次更新' }, 404)
    })
}

/**
 * 重启：关掉监听，用同样的参数启动新的服务进程（共用当前的终端窗口），然后退出。
 * 新进程起来时端口可能还没释放，它会重试几次（见 index.ts）。
 */
export function restartProcess(close: () => void) {
  close()
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_PANEL_RESTARTED: '1' },
    stdio: 'inherit',
  })
  child.on('spawn', () => setTimeout(() => process.exit(0), 200))
  child.on('error', (e) => console.error(`重启失败：${e.message}`))
}
