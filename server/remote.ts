import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import type { RemoteAccess } from '../shared/schema.ts'
import type { CloudflaredInfo, RemoteAccessStatus, RemoteState } from '../shared/remote.ts'
import { t } from '../shared/i18n.ts'
import { DATA_DIR } from './store.ts'
import { getSettings } from './settings.ts'
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

let port = Number(process.env.PORT ?? 8787)
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

export const remoteHosts = () => active.hosts
/** 外部请求只接受当前隧道/反代地址；本机地址由调用方另外判断 */
export const isRemoteHostAllowed = (host: string) => active.enabled && active.hosts.has(host.toLowerCase())

export function configureRemote(p: number) {
  port = p
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

  const args =
    s.mode === 'token'
      ? ['tunnel', '--no-autoupdate', 'run']
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]
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
        fail(t('cloudflared 已经启动，但 30 秒内没有拿到外网地址。请检查网络，或在设置里填写代理。'))
        void stopChild()
        return
      }
      // token 模式没有地址可等，进程还活着就先当作已连接；连不上时 cloudflared 会自己退出
      if (state === 'starting') state = 'running'
    },
    s.mode === 'quick' ? 30_000 : 3000,
  )
}

async function doApply() {
  await stopChild()
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

export const stopRemote = stopChild

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
    cloudflared: await probe(s.command),
    download,
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
  return routes
}
