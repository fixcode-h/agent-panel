import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserTab } from '../shared/design.ts'
import { t } from '../shared/i18n.ts'
import { appDir } from './update.ts'
import { log } from './log.ts'
import { DATA_DIR } from './store.ts'

// 出包时由 esbuild 把 extension/ 里的文件（base64）写进来：从旧版本「版本更新」过来时，
// 旧的更新程序不知道要复制 extension 目录，包里的扩展会缺失，这时从这里写出来
declare const __EXTENSION_FILES__: Record<string, string> | undefined
const EMBEDDED = typeof __EXTENSION_FILES__ === 'object' ? __EXTENSION_FILES__ : undefined

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
  /** 每张图开一个新对话。1.1 的扩展会为此新开标签页，所以只发给 1.2 起的扩展（在选中的标签页里开对话） */
  newChat: boolean
  /** 一个标签页里最多开几个对话；之后的图排队，轮流用这几个对话生成（1.4 起的扩展） */
  concurrency: number
}
interface Pending {
  cmd: Command
  resolve: (imgs: Buffer[]) => void
  reject: (e: Error) => void
  onProgress?: (text: string) => void
  /** 扩展每取到一张图就先交一张（新版扩展） */
  onImage?: (img: Buffer) => void
  /** 已经单独交过的张数 */
  streamed: number
  /** 扩展取走指令的时间；取走后一直没有回音就重新排队（扩展的后台可能被浏览器休眠了） */
  taken?: number
  acked?: boolean
}

const ONLINE_MS = 45_000
const tabs = new Map<string, BrowserTab>()
let lastSeen = 0
let extVersion = ''
/** 用户在面板里点了「刷新扩展」：下次扩展报到时让它重新加载 */
let reloadAsked = false
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
    /** 面板自带的扩展版本，和 version 不一样时提示在扩展页面刷新 */
    latestVersion: bundledExtensionVersion(),
    browsers: installedBrowsers(),
  }
}

const manifestVersion = (json: string) => {
  try {
    return String(JSON.parse(json).version ?? '')
  } catch {
    return ''
  }
}
/** 面板自带的扩展版本；浏览器里装的版本比它旧时提示刷新扩展 */
export function bundledExtensionVersion() {
  if (EMBEDDED?.['manifest.json']) return manifestVersion(Buffer.from(EMBEDDED['manifest.json'], 'base64').toString())
  const f = path.join(appDir(), 'extension', 'manifest.json')
  return existsSync(f) ? manifestVersion(readFileSync(f, 'utf8')) : ''
}

/**
 * 扩展所在的目录。包里带的文件缺失或版本不对时，用打进 server.mjs 的文件重新写出来：
 * 优先写到程序目录，写不进去（装在只读位置）就写到数据目录
 */
/**
 * 扩展和面板之间的配对令牌。以前 /bridge 只看请求的 Origin 是不是 chrome-extension://，
 * Origin 谁都能伪造：开着外网隧道时公网任何人、本机其它扩展都能取生图指令、往设计里塞图。
 * 令牌存在数据目录里（只给本人读写），面板每次写出扩展文件时一起写进扩展目录的 pairing.json：
 * 只有从这个目录加载的扩展读得到，别的扩展读不到其它扩展的文件
 */
const TOKEN_FILE = path.join(DATA_DIR, 'bridge-token')
let token = ''
export function bridgeToken() {
  if (token) return token
  try {
    token = readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {}
  if (!token) {
    token = randomUUID()
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
    } catch (e) {
      log.warn('bridge', '写配对令牌失败，这次运行期间有效', { error: (e as Error).message })
    }
  }
  return token
}
export const PAIRING_HEADER = 'x-panel-bridge'
/** 请求带的配对令牌对不对 */
export const bridgePaired = (header: string | undefined) => !!header && header === bridgeToken()

function writePairing(dir: string) {
  if (!dir) return dir
  const f = path.join(dir, 'pairing.json')
  const body = JSON.stringify({ token: bridgeToken() })
  try {
    if (!existsSync(f) || readFileSync(f, 'utf8') !== body) writeFileSync(f, body, { mode: 0o600 })
  } catch (e) {
    log.warn('bridge', '写扩展配对文件失败：扩展会连不上面板', { dir, error: (e as Error).message })
  }
  return dir
}

export function extensionDir() {
  return writePairing(findExtensionDir())
}

function findExtensionDir() {
  const dir = path.join(appDir(), 'extension')
  if (!EMBEDDED) return existsSync(dir) ? dir : ''
  const want = bundledExtensionVersion()
  for (const d of [dir, path.join(DATA_DIR, 'extension')]) {
    const f = path.join(d, 'manifest.json')
    if (existsSync(f) && manifestVersion(readFileSync(f, 'utf8')) === want) return d
    try {
      mkdirSync(d, { recursive: true })
      for (const [name, b64] of Object.entries(EMBEDDED)) writeFileSync(path.join(d, name), Buffer.from(b64, 'base64'))
      return d
    } catch (e) {
      log.warn('bridge', '写出浏览器扩展失败', { dir: d, error: (e as Error).message })
    }
  }
  return ''
}

type BrowserId = 'chrome' | 'edge'
const BROWSERS: { id: BrowserId; name: string; page: string; win: string[]; mac: string; linux: string[] }[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    page: 'chrome://extensions/',
    win: ['Google\\Chrome\\Application\\chrome.exe'],
    mac: '/Applications/Google Chrome.app',
    linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  },
  {
    id: 'edge',
    name: 'Edge',
    page: 'edge://extensions/',
    win: ['Microsoft\\Edge\\Application\\msedge.exe'],
    mac: '/Applications/Microsoft Edge.app',
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
  },
]

/** 找浏览器的可执行文件；找不到返回空 */
function browserExe(b: (typeof BROWSERS)[number]) {
  if (process.platform === 'win32') {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
    for (const base of bases)
      for (const rel of b.win) if (existsSync(path.join(base!, rel))) return path.join(base!, rel)
    return ''
  }
  if (process.platform === 'darwin') return existsSync(b.mac) ? b.mac : ''
  for (const dir of (process.env.PATH ?? '').split(':'))
    for (const name of b.linux) if (dir && existsSync(path.join(dir, name))) return path.join(dir, name)
  return ''
}

/** 本机装了的 Chrome / Edge */
export const installedBrowsers = () => BROWSERS.filter((b) => browserExe(b)).map((b) => ({ id: b.id, name: b.name }))

/**
 * 安装扩展：网页打不开 chrome://extensions，也不能替用户装未上架的扩展，
 * 所以由服务端用浏览器打开扩展页面（已经开着的浏览器会新开一个标签页），用户再点「加载已解压的扩展程序」
 */
export function openExtensionsPage(id: string) {
  const b = BROWSERS.find((x) => x.id === id)
  const exe = b && browserExe(b)
  if (!b || !exe) throw new Error(t('没有找到这个浏览器'))
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-a', exe, b.page]] : [exe, [b.page]]
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
  child.on('error', (e) => log.warn('bridge', '打开扩展页面失败', { error: e.message }))
  child.unref()
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

/**
 * 扩展能不能每张图开一个新对话、同时生成好几张。1.1 的扩展是每张图新开一个标签页，
 * 用户没刷新扩展时会弹出一排标签页，所以 1.2 之前的都只在选中的标签页里一张张来
 */
export function browserParallel() {
  const [major, minor] = extVersion.split('.').map(Number)
  return major > 1 || (major === 1 && minor >= 2)
}

/** 让扩展重新加载（1.3 起的扩展支持）。扩展每隔几秒报到一次，报到时带上这个要求 */
export function askExtensionReload() {
  reloadAsked = true
}

/** 在浏览器标签页里生成图片：每取到一张就交给 onImage，返回最后才交来的图片（旧版扩展一次全交） */
export function browserGenerate(
  o: {
    tabId: string
    prompt: string
    count: number
    chroma: boolean
    concurrency?: number
    onProgress?: (text: string) => void
    onImage?: (img: Buffer) => void
  },
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
      newChat: browserParallel(),
      concurrency: Math.max(1, Math.min(10, o.concurrency ?? 3)),
    }
    const p: Pending = { cmd, resolve, reject, onProgress: o.onProgress, onImage: o.onImage, streamed: 0 }
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
        // 告诉扩展面板自带的版本：浏览器不会自己重新加载已解压的扩展，1.3 起的扩展看到更新的版本会自己重新加载。
        // 先调 extensionDir()，确保磁盘上的扩展文件已经是这个版本
        extensionDir()
        const reload = reloadAsked
        reloadAsked = false
        return c.json({ ok: true, latestVersion: bundledExtensionVersion(), reload })
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
      .post('/image', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { id?: string; data?: string }
        const p = pending.get(String(body.id))
        const b64 = String(body.data ?? '').replace(/^data:[^,]*,/, '')
        if (!p || !b64) return c.json({ ok: false })
        p.acked = true
        p.streamed++
        p.onImage?.(Buffer.from(b64, 'base64'))
        return c.json({ ok: true })
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
          if (!imgs.length && !p.streamed) p.reject(new Error(t('浏览器里没有取到图片')))
          else p.resolve(imgs)
        }
        return c.json({ ok: true })
      })
  )
}
