import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import path from 'node:path'
import { userInfo } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { z } from 'zod'
import type { RemoteAccess } from '../shared/schema.ts'
import type { CloudflaredInfo, FrpDeployStatus, RemoteAccessStatus, RemoteState } from '../shared/remote.ts'
import { t } from '../shared/i18n.ts'
import { DATA_DIR } from './store.ts'
import { getSettings, saveSettings } from './settings.ts'
import { EXTERNAL_ENV } from './hosts.ts'
import {
  FRPC_CONFIG,
  deployFrps,
  ensureFrpc,
  frpcConfig,
  frpcEvent,
  frpcLine,
  frpcProxyOf,
  newFrpToken,
} from './frp.ts'
import { capture, childEnv } from './exec/process.ts'
import { resolveCommand } from './cli-source.ts'
import { netFetch } from './net.ts'
import { log } from './log.ts'
import { refreshWinPath } from './win-path.ts'

const execFileAsync = promisify(execFile)
const isWin = process.platform === 'win32'
const BIN = path.join(DATA_DIR, 'bin')
const BIN_FILE = path.join(BIN, isWin ? 'cloudflared.exe' : 'cloudflared')
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

type FetchHandler = (req: Request, env?: unknown) => Response | Promise<Response>
let handler: FetchHandler | undefined
/** 外网专用端口：开着外网访问时才监听，见 shared/schema.ts 的 RemoteAccess.localPort */
let external: { server: Server; port: number } | null = null
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
let startTimer: NodeJS.Timeout | undefined
let cache: { key: string; at: number; data: CloudflaredInfo } | null = null
let download: { running: boolean; percent: number; error: string } | null = null

/** 允许的外部主机名：只有开着外网访问、隧道已经连上（或填了固定地址）时才有 */
let active = { enabled: false, hosts: new Set<string>() }

const setActive = (enabled: boolean, hosts: string[]) =>
  (active = { enabled, hosts: new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean)) })

/** 外部请求只接受当前隧道/反代地址；本机地址由调用方另外判断 */
export const isRemoteHostAllowed = (host: string) => active.enabled && active.hosts.has(host.toLowerCase())

/** 交给外网专用端口的请求处理函数（和主端口同一个，见 server/index.ts） */
export function configureRemote(fetch: FetchHandler) {
  handler = fetch
}

/**
 * 起外网专用端口（只监听 127.0.0.1）：隧道 / frpc / 反代转进来的请求在 env 上打标记，
 * tokenGuard 据此一律当外网处理。fixed 为 false 时端口被占用就换一个系统分配的
 */
function startExternal(want: number, fixed: boolean): Promise<number> {
  const fetch = handler
  if (!fetch) return Promise.reject(new Error(t('面板服务还没启动')))
  const listen = (p: number) =>
    new Promise<{ server: Server; port: number }>((resolve, reject) => {
      const server = serve(
        {
          fetch: (req: Request, env: Record<string, unknown>) => fetch(req, { ...env, [EXTERNAL_ENV]: true }),
          port: p,
          hostname: '127.0.0.1',
        },
        (info) => resolve({ server: server as Server, port: info.port }),
      ) as Server
      server.once('error', reject)
    })
  return listen(want)
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EADDRINUSE' || fixed) {
        throw new Error(
          e.code === 'EADDRINUSE'
            ? t('外网专用端口 {port} 已被占用，请在设置里换一个', { port: String(want) })
            : e.message,
        )
      }
      return listen(0)
    })
    .then((x) => {
      external = x
      log.info('remote', '外网专用端口已监听', { port: x.port })
      return x.port
    })
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

/** 从 cloudflared 的输出里找临时地址（重启后域名会变） */
export function tunnelUrl(text: string): string {
  return text.match(QUICK_URL)?.[0].toLowerCase() ?? ''
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

/** 检测 cloudflared：设置里的命令、数据目录里下载的、PATH 里的 */
async function probe(command: string, force = false): Promise<CloudflaredInfo> {
  const key = `${command}|${BIN_FILE}`
  if (!force && cache?.key === key && Date.now() - cache.at < 60_000) return cache.data
  // 用 winget、安装包装好后新的 PATH 只在注册表里，补进当前进程再找
  await refreshWinPath(force)
  const candidates = [...new Set([command.trim(), BIN_FILE, 'cloudflared'].filter(Boolean))]
  let reason = ''
  let data: CloudflaredInfo = { installed: false, version: '', path: '', error: t('没有找到 cloudflared') }
  for (const c of candidates) {
    const r = await capture(c, ['--version'], process.cwd(), childEnv([]), 5000)
    const out = (r.stdout || r.stderr).trim().split('\n')[0] ?? ''
    if (!r.spawnError && !r.killed && r.code === 0) {
      const version = out.match(/version\s+v?([\w.-]+)/i)?.[1] ?? out
      data = { installed: true, version, path: resolveCommand(c, process.env) ?? c, error: '' }
      break
    }
    reason = r.spawnError ?? (r.killed ? t('检测超时') : out)
  }
  if (!data.installed && reason) data.error = reason
  cache = { key, at: Date.now(), data }
  return data
}

const lastLines = (text: string) => text.trim().split('\n').slice(-4).join('\n').slice(-800)

/** 停掉正在运行的隧道，等它退出（最多 3 秒） */
async function stopChild() {
  clearTimeout(startTimer)
  startTimer = undefined
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
  setActive(false, [])
  log.warn('remote', '外部访问不可用', { error: message })
}

async function start(s: RemoteAccess) {
  // 自建反代要指向固定端口；其它方式由面板自己接，端口被占用就换一个
  const ext = await startExternal(s.localPort, s.mode === 'custom')
  if (s.mode === 'frp') return startFrpc(s, ext)
  if (s.mode === 'custom') {
    const target = normalizePublicUrl(s.publicUrl)
    if (!target) return fail(t('请填写外部访问地址，例如 https://panel.example.com'))
    url = target
    state = 'running'
    error = ''
    setActive(true, [hostOfUrl(target)])
    log.info('remote', '外部访问已启用（自建反向代理）', { url })
    return
  }

  const info = await probe(s.command)
  if (!info.installed) {
    return fail(t('没有找到 cloudflared：请先在设置里下载，或安装后把路径填到「cloudflared 路径」。'))
  }

  let target = ''
  if (s.mode === 'token') {
    if (!s.tunnelToken) return fail(t('请填写 Cloudflare Tunnel 的 token'))
    target = normalizePublicUrl(s.publicUrl)
    if (!target) return fail(t('请填写隧道的域名，例如 https://panel.example.com'))
    // 固定域名在设置里已经知道，隧道连上之前也可以先允许访问（连不上时请求会失败）
    url = target
    setActive(true, [hostOfUrl(target)])
  }

  // 默认的 QUIC（UDP 7844）在国内常被干扰，固定用 http2 走 TCP
  const args =
    s.mode === 'token'
      ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run']
      : ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${ext}`]
  const env = childEnv([])
  // token 走环境变量，不出现在进程列表的参数里
  if (s.mode === 'token') env.TUNNEL_TOKEN = s.tunnelToken
  state = 'starting'
  error = ''
  output = ''
  log.info('remote', '正在启动 cloudflared', { mode: s.mode })
  let cp: ChildProcess
  try {
    cp = spawn(info.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
  } catch (e) {
    return fail((e as Error).message)
  }
  child = cp

  const onData = (b: Buffer) => {
    if (child !== cp) return
    output = (output + b.toString()).slice(-8000)
    if (s.mode !== 'quick') return
    const found = tunnelUrl(output)
    if (!found || state === 'running') return
    url = found
    state = 'running'
    error = ''
    setActive(true, [hostOfUrl(found)])
    clearTimeout(startTimer)
    log.info('remote', '外部访问已启用', { url })
  }
  cp.stdout?.on('data', onData)
  cp.stderr?.on('data', onData)
  cp.on('error', (e) => {
    if (child !== cp) return
    fail(e.message)
  })
  cp.on('exit', (code) => {
    if (child !== cp) return
    child = null
    state = 'error'
    error = t('cloudflared 已退出（退出码 {code}）：{log}', { code: String(code), log: lastLines(output) })
    setActive(false, [])
    log.error('remote', 'cloudflared 已退出', { code, error })
  })

  startTimer = setTimeout(
    () => {
      if (child !== cp) return
      if (s.mode === 'quick' && state !== 'running') {
        fail(
          t(
            'cloudflared 已经启动，但 30 秒内没有拿到外网地址。国内网络经常连不上 Cloudflare，建议改用「云服务器（frp）」。',
          ),
        )
        void stopChild()
        return
      }
      // token 模式没有地址可等，进程还活着就先当作已连接；连不上时 cloudflared 会自己退出
      if (state === 'starting') state = 'running'
    },
    s.mode === 'quick' ? 30_000 : 3000,
  )
}

/** 跑 frpc：把云服务器上的 remotePort 转到外网专用端口 */
async function startFrpc(s: RemoteAccess, ext: number) {
  const f = s.frp
  if (!f.server || !f.token) return fail(t('还没配置云服务器：填好服务器信息后点「一键配置」'))
  url = `http://${f.server.includes(':') ? `[${f.server}]` : f.server}:${f.remotePort}`
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
      if (proxy.startsWith('agent-panel-m-') && (ev === 'ok' || ev === 'port')) {
        mappingStates[proxy.slice('agent-panel-m-'.length)] = {
          ok: ev === 'ok',
          error: ev === 'ok' ? '' : frpcLine(line),
        }
        continue
      }
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
    fail(e.message)
  })
  cp.on('exit', (code) => {
    if (child !== cp) return
    child = null
    state = 'error'
    error = t('frpc 已退出（退出码 {code}）：{log}', { code: String(code), log: lastLines(output) })
    log.error('remote', 'frpc 已退出', { code, error })
  })
}

function frpHint(ev: ReturnType<typeof frpcEvent>, bindPort: number, remotePort: number, line: string) {
  if (ev === 'auth') return t('frp 令牌不匹配：请重新点「一键配置」。{log}', { log: line })
  if (ev === 'port')
    return t('服务器上的端口 {port} 不能用（被占用或不在允许范围）：换一个面板端口后重新一键配置。{log}', {
      port: String(remotePort),
      log: line,
    })
  return t('连不上云服务器的 frp 端口 {port}：请在阿里云控制台「安全组 → 入方向」放行 TCP {port} 和 {remote}。{log}', {
    port: String(bindPort),
    remote: String(remotePort),
    log: line,
  })
}

async function doApply() {
  await stopChild()
  await stopExternal()
  mappingStates = {}
  state = 'off'
  url = ''
  error = ''
  setActive(false, [])
  const s = (await getSettings()).remoteAccess
  if (!s.enabled) return
  try {
    await start(s)
  } catch (e) {
    fail((e as Error).message)
  }
}

let queue: Promise<unknown> = Promise.resolve()
/** 按设置启停隧道；连续保存设置时排队执行，不会同时起两个 cloudflared */
export function applyRemote() {
  const p = queue.then(doApply, doApply)
  queue = p.catch(() => {})
  return p
}

export const stopRemote = async () => {
  await stopChild()
  await stopExternal()
}

/** 下载 cloudflared：Windows / Linux 下直接放二进制，macOS 下载后解压 */
function asset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (isWin) return { name: `cloudflared-windows-${arch}.exe`, tgz: false }
  if (process.platform === 'linux') return { name: `cloudflared-linux-${arch}`, tgz: false }
  if (process.platform === 'darwin') return { name: `cloudflared-darwin-${arch}.tgz`, tgz: true }
  return undefined
}

async function downloadFile(from: string, to: string, onPercent: (n: number) => void, signal: AbortSignal) {
  const res = await netFetch(from, { signal })
  if (!res.ok || !res.body) throw new Error(t('下载失败（{status}）：{url}', { status: String(res.status), url: from }))
  const total = Number(res.headers.get('content-length') ?? 0)
  let got = 0
  onPercent(-1)
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (c: Buffer) => {
    got += c.length
    onPercent(total ? Math.min(100, Math.round((got / total) * 100)) : -1)
  })
  const part = `${to}.part`
  await mkdir(path.dirname(to), { recursive: true })
  await pipeline(body, createWriteStream(part), { signal })
  await rename(part, to)
}

/** 小于这个大小的不可能是 cloudflared（正常 20–50 MB）：多半是被代理、门户页换成了一段 HTML */
const MIN_BINARY_BYTES = 5 * 1024 * 1024

/**
 * 文件头是不是这个系统能跑的可执行文件：Windows 是 PE（MZ），Linux 是 ELF，macOS 是 Mach-O（含通用二进制）。
 * 只看文件头，返回给用户看的原因，通过时返回空字符串
 */
export function binaryProblem(head: Buffer, size: number, platform: NodeJS.Platform): string {
  if (size < MIN_BINARY_BYTES) return t('下载的 cloudflared 只有 {n} 字节，不是完整的程序', { n: String(size) })
  const magic = head.subarray(0, 4).toString('hex')
  const ok =
    platform === 'win32'
      ? head.subarray(0, 2).toString('latin1') === 'MZ'
      : platform === 'linux'
        ? magic === '7f454c46'
        : platform === 'darwin'
          ? ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(magic)
          : false
  return ok ? '' : t('下载的 cloudflared 不是这个系统能运行的程序（文件头 {magic}）', { magic })
}

/**
 * 下载完的 cloudflared 先核对再用：cloudflared 的 GitHub Release 没有可以离线核对的校验文件，
 * 至少确认它是完整大小的、本系统格式的可执行文件，并把 sha256 记进日志，出了问题能对照官方发布页核对
 */
async function verifyBinary(file: string) {
  const fh = await open(file, 'r')
  let head: Buffer
  let size: number
  try {
    size = (await fh.stat()).size
    head = Buffer.alloc(4)
    await fh.read(head, 0, 4, 0)
  } finally {
    await fh.close()
  }
  const why = binaryProblem(head, size, process.platform)
  if (why) throw new Error(why)
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  log.info('remote', 'cloudflared 文件核对通过', { path: file, bytes: size, sha256: h.digest('hex') })
}

/** 下载 cloudflared 到数据目录；返回错误信息，成功时为空 */
export async function installCloudflared(): Promise<string> {
  if (download?.running) return t('正在下载 cloudflared，稍后再试')
  const a = asset()
  if (!a) {
    download = { running: false, percent: -1, error: t('这个系统不支持自动下载，请手动安装 cloudflared。') }
    return download.error
  }
  download = { running: true, percent: -1, error: '' }
  // 不用解压的直接存成 cloudflared(.exe)：检测只认这个名字
  const file = a.tgz ? path.join(BIN, a.name) : BIN_FILE
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${a.name}`
  try {
    await mkdir(BIN, { recursive: true })
    log.info('remote', '开始下载 cloudflared', { url })
    await downloadFile(
      url,
      file,
      (n) => {
        if (download) download.percent = n
      },
      AbortSignal.timeout(10 * 60_000),
    )
    if (a.tgz) {
      await execFileAsync('tar', ['-xzf', file, '-C', BIN])
      await rm(file, { force: true })
    }
    // 核对不过就删掉：留着的话下次检测会把这个坏文件当成已装好
    await verifyBinary(BIN_FILE).catch(async (e) => {
      await rm(BIN_FILE, { force: true })
      throw e
    })
    if (!isWin) await chmod(BIN_FILE, 0o755)
    // 下载到的文件可能和设置里填的命令不是同一个；重新检测一次
    cache = null
    log.info('remote', 'cloudflared 已下载', { path: BIN_FILE })
    await applyRemote()
  } catch (e) {
    download = { running: false, percent: -1, error: (e as Error).message }
    log.error('remote', '下载 cloudflared 失败', e)
    return download.error
  }
  download = { running: false, percent: 100, error: '' }
  return ''
}

async function status(link: (url: string) => string): Promise<RemoteAccessStatus> {
  const s = (await getSettings()).remoteAccess
  return {
    enabled: s.enabled,
    mode: s.mode,
    state,
    url,
    link: url ? link(url) : '',
    error,
    localPort: external?.port ?? 0,
    localUser: localUser(),
    cloudflared: await probe(s.command),
    download,
    deploy,
    mappings: mappingStates,
  }
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

/** 设置页用的接口：状态、检测、下载 */
export function remoteApi(deps: { link: (url: string) => string }) {
  const routes = new Hono()
  routes.get('/status', async (c) => c.json(await status(deps.link)))
  routes.post('/check', async (c) => {
    const s = (await getSettings()).remoteAccess
    cache = null
    const info = await probe(s.command, true)
    return c.json({ ...(await status(deps.link)), cloudflared: info } satisfies RemoteAccessStatus)
  })
  routes.post('/install', async (c) => {
    void installCloudflared()
    return c.json(await status(deps.link))
  })
  routes.post('/frp/deploy', async (c) => {
    const p = DeployBody.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return c.json({ error: t('服务器信息不完整：{msg}', { msg: z.prettifyError(p.error) }) }, 400)
    try {
      const remoteAccess = await deployCloud(p.data)
      return c.json({ remoteAccess, status: await status(deps.link) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  return routes
}
