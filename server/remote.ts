import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import path from 'node:path'
import { networkInterfaces, userInfo } from 'node:os'
import { connect } from 'node:net'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { z } from 'zod'
import type { RemoteAccess } from '../shared/schema.ts'
import type { FrpDeployStatus, RemoteAccessStatus, RemoteState } from '../shared/remote.ts'
import { t } from '../shared/i18n.ts'
import { getSettings, saveSettings } from './settings.ts'
import { EXTERNAL_ENV, FORWARDED_ENV } from './hosts.ts'
import {
  FRPC_CONFIG,
  deployFrps,
  ensureFrpc,
  frpcConfig,
  frpcEvent,
  frpcLine,
  frpcProxyOf,
  newFrpToken,
  FRP_BIN_DIR,
  type FrpcEvent,
} from './frp.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { guardApi } from './guard/gate.ts'
import { ensurePassword, hasPassword, sessions, syncLimits } from './guard/state.ts'
import { frpTest } from './frp-test.ts'
import { tailscaleInfo, tailscaleStart, tailscaleStop, tailscaleUrl } from './tailscale.ts'
import type { TailscaleInfo } from '../shared/remote.ts'

/**
 * 外部访问：开着时另起一个外网专用端口，从这个端口进来的请求一律要密码登录（guard/gate.ts，参考 dsh-web-guard）。
 * 外网连过来的路：frp（一键配置的云服务器，本机没有公网 IP 时用），或用户自己的反向代理（Caddy、
 * Nginx Proxy Manager、nginx）/ 直接监听局域网和公网。以前的 Cloudflare 隧道已经去掉
 */

type FetchHandler = (req: Request, env?: unknown) => Response | Promise<Response>
let handler: FetchHandler | undefined
/** 外网专用端口：开着外网访问时才监听，见 shared/schema.ts 的 RemoteAccess.localPort */
let external: { server: Server; port: number; https: boolean } | null = null
let deploy: FrpDeployStatus | null = null
/** 端口映射的状态（按映射 id），frpc 重启时清空 */
let mappingStates: Record<string, { ok: boolean; error: string }> = {}
let state: RemoteState = 'off'
let url = ''
let error = ''
let child: ChildProcess | null = null
// 正常退出时 shutdown 会等 stopRemote；进程意外退出时这里兜底结束隧道
process.on('exit', () => {
  try {
    child?.kill('SIGKILL')
  } catch {}
})
let output = ''
/** 面板开着的 tailscale serve / funnel：关外部访问、换方式时按它关掉 */
let tsActive: { bin: string; cfg: RemoteAccess['tailscale'] } | null = null
let tsCache: { key: string; at: number; data: TailscaleInfo } | null = null
let download: { running: boolean; percent: number; error: string } | null = null

/** 交给外网专用端口的请求处理函数（和主端口同一个，见 server/index.ts） */
export function configureRemote(fetch: FetchHandler) {
  handler = fetch
}

/** 直接监听时的 HTTPS：证书和私钥都填了才启用，读不了直接报错（不悄悄退回明文） */
async function tlsOptions(s: RemoteAccess) {
  if (s.mode !== 'custom' || (!s.tlsCert && !s.tlsKey)) return null
  if (!s.tlsCert || !s.tlsKey) throw new Error(t('HTTPS 证书和私钥要一起填'))
  const read = (file: string) =>
    readFile(file).catch((e: Error) => {
      throw new Error(t('读不了文件 {file}：{msg}', { file, msg: e.message }))
    })
  return { cert: await read(s.tlsCert), key: await read(s.tlsKey) }
}

/**
 * 起外网专用端口：请求在 env 上打 EXTERNAL_ENV 标记，tokenGuard 据此交给登录门。
 * frp 只监听 127.0.0.1（frpc 在本机），端口被占用就换系统分配的；自建反代按设置监听，端口是写死在反代里的，被占用直接报错
 */
async function startExternal(s: RemoteAccess): Promise<number> {
  const fetch = handler
  if (!fetch) throw new Error(t('面板服务还没启动'))
  const custom = s.mode === 'custom'
  const hostname = custom ? s.listenHost : '127.0.0.1'
  const tls = await tlsOptions(s)
  const listen = (p: number) =>
    new Promise<NonNullable<typeof external>>((resolve, reject) => {
      const server = serve(
        {
          fetch: (req: Request, env: Record<string, unknown>) =>
            fetch(req, { ...env, [EXTERNAL_ENV]: true, [FORWARDED_ENV]: custom }),
          port: p,
          hostname,
          ...(tls ? { createServer: createHttpsServer as never, serverOptions: tls } : {}),
        },
        (info) => resolve({ server: server as Server, port: info.port, https: !!tls }),
      ) as Server
      server.once('error', reject)
    })
  const x = await listen(s.localPort).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE' || custom) {
      throw new Error(
        e.code === 'EADDRINUSE'
          ? t('外网专用端口 {port} 已被占用，请在设置里换一个', { port: String(s.localPort) })
          : e.message,
      )
    }
    return listen(0)
  })
  external = x
  log.info('remote', '外网专用端口已监听', { host: hostname, port: x.port, https: x.https })
  return x.port
}

function stopExternal() {
  const x = external
  external = null
  if (!x) return Promise.resolve()
  return new Promise<void>((resolve) => {
    x.server.close(() => resolve())
    // SSE 这类长连接不主动断开时 close 会一直等
    ;(x.server as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
    setTimeout(resolve, 2000).unref()
  })
}

/** 外部地址补上协议，去掉路径；不合法时返回空 */
export function normalizePublicUrl(value: string): string {
  const s = value.trim()
  if (!s) return ''
  // 写了别的协议（ftp://、file://）不是网页地址；没写协议时按 https 补
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return ''
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return ''
    return u.origin
  } catch {
    return ''
  }
}

export function hostOfUrl(value: string): string {
  const u = normalizePublicUrl(value)
  return u ? new URL(u).hostname.toLowerCase() : ''
}

const lastLines = (text: string) => text.trim().split('\n').slice(-4).join('\n').slice(-800)

/** 停掉正在运行的隧道，等它退出（最多 3 秒） */
async function stopChild() {
  const cp = child
  child = null
  if (!cp || cp.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        cp.kill('SIGKILL')
      } catch {}
      resolve()
    }, 3000)
    cp.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      cp.kill()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

function fail(message: string) {
  state = 'error'
  error = message
  log.warn('remote', '外部访问不可用', { error: message })
}

/** 本机的局域网 IPv4：直接监听时拼访问地址，反代跑在 Docker 里时当转发目标 */
export function lanIps(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => !!n && n.family === 'IPv4' && !n.internal)
    .map((n) => n!.address)
}

async function start(s: RemoteAccess) {
  // 第一次打开外部访问：生成初始密码，设置页显示给用户
  await ensurePassword()
  const ext = await startExternal(s)
  if (s.mode === 'frp') return startFrpc(s, ext)
  if (s.mode === 'tailscale') return startTailscale(s, ext)
  // 自建反代：填了访问地址就用它，没填按监听地址拼一个（直连局域网时能直接打开）
  const scheme = external?.https ? 'https' : 'http'
  const lan = s.listenHost === '0.0.0.0' ? lanIps()[0] : ''
  url = normalizePublicUrl(s.publicUrl) || `${scheme}://${lan || '127.0.0.1'}:${ext}`
  state = 'running'
  error = ''
  log.info('remote', '外部访问已启用（自建反向代理）', { url })
}

/** 检测 tailscale；设置页每 2 秒刷新状态，结果缓存 15 秒，点「重新检测」时强制重测 */
async function probeTailscale(s: RemoteAccess, force = false) {
  const key = s.tailscale.command
  if (!force && tsCache?.key === key && Date.now() - tsCache.at < 15_000) return tsCache.data
  const data = await tailscaleInfo(key)
  tsCache = { key, at: Date.now(), data }
  return data
}

/** Tailscale 方式：tailscale serve / funnel 把 https://<机器名>.ts.net 转到外网专用端口 */
async function startTailscale(s: RemoteAccess, ext: number) {
  const info = await probeTailscale(s, true)
  if (!info.installed || !info.running) return fail(info.error)
  await tailscaleStart(info.path, s.tailscale, ext)
  tsActive = { bin: info.path, cfg: s.tailscale }
  url = tailscaleUrl(info.dnsName, s.tailscale.httpsPort)
  state = 'running'
  error = ''
  log.info('remote', '外部访问已启用（Tailscale）', { url, funnel: s.tailscale.funnel })
}

async function stopTailscale() {
  const x = tsActive
  tsActive = null
  if (x) await tailscaleStop(x.bin, x.cfg)
}

/** 跑 frpc：把云服务器上的 remotePort 转到外网专用端口 */
async function startFrpc(s: RemoteAccess, ext: number) {
  const f = s.frp
  if (!f.server || !f.token) return fail(t('还没配置云服务器：填好服务器信息后点「一键配置」'))
  // 在云服务器上配了反向代理和域名时用域名，没有就是 IP:面板端口
  url =
    normalizePublicUrl(s.publicUrl) || `http://${f.server.includes(':') ? `[${f.server}]` : f.server}:${f.remotePort}`
  state = 'starting'
  error = ''
  output = ''
  let bin: string
  try {
    download = { running: true, percent: -1, error: '' }
    bin = await ensureFrpc((n) => {
      if (download) download.percent = n
    })
    download = null
  } catch (e) {
    download = { running: false, percent: -1, error: (e as Error).message }
    return fail(t('下载 frpc 失败：{msg}', { msg: (e as Error).message }))
  }
  await mkdir(path.dirname(FRPC_CONFIG), { recursive: true })
  await writeFile(FRPC_CONFIG, frpcConfig(f, ext), { mode: 0o600 })
  log.info('remote', '正在启动 frpc', { server: f.server, remotePort: f.remotePort })
  let cp: ChildProcess
  try {
    cp = spawn(bin, ['-c', FRPC_CONFIG], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv([]) })
  } catch (e) {
    return fail((e as Error).message)
  }
  child = cp
  const onData = (b: Buffer) => {
    if (child !== cp) return
    const text = b.toString()
    output = (output + text).slice(-8000)
    for (const line of text.split('\n')) {
      const ev = frpcEvent(line)
      const proxy = frpcProxyOf(line)
      // 端口映射各管各的：某一条开不出来不影响面板本身
      if (proxy.startsWith('agent-panel-m-') && (ev === 'ok' || ev === 'port' || ev === 'local')) {
        const m = f.mappings.find((x) => proxy === `agent-panel-m-${x.id}`)
        mappingStates[proxy.slice('agent-panel-m-'.length)] = {
          ok: ev === 'ok',
          error:
            ev === 'ok'
              ? ''
              : ev === 'local' && m
                ? localServiceHint(m.localIP || '127.0.0.1', m.localPort, frpcLine(line))
                : frpcLine(line),
        }
        continue
      }
      // 本机服务连不上只影响那一条映射，不改面板自己的连接状态
      if (ev === 'local') continue
      if (ev === 'ok') {
        state = 'running'
        error = ''
        log.info('remote', '外部访问已启用（frp）', { url })
      } else if (ev) {
        // frpc 会自己重试，进程不停；把原因和原文一起显示
        state = 'starting'
        error = frpHint(ev, f.bindPort, f.remotePort, frpcLine(line))
      }
    }
  }
  cp.stdout?.on('data', onData)
  cp.stderr?.on('data', onData)
  cp.on('error', (e) => {
    if (child !== cp) return
    void quarantined(bin, e as NodeJS.ErrnoException).then((q) => fail(q || e.message))
  })
  cp.on('exit', (code) => {
    if (child !== cp) return
    child = null
    state = 'error'
    error = t('frpc 已退出（退出码 {code}）：{log}', { code: String(code), log: lastLines(output) })
    // 没有任何输出就退出、或者程序文件没了：多半是被安全软件拦下 / 隔离
    void quarantined(bin, null, !output.trim()).then((q) => {
      if (q && child === null && state === 'error') error = q
    })
    log.error('remote', 'frpc 已退出', { code, error })
  })
}

/**
 * frpc 是不是被安全软件拦了：程序文件不见了（被隔离 / 删除）、没有权限执行，或者一启动就没有任何输出地退出。
 * 是的话返回给用户看的处理办法（信任区要加的目录），否则返回空
 */
async function quarantined(bin: string, e: NodeJS.ErrnoException | null, silentExit = false) {
  const gone = await access(bin).then(
    () => false,
    () => true,
  )
  const blocked = !!e && ['ENOENT', 'EPERM', 'EACCES', 'UNKNOWN'].includes(e.code ?? '')
  if (!gone && !blocked && !silentExit) return ''
  return t(
    'frpc 被安全软件拦截或隔离了（frp 是开源的内网穿透工具，常被电脑管家、360、Windows 安全中心误报）。请在安全软件的隔离区恢复它，并把 {dir} 加进信任区，然后点「重新连接」；文件已经被删时会自动重新下载。',
    { dir: FRP_BIN_DIR },
  )
}

/** 映射连不上本机服务：SSH 最常见的是 Windows 没装 / 没启动 OpenSSH 服务器 */
function localServiceHint(ip: string, port: number, line: string) {
  const addr = `${ip}:${port}`
  if (port === 22)
    return t(
      '本机 {addr} 没有 SSH 服务在运行：Windows 要在「可选功能」里添加「OpenSSH 服务器」并启动 sshd，macOS 在「共享」里打开「远程登录」。{log}',
      { addr, log: line },
    )
  return t('本机 {addr} 没有服务在运行，外部连上后会被立刻断开。{log}', { addr, log: line })
}

function frpHint(ev: FrpcEvent, bindPort: number, remotePort: number, line: string) {
  if (ev === 'auth') return t('frp 令牌不匹配：请重新点「一键配置」。{log}', { log: line })
  if (ev === 'port')
    return t('服务器上的端口 {port} 不能用（被占用或不在允许范围）：换一个面板端口后重新一键配置。{log}', {
      port: String(remotePort),
      log: line,
    })
  if (ev === 'closed')
    return t(
      '已经连上云服务器的 {port} 端口，但对方马上断开了：这个端口可能被别的程序（例如以前装的 frp）占着。在服务器上执行 sudo ss -ltnp | grep :{port}，看监听的是不是 agent-panel-frps；不是的话停掉那个程序，或在「高级 · 端口」里换一个 frp 端口后重新一键配置。{log}',
      { port: String(bindPort), log: line },
    )
  if (ev === 'refused')
    return t(
      '云服务器的 {port} 端口没有程序在监听：frps 没在运行。在服务器上执行 sudo systemctl status agent-panel-frps 查看原因，或重新点「一键配置」。{log}',
      { port: String(bindPort), log: line },
    )
  return t('连不上云服务器的 frp 端口 {port}：请在阿里云控制台「安全组 → 入方向」放行 TCP {port} 和 {remote}。{log}', {
    port: String(bindPort),
    remote: String(remotePort),
    log: line,
  })
}

async function doApply() {
  await stopChild()
  await stopTailscale()
  await stopExternal()
  mappingStates = {}
  state = 'off'
  url = ''
  error = ''
  await syncLimits()
  const s = (await getSettings()).remoteAccess
  if (!s.enabled) return
  try {
    await start(s)
  } catch (e) {
    fail((e as Error).message)
  }
}

let queue: Promise<unknown> = Promise.resolve()
/** 按设置启停外网专用端口和 frpc；连续保存设置时排队执行，不会同时起两个 frpc */
export function applyRemote() {
  const p = queue.then(doApply, doApply)
  queue = p.catch(() => {})
  return p
}

export const stopRemote = async () => {
  await stopChild()
  await stopTailscale()
  await stopExternal()
  // 退出前把会话表写下去，重启后已登录的设备不用重新登录
  await sessions.flush()
}

async function status(): Promise<RemoteAccessStatus> {
  const s = (await getSettings()).remoteAccess
  return {
    enabled: s.enabled,
    mode: s.mode,
    state,
    url,
    error,
    localPort: external?.port ?? 0,
    https: !!external?.https,
    lanIps: lanIps(),
    hasPassword: hasPassword(),
    localUser: localUser(),
    tailscale: s.mode === 'tailscale' ? await probeTailscale(s) : null,
    download,
    deploy,
    mappings: s.mode === 'frp' && s.enabled ? await withLocalProbe(s) : mappingStates,
  }
}

/** 本机端口有没有服务在监听：连得上就算有（只连本机或局域网，600ms 就够） */
export function localListening(host: string, port: number, timeoutMs = 600) {
  return new Promise<boolean>((resolve) => {
    const sock = connect({ host, port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * 映射的状态里补上本机服务的检查：frpc 只有在外面真有人连进来时才会报「连不上本机服务」，
 * 等用户连不上再查太晚了，设置页每次刷新时主动探一下（文件共享由 frpc 自己出文件，不用探）
 */
async function withLocalProbe(s: RemoteAccess) {
  const out = { ...mappingStates }
  await Promise.all(
    s.frp.mappings
      .filter((m) => m.enabled && m.type !== 'files')
      .map(async (m) => {
        const ip = m.localIP || '127.0.0.1'
        if (await localListening(ip, m.localPort)) return
        // UDP 探不出来：只对 TCP 类（tcp / xtcp）下结论
        if (m.type === 'udp') return
        out[m.id] = { ok: false, error: localServiceHint(ip, m.localPort, '') }
      }),
  )
  return out
}

const DeployBody = z.object({
  server: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[\w.:-]+$/),
  sshPort: z.number().int().min(1).max(65535),
  sshUser: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w.-]+$/),
  password: z.string().min(1).max(500),
  bindPort: z.number().int().min(1).max(65535),
  remotePort: z.number().int().min(1).max(65535),
  rangeStart: z.number().int().min(1).max(65535),
  rangeEnd: z.number().int().min(1).max(65535),
})

/** 一键配置云服务器：部署 frps，保存设置并切到 frp 方式，返回保存后的外部访问设置 */
async function deployCloud(body: z.infer<typeof DeployBody>) {
  if (deploy?.running) throw new Error(t('正在配置，请稍候'))
  if (body.bindPort === body.remotePort) throw new Error(t('frp 端口和面板端口不能相同'))
  if (body.rangeStart > body.rangeEnd || body.rangeEnd - body.rangeStart > 1000)
    throw new Error(t('端口映射范围不对：起始不能大于结束，最多 1000 个端口'))
  for (const p of [body.bindPort, body.remotePort])
    if (p >= body.rangeStart && p <= body.rangeEnd) throw new Error(t('frp 端口和面板端口不能落在端口映射范围里'))
  const cur = await getSettings()
  // 同一台服务器重配时沿用旧令牌：别的电脑上的 frpc 不至于马上断开
  const token =
    cur.remoteAccess.frp.server === body.server && cur.remoteAccess.frp.token
      ? cur.remoteAccess.frp.token
      : newFrpToken()
  deploy = { running: true, step: 'connect', percent: -1, error: '' }
  try {
    await deployFrps({ ...body, token }, (step, percent) => {
      if (deploy) deploy = { ...deploy, step, percent: percent ?? -1 }
    })
  } catch (e) {
    deploy = { running: false, step: deploy?.step ?? 'connect', percent: -1, error: (e as Error).message }
    log.warn('remote', '一键配置云服务器失败', { error: (e as Error).message })
    throw e
  }
  const next = await getSettings()
  next.remoteAccess = {
    ...next.remoteAccess,
    enabled: true,
    mode: 'frp',
    frp: {
      // 端口映射留着：重新配置服务器不该把用户加的映射清掉
      ...next.remoteAccess.frp,
      server: body.server,
      sshPort: body.sshPort,
      sshUser: body.sshUser,
      bindPort: body.bindPort,
      remotePort: body.remotePort,
      rangeStart: body.rangeStart,
      rangeEnd: body.rangeEnd,
      token,
    },
  }
  const saved = await saveSettings(next)
  deploy = { running: false, step: 'done', percent: 100, error: '' }
  await applyRemote()
  return saved.remoteAccess
}

/** 本机登录用户名：设置页拼 SSH 连接命令用；读不到（容器里没有 passwd 条目）时为空 */
function localUser() {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

/** 设置页用的接口：状态、重新连接、一键配置云服务器、连接测试；访问密码和登录的设备在 /guard 下 */
export function remoteApi() {
  const routes = new Hono()
  routes.get('/status', async (c) => c.json(await status()))
  // 「重新连接」：按当前设置重启外网端口和 frpc，不用把外部访问关掉再打开
  routes.post('/restart', async (c) => {
    await applyRemote()
    return c.json(await status())
  })
  routes.post('/frp/deploy', async (c) => {
    const p = DeployBody.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return c.json({ error: t('服务器信息不完整：{msg}', { msg: z.prettifyError(p.error) }) }, 400)
    try {
      const remoteAccess = await deployCloud(p.data)
      return c.json({ remoteAccess, status: await status() })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  // 连接测试：从本机按顺序试 frp 的每一段，告诉用户断在哪
  routes.post('/frp/test', async (c) => {
    const s = (await getSettings()).remoteAccess
    return c.json(await frpTest(s, { localPort: external?.port ?? 0, frpcRunning: !!child, state, error }))
  })
  // Tailscale 刚装好 / 刚登录：重新检测，连上了就顺手按设置开转发
  routes.post('/tailscale/check', async (c) => {
    const s = (await getSettings()).remoteAccess
    await probeTailscale(s, true)
    if (s.enabled && s.mode === 'tailscale' && state !== 'running') await applyRemote()
    return c.json(await status())
  })
  routes.route('/guard', guardApi())
  return routes
}
