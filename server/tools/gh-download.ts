/**
 * 小工具「GitHub 加速下载」：用户贴一个 GitHub 地址，按选的来源（自动 = 设置里的下载来源顺序）下载到本机目录。
 *
 * 下载复用面板更新包那一套（server/update/fetch-package.ts）：每个来源单独计时，一段时间没收到数据就换下一个，
 * 分片并发、断点续传；正在用哪个来源、放弃过哪些都写在任务上。进度经页面事件流推给页面（PageSignal gh-download），
 * 不让页面轮询。下载记录只在内存里，重启面板就清空（文件还在磁盘上）。
 */
import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { t } from '../../shared/i18n.ts'
import { toolsContract as C } from '../../shared/api-contract/tools.ts'
import {
  downloadCandidates,
  normalizeGithubInput,
  pickCandidates,
  type GhDownloadJob,
} from '../../shared/tools/gh-download.ts'
import { fetchPackage } from '../update/fetch-package.ts'
import { netFetchDirect } from '../net.ts'
import { getSettings } from '../settings.ts'
import { signalPages } from '../page-events.ts'
import { revealItem } from '../open.ts'
import { removeDownload } from '../download.ts'

/** 记录最多留几条：多了把最早结束的挤掉 */
const KEEP = 50
/** 下载中推送进度的间隔：每收到一块就推会把事件流塞满 */
const PUSH_MS = 400

const jobs = new Map<string, GhDownloadJob>() // 模块状态：会话，下载记录跟着进程，重启清空
const aborts = new Map<string, AbortController>() // 模块状态：会话，正在下载的任务的取消开关
let pushTimer: NodeJS.Timeout | undefined // 模块状态：会话，节流推送的定时器

export const defaultDownloadDir = () => path.join(os.homedir(), 'Downloads')

const list = () => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)

/** 推给打开着的页面：状态变化马上推，进度按间隔合并 */
function push(now = false) {
  if (now) {
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = undefined
    signalPages({ type: 'gh-download', jobs: list() })
    return
  }
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = undefined
    signalPages({ type: 'gh-download', jobs: list() })
  }, PUSH_MS)
  pushTimer.unref?.()
}

/** 目录里已经有同名文件（或别的任务正要写它）时加序号：a.zip → a (1).zip */
export function freePath(dir: string, name: string, taken: (p: string) => boolean) {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 0; ; i++) {
    const p = path.join(dir, i ? `${base} (${i})${ext}` : name)
    if (!taken(p)) return p
  }
}

/** 超过上限时从最早的、已经结束的开始删 */
function trim() {
  const ended = list()
    .filter((j) => j.status !== 'running')
    .reverse()
  while (jobs.size > KEEP && ended.length) jobs.delete(ended.shift()!.id)
}

async function run(job: GhDownloadJob, sources: ReturnType<typeof pickCandidates>, ac: AbortController) {
  try {
    await mkdir(path.dirname(job.path), { recursive: true })
    const used = await fetchPackage(
      sources.map((s) => ({ label: s.label, url: s.url, headers: s.headers })),
      job.path,
      job.url,
      {
        // 每个来源只带代理回退，不再走 netFetch 的多来源兜底：来源由这里管，卡住时才知道该换谁
        fetch: (url, init) => netFetchDirect(url, { ...init, signal: anySignal(init?.signal, ac.signal) }),
        onSource: (label) => {
          job.source = label
          job.received = 0
          push(true)
        },
        onFail: (label, error) => {
          if (ac.signal.aborted) return
          job.attempts = [...(job.attempts ?? []), { source: label, error }]
          push(true)
        },
        onBytes: (n) => {
          job.received += n
          push()
        },
        onTotal: (n) => {
          job.total = n
        },
        failText: (all) =>
          t(
            '下载失败，试过的来源都不行：{list}。可以换一个来源，或在「设置 · 网络与代理 · GitHub 下载来源」里加镜像前缀。',
            {
              list: all,
            },
          ),
      },
    )
    job.source = used
    job.status = 'done'
    if (job.total) job.received = job.total
  } catch (e) {
    if (ac.signal.aborted) {
      job.status = 'cancelled'
      await removeDownload(job.path).catch(() => {})
    } else {
      job.status = 'failed'
      job.error = (e as Error).message || String(e)
    }
  } finally {
    job.endedAt = Date.now()
    aborts.delete(job.id)
    push(true)
  }
}

/** 两个取消信号合成一个：调用方自己的（换来源时的卡住计时）和用户点的「取消」 */
function anySignal(a: AbortSignal | null | undefined, b: AbortSignal) {
  return a ? AbortSignal.any([a, b]) : b
}

export function ghDownloadApi() {
  const app = new Hono()
  app.get(C.ghDownloads.path, async (c) =>
    c.json({
      jobs: list(),
      defaultDir: defaultDownloadDir(),
      sources: (await getSettings().catch(() => undefined))?.githubSources ?? [],
    }),
  )
  app.post(C.ghDownloadStart.path, async (c) => {
    const body = C.ghDownloadStart.body.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: t('下载参数不对') }, 400)
    const norm = normalizeGithubInput(body.data.url)
    if ('error' in norm) return c.json({ error: norm.error }, 400)
    const dir = body.data.dir?.trim() || defaultDownloadDir()
    if (!path.isAbsolute(dir)) return c.json({ error: t('保存目录要写完整路径') }, 400)
    const settings = await getSettings().catch(() => undefined)
    const tries = pickCandidates(downloadCandidates(norm.url, settings?.githubSources ?? []), body.data.source)
    if (!tries.length)
      return c.json({ error: t('没有可用的下载来源：选的来源不适用这个地址，或设置里的来源都关了') }, 400)
    const running = new Set([...jobs.values()].filter((j) => j.status === 'running').map((j) => j.path))
    const job: GhDownloadJob = {
      id: randomUUID(),
      input: body.data.url.trim(),
      url: norm.url,
      name: norm.name,
      pick: body.data.source,
      status: 'running',
      received: 0,
      path: freePath(dir, norm.name, (p) => running.has(p) || existsSync(p)),
      startedAt: Date.now(),
    }
    jobs.set(job.id, job)
    trim()
    const ac = new AbortController()
    aborts.set(job.id, ac)
    void run(job, tries, ac)
    push(true)
    return c.json(job)
  })
  app.post(C.ghDownloadCancel.path, (c) => {
    const job = jobs.get(c.req.param('id'))
    if (!job) return c.json({ error: t('找不到这条下载记录') }, 404)
    aborts.get(job.id)?.abort()
    return c.json(job)
  })
  app.post(C.ghDownloadReveal.path, async (c) => {
    const job = jobs.get(c.req.param('id'))
    if (!job || job.status !== 'done') return c.json({ error: t('文件还没下载好') }, 400)
    if (!existsSync(job.path)) return c.json({ error: t('文件已经不在了：{path}', { path: job.path }) }, 404)
    try {
      await revealItem(job.path)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500)
    }
  })
  app.delete(C.ghDownloadRemove.path, (c) => {
    const id = c.req.param('id')
    aborts.get(id)?.abort()
    jobs.delete(id)
    push(true)
    return c.json({ ok: true })
  })
  return app
}
