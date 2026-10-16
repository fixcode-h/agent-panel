import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './store.ts'
import { getSettings } from './settings.ts'
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

export const tokenGuard: MiddlewareHandler = async (c, next) => {
  const q = c.req.query('token')
  // 带令牌的地址：发 Cookie，再跳到去掉令牌的地址，免得令牌留在地址栏和历史记录里
  if (q && q === accessToken() && c.req.method === 'GET' && !c.req.path.startsWith('/api/')) {
    grantCookie(c)
    const url = new URL(c.req.url)
    url.searchParams.delete('token')
    return c.redirect(url.pathname + url.search, 302)
  }
  if (!(await getSettings()).requireToken || getCookie(c, COOKIE) === accessToken()) return next()
  if (c.req.path.startsWith('/api/')) return c.json({ error: t('需要访问令牌：请用启动时显示的地址打开面板') }, 401)
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Agent</title><body style="font:15px system-ui;padding:48px;max-width:560px;margin:auto;line-height:1.7"><h3>${t('需要访问令牌')}</h3><p>${t('这个面板打开了访问令牌。Windows 上右键托盘图标选「打开面板」；其他系统请打开终端里显示的带 token 的地址。')}</p></body>`,
    401,
  )
}
