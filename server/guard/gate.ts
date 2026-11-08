/**
 * 外网登录门：从外网专用端口进来的请求，没有登录会话一律挡在业务接口之外。
 *
 * 做法参考 dsh-web-guard（https://github.com/lvxianchao/dsh-web-guard，MIT，Copyright (c) 2026 lvxianchao）：
 * 一个访问密码 + 可吊销的会话 Cookie，门在服务端，不是前端遮罩。和它不同的是我们不用再转发一次：
 * 外网端口和本机端口是同一个进程里的同一个应用，请求带着 EXTERNAL_ENV 标记直接进来，这里按标记拦。
 */
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Hono } from 'hono'
import { z } from 'zod'
import { t } from '../../shared/i18n.ts'
import { isExternalRequest, originAllowed, trustsForwarded } from '../hosts.ts'
import { getSettings } from '../settings.ts'
import { log } from '../log.ts'
import { loginPage, logoutPage } from './pages.ts'
import { MIN_PASSWORD } from './password.ts'
import { checkPassword, hasPassword, initialPassword, sessions, setPassword, syncLimits } from './state.ts'

export const SESSION_COOKIE = 'agent_panel_session'

/** 本机或局域网地址：只有从这些地址连进来时才信转发头（Caddy / NPM 和面板在同一台机器或同一个内网） */
const TRUSTED_PEER =
  /^(127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.|f[cd])/i

const peerOf = (c: Context) =>
  ((c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ??
    '') as string

/**
 * 这个请求的转发头能不能信：要同时满足「外网端口前面是自建反代（custom 方式）」和「连接来自本机 / 内网」。
 * frp 方式下 frpc 在本机连进来，对端也是 127.0.0.1，只看对端地址的话外网访问者随手写一个 X-Forwarded-For
 * 就能每次换一个「IP」，按来源的输错锁定形同虚设
 */
const forwardTrusted = (c: Context) => trustsForwarded(c.env) && TRUSTED_PEER.test(peerOf(c))

/**
 * 访问者的地址：经过自建反代时取 X-Forwarded-For 的**最后一个**（离面板最近的那层反代写的）。
 * 第一个是访问者自己能写的：nginx 的 $proxy_add_x_forwarded_for 是在访问者带来的值后面追加，取第一个照样能伪造。
 * 没有 X-Forwarded-For 时才看 X-Real-IP（nginx 示例配置写的是 $remote_addr）；不认 CF-Connecting-IP（已经不支持 Cloudflare 隧道，
 * 经过 Caddy 时访问者自己带的这个头会被原样转发）
 */
export function clientIp(c: Context) {
  const peer = peerOf(c)
  if (forwardTrusted(c)) {
    const hops = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    const fwd = hops.at(-1) ?? c.req.header('x-real-ip')?.trim()
    if (fwd) return fwd
  }
  return peer || 'unknown'
}

/** 浏览器看到的是不是 https：直接监听开了证书，或者反代告诉我们它对外是 https */
const isHttps = (c: Context) =>
  new URL(c.req.url).protocol === 'https:' ||
  (forwardTrusted(c) && c.req.header('x-forwarded-proto')?.split(',').at(-1)?.trim() === 'https')

/**
 * 写操作的来源检查：Origin 的主机名要等于请求的 Host、反代转来的 X-Forwarded-Host 或设置里的访问地址。
 * 只比主机名不比端口：反代常把对外端口去掉。防跨站的主力是 SameSite=Lax
 */
export function sameSite(origin: string | undefined, c: Context, publicUrl: string) {
  if (origin === undefined) return true
  try {
    const from = new URL(origin).hostname.toLowerCase()
    const names = [c.req.header('host'), c.req.header('x-forwarded-host')?.split(',')[0], publicUrl]
      .filter(Boolean)
      .map((h) => {
        const s = String(h).trim().toLowerCase()
        try {
          return new URL(/^https?:\/\//.test(s) ? s : `http://${s}`).hostname
        } catch {
          return ''
        }
      })
    return names.includes(from)
  } catch {
    return false
  }
}

/** /api 写操作的 Origin 检查：主端口只认本机页面，外网专用端口按 sameSite */
export async function originOk(origin: string, c: Context) {
  if (!isExternalRequest(c.env)) return originAllowed(origin)
  return sameSite(origin, c, (await getSettings()).remoteAccess.publicUrl)
}

const tokenOf = (c: Context) => getCookie(c, SESSION_COOKIE)

/** 这个请求带的会话还有效吗 */
export const sessionOf = (c: Context) => sessions.resolve(tokenOf(c))

/** next 只认站内路径：不能借登录页跳到别的网站 */
const safeNext = (s: string | null | undefined) => (s && s.startsWith('/') && !s.startsWith('//') ? s : '/')

async function grant(c: Context, ip: string) {
  const days = (await getSettings()).remoteAccess.sessionDays
  setCookie(c, SESSION_COOKIE, sessions.issue(ip, c.req.header('user-agent') ?? ''), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps(c),
    ...(days > 0 ? { maxAge: Math.floor(days * 86400) } : {}),
  })
}

async function login(c: Context) {
  const ip = clientIp(c)
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
  const next = safeNext(String(form.next ?? '/'))
  await syncLimits()
  if (sessions.isLocked(ip)) return c.html(loginPage({ next, locked: true }), 429)
  if (!sameSite(c.req.header('origin'), c, (await getSettings()).remoteAccess.publicUrl))
    return c.html(loginPage({ next, error: t('登录请求的来源和访问地址对不上') }), 403)
  if (!hasPassword() || !checkPassword(String(form.password ?? ''))) {
    const left = sessions.recordFailure(ip)
    log.warn('guard', '外网登录密码错误', { ip, left })
    return c.html(
      loginPage({ next, ...(left > 0 ? { error: t('密码不对') } : { locked: true }) }),
      left > 0 ? 401 : 429,
    )
  }
  sessions.clearFailures(ip)
  await grant(c, ip)
  log.info('guard', '外网登录成功', { ip })
  return c.redirect(next, 302)
}

/**
 * 外网请求的门，由 tokenGuard 在请求来自外网专用端口时调用。
 * 登录页、退出、会话探测不用登录；其他没有会话的：接口回 401（带 login，页面据此跳登录页），网页跳登录页
 */
export const externalGate: MiddlewareHandler = async (c, next) => {
  const path = c.req.path
  if (path === '/login') {
    if (c.req.method === 'POST') return login(c)
    if (sessionOf(c)) return c.redirect('/', 302)
    return c.html(loginPage({ next: safeNext(c.req.query('next')) }))
  }
  if (path === '/logout') {
    sessions.revoke(tokenOf(c))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.html(logoutPage())
  }
  if (path === '/api/remote/guard/session') return sessionOf(c) ? c.json({ ok: true }) : c.json({ ok: false }, 401)
  if (sessionOf(c)) return next()
  if (path.startsWith('/api/')) return c.json({ error: t('登录已失效，请重新登录'), login: '/login' }, 401)
  const u = new URL(c.req.url)
  return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`, 302)
}

const PasswordBody = z.object({
  current: z.string().max(500).default(''),
  next: z.string().max(500),
})

/** 设置页「登录与会话」用的接口：本机打开时可以直接改密码，外网要先验证当前密码 */
export function guardApi() {
  const routes = new Hono()
  routes.get('/state', async (c) => {
    await syncLimits()
    const external = isExternalRequest(c.env)
    return c.json({
      hasPassword: hasPassword(),
      // 初始密码只给本机看：外网登进来的人已经知道密码了，没必要再在网络上传一遍
      initialPassword: external ? '' : initialPassword(),
      external,
      current: sessions.idOf(tokenOf(c)),
      sessions: sessions.list(),
    })
  })
  routes.post('/password', async (c) => {
    const p = PasswordBody.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return c.json({ error: t('请求格式不对') }, 400)
    const external = isExternalRequest(c.env)
    if (external && !checkPassword(p.data.current)) return c.json({ error: t('当前密码不对') }, 400)
    if (p.data.next.length < MIN_PASSWORD)
      return c.json({ error: t('密码至少 {n} 位', { n: String(MIN_PASSWORD) }) }, 400)
    await setPassword(p.data.next)
    // 改了密码，别的设备都要重新登录；改的人自己（外网时）不用
    sessions.revokeAll(external ? tokenOf(c) : undefined)
    log.info('guard', '外网访问密码已修改', { external })
    return c.json({ ok: true })
  })
  routes.delete('/sessions/:id', (c) =>
    sessions.removeById(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: t('这个会话已经不在了') }, 404),
  )
  routes.post('/logout-all', (c) => {
    sessions.revokeAll()
    if (isExternalRequest(c.env)) deleteCookie(c, SESSION_COOKIE, { path: '/' })
    log.info('guard', '已退出所有外网设备')
    return c.json({ ok: true })
  })
  return routes
}
