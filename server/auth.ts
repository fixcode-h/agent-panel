import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './store.ts'
import { getSettings } from './settings.ts'
import { isAllowedHost, isLocalHost } from './hosts.ts'
import { t } from '../shared/i18n.ts'

/**
 * 访问令牌（设置里可以打开）：Host / Origin 检查挡得住网页，挡不住本机的其他程序和同一台电脑上的其他用户，
 * 它们能直接调接口、用你的身份启动 CLI。打开后没带令牌的请求一律拒绝。
 * 令牌存在数据目录里，重启后不变，浏览器里的 Cookie 一直有效；不放进 config/，免得跟着「导出数据」带出去。
 */
const FILE = path.join(DATA_DIR, 'access-token')
const COOKIE = 'agent_panel_token'

let token = ''
export function accessToken() {
  if (token) return token
  try {
    token = readFileSync(FILE, 'utf8').trim()
  } catch {}
  if (!/^[0-9a-f]{32,}$/.test(token)) {
    token = randomBytes(24).toString('hex')
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(FILE, token, { mode: 0o600 })
  }
  return token
}

/** 启动时打印和自动打开的地址带上令牌，浏览器第一次打开时换成 Cookie */
export const withToken = (url: string) => `${url}/?token=${accessToken()}`

/** 给这个浏览器发 Cookie：用带令牌的地址打开，或者在设置里打开令牌时 */
export const grantCookie = (c: Parameters<MiddlewareHandler>[0]) =>
  setCookie(c, COOKIE, accessToken(), {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    // 浏览器规定 Cookie 最长 400 天；每次用带令牌的地址打开都会续上
    maxAge: 60 * 60 * 24 * 400,
  })

/**
 * 经过反向代理转发来的请求带的头。Host 可以被代理改成 127.0.0.1（nginx 默认 `proxy_set_header Host $proxy_host`），
 * 只看 Host 会把外网请求当成本机、免令牌放行；带了这些头的一律按外网处理
 */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
]
export const viaProxy = (header: (name: string) => string | undefined) => PROXY_HEADERS.some((h) => !!header(h))

export const tokenGuard: MiddlewareHandler = async (c, next) => {
  const host = c.req.header('host') ?? ''
  const local = isLocalHost(host) && !viaProxy((h) => c.req.header(h))
  // 外网访问关着的时候只认本机地址；开着时也只认当前隧道 / 反代地址
  if (!local && !isAllowedHost(host)) return c.text(t('这个地址不能访问面板'), 403)
  const q = c.req.query('token')
  // 带令牌的地址：发 Cookie，再跳到去掉令牌的地址，免得令牌留在地址栏和历史记录里
  if (q && q === accessToken() && c.req.method === 'GET' && !c.req.path.startsWith('/api/')) {
    grantCookie(c)
    const url = new URL(c.req.url)
    url.searchParams.delete('token')
    return c.redirect(url.pathname + url.search, 302)
  }
  // 外网来源一律要求令牌：本机访问可以按设置决定，外部不行。
  // 外网访问开着时本机也要：自建反代不加转发头、又把 Host 改成 127.0.0.1 时，外网请求和本机请求分不出来
  const settings = await getSettings()
  const requireToken = settings.requireToken || settings.remoteAccess.enabled || !local
  if (!requireToken || getCookie(c, COOKIE) === accessToken()) return next()
  // AI 改设计用的工具由 CLI 调，没有 Cookie；地址里的随机令牌只在那一轮设计里有效，由接口自己核对
  if (c.req.path.startsWith('/api/mcp/design/')) return next()
  // 面板工具（提问、派子任务、新建子对话）同理：CLI 拿着这一轮的随机地址来调，没有 Cookie，
  // 拦下来 CLI 就一个面板工具都没有了；地址不对的由接口自己回 404
  if (c.req.path.startsWith('/api/mcp/ask/')) return next()
  // Blender 建模工具同理：地址里是这一轮的随机令牌，接口自己核对（以前漏了，开令牌后 Blender 工具一律 401）
  if (c.req.path.startsWith('/api/mcp/blender/')) return next()
  // 联网搜索同理：地址里是本轮 CLI 的随机令牌，由接口自己核对；令牌不对时回 404
  if (c.req.path.startsWith('/api/web-search/')) return next()
  // 浏览器扩展拿不到面板的 Cookie：它带的是配对令牌（index.ts 里再核对来源、本机和令牌）
  if (c.req.path.startsWith('/api/bridge/') && /^(chrome|moz)-extension:\/\//.test(c.req.header('origin') ?? ''))
    return next()
  if (c.req.path.startsWith('/api/')) return c.json({ error: t('需要访问令牌：请用启动时显示的地址打开面板') }, 401)
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Agent</title><body style="font:15px system-ui;padding:48px;max-width:560px;margin:auto;line-height:1.7"><h3>${t('需要访问令牌')}</h3><p>${t('这个面板打开了访问令牌。Windows 上右键托盘图标选「打开面板」；其他系统请打开终端里显示的带 token 的地址。')}</p></body>`,
    401,
  )
}
