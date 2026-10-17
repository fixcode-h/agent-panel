import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { BrowserTab } from '../shared/design.ts'
import { t } from '../shared/i18n.ts'
import { appDir } from './update.ts'
import { log } from './log.ts'

/**
 * 浏览器扩展（extension/ 目录）和面板之间的桥：用户在自己日常用的浏览器里登录好 Gemini 或 ChatGPT，
 * 装上扩展后，扩展把这两个网站的标签页报上来，面板把「生成图片」的指令交给它，扩展在那个标签页里输入描述、
 * 等图出来、把图片取回来发给面板。
 *
 * 为什么不用调试端口（CDP）：普通打开的浏览器不开调试端口，新版 Chrome 也不允许对日常用的配置开，
 * 那样就得另开一个浏览器重新登录。扩展能直接用已经登录好的窗口。
 *
 * 扩展的后台用长轮询取指令（GET /poll 最多等 25 秒），结果用 POST /result 交回。
 */

interface Command {
  id: string
  type: 'generate'
  tabId: string
  prompt: string
  count: number
  /** 抠掉纯绿底（网页版做不出透明背景时） */
  chroma: boolean
}
interface Pending {
  cmd: Command
  resolve: (imgs: Buffer[]) => void
  reject: (e: Error) => void
  onProgress?: (text: string) => void
  /** 扩展取走指令的时间；取走后一直没有回音就重新排队（扩展的后台可能被浏览器休眠了） */
  taken?: number
  acked?: boolean
}

const ONLINE_MS = 45_000
const tabs = new Map<string, BrowserTab>()
let lastSeen = 0
let extVersion = ''
const queue: Pending[] = []
const pending = new Map<string, Pending>()
const waiters = new Set<(p: Pending | null) => void>()

/** 只认这两个网站，其他标签页扩展不会报，这里再挡一次 */
export const siteOf = (url: string): BrowserTab['site'] | undefined => {
  try {
    const h = new URL(url).hostname
    if (h === 'gemini.google.com') return 'gemini'
    if (h === 'chatgpt.com' || h === 'chat.openai.com') return 'chatgpt'
  } catch {}
  return undefined
}

export function browserStatus() {
  const online = Date.now() - lastSeen < ONLINE_MS
  return {
    connected: online,
    version: extVersion,
    tabs: online ? [...tabs.values()] : [],
    /** 扩展所在的目录，在浏览器的扩展页面「加载已解压的扩展程序」选它 */
    extensionDir: extensionDir(),
  }
}

export function extensionDir() {
  const dir = path.join(appDir(), 'extension')
  return existsSync(dir) ? dir : ''
}

function dispatch() {
  while (queue.length && waiters.size) {
    const p = queue.shift()!
    const w = waiters.values().next().value!
    waiters.delete(w)
    p.taken = Date.now()
    w(p)
  }
}

// 取走了却一直没有确认的指令重新排队；超过 3 分钟没结果的算失败（扩展的超时是 5 分钟，确认后另算）
setInterval(() => {
  const now = Date.now()
  for (const p of pending.values()) {
    if (p.taken && !p.acked && now - p.taken > 15_000) {
      p.taken = undefined
      queue.unshift(p)
    }
  }
  dispatch()
}, 5000).unref()

/** 在浏览器标签页里生成图片；返回取回的图片（PNG） */
export function browserGenerate(
  o: { tabId: string; prompt: string; count: number; chroma: boolean; onProgress?: (text: string) => void },
  signal?: AbortSignal,
): Promise<Buffer[]> {
  if (Date.now() - lastSeen > ONLINE_MS)
    return Promise.reject(new Error(t('浏览器扩展没有连上：请确认浏览器开着，并装好了 Agent 面板扩展')))
  if (!tabs.has(o.tabId))
    return Promise.reject(new Error(t('选的标签页已经关掉了，请重新选一个 Gemini 或 ChatGPT 标签页')))
  return new Promise((resolve, reject) => {
    const cmd: Command = {
      id: randomUUID(),
      type: 'generate',
      tabId: o.tabId,
      prompt: o.prompt,
      count: o.count,
      chroma: o.chroma,
    }
    const p: Pending = { cmd, resolve, reject, onProgress: o.onProgress }
    const done = () => {
      pending.delete(cmd.id)
      const i = queue.indexOf(p)
      if (i >= 0) queue.splice(i, 1)
      clearTimeout(timer)
    }
    p.resolve = (imgs) => (done(), resolve(imgs))
    p.reject = (e) => (done(), reject(e))
    // 网页生成图片一般一两分钟，多张时更久
    const timer = setTimeout(
      () => p.reject(new Error(t('浏览器里等了太久还没生成完，已放弃'))),
      (4 + o.count * 2) * 60_000,
    )
    signal?.addEventListener('abort', () => p.reject(new Error(t('已停止'))), { once: true })
    pending.set(cmd.id, p)
    queue.push(p)
    dispatch()
  })
}

export function bridgeApi() {
  return (
    new Hono()
      // 扩展每隔几秒报一次标签页
      .post('/hello', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { tabs?: any[]; version?: string }
        lastSeen = Date.now()
        extVersion = String(body.version ?? '')
        tabs.clear()
        for (const x of body.tabs ?? []) {
          const site = siteOf(String(x?.url ?? ''))
          if (!site || x?.id === undefined) continue
          const id = String(x.id)
          tabs.set(id, { id, site, title: String(x.title ?? '').slice(0, 200), url: String(x.url) })
        }
        return c.json({ ok: true })
      })
      .get('/poll', async (c) => {
        lastSeen = Date.now()
        const p = await new Promise<Pending | null>((resolve) => {
          const w = (x: Pending | null) => {
            clearTimeout(timer)
            resolve(x)
          }
          const timer = setTimeout(() => {
            waiters.delete(w)
            resolve(null)
          }, 25_000)
          waiters.add(w)
          dispatch()
        })
        lastSeen = Date.now()
        return c.json(p ? { cmd: p.cmd } : {})
      })
      .post('/progress', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { id?: string; text?: string }
        const p = pending.get(String(body.id))
        if (p) {
          p.acked = true
          if (body.text) p.onProgress?.(String(body.text).slice(0, 300))
        }
        return c.json({ ok: !!p })
      })
      .post('/result', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as {
          id?: string
          ok?: boolean
          error?: string
          images?: { data?: string }[]
        }
        const p = pending.get(String(body.id))
        if (!p) return c.json({ ok: false })
        if (!body.ok) {
          log.warn('bridge', '浏览器生成图片失败', { error: body.error })
          p.reject(new Error(String(body.error || t('浏览器里生成失败'))))
        } else {
          const imgs = (body.images ?? [])
            .map((i) => String(i.data ?? '').replace(/^data:[^,]*,/, ''))
            .filter(Boolean)
            .map((b64) => Buffer.from(b64, 'base64'))
          if (!imgs.length) p.reject(new Error(t('浏览器里没有取到图片')))
          else p.resolve(imgs)
        }
        return c.json({ ok: true })
      })
  )
}
