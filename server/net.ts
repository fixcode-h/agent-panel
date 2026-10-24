/**
 * 访问外网（GitHub）的请求：Node 自带的 fetch 不走代理，国内访问 GitHub 常常连不上。
 * 设置里填了代理就用它，没填时看环境变量 HTTPS_PROXY / HTTP_PROXY；
 * 直连或配置的代理连不上时，再自动找本机正在运行的代理（系统代理 → 常见端口）重试一遍。
 */
import { execFile } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https'
import { ProxyAgent, fetch as proxyFetch, type Dispatcher } from 'undici'
import { getSettings } from './settings.ts'
import { t } from '../shared/i18n.ts'

/** 和 fetch 一样用；timeoutMs 只限制等到响应头的时间，之后读 body 不受它影响 */
export interface NetInit extends RequestInit {
  timeoutMs?: number
  /** 每次尝试（含回退到另一条路）开始前调用：调用方可以借此重置自己的空闲计时 */
  onAttempt?: () => void
}

/**
 * 常见本地代理端口：Clash（7890 / 7891 / 7897）、V2Ray（10809；10808 是 SOCKS）、通用 SOCKS（1080）。
 * 探测时全部并发跑一遍；真正拿来做请求的本地端口最多 MAX_LOCAL_PROXIES 个（见 pickLocalProxies）。
 */
export const LOCAL_PROXY_PORTS = [7890, 10809, 7891, 7897, 10808, 1080]
/** 真正尝试时最多用几个本地端口：再多也只是让没有代理的更新等更久 */
export const MAX_LOCAL_PROXIES = 3
/** 每个候选项的握手超时 */
export const PROBE_TIMEOUT_MS = 1200
/** 探测到的可用代理缓存多久；没有代理时短一些，用户刚开代理软件也能很快用上 */
const FOUND_TTL = 60_000
const MISS_TTL = 30_000
const SYSTEM_TTL = 60_000
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const ENV_PROXY = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

/** 这次请求一开始走哪条路；fallback 表示失败后要不要再找本机代理 */
export type ProxyPlan = { kind: 'proxy'; key: string; shown: string } | { kind: 'direct'; fallback: boolean }

interface Attempt {
  key: string
  shown: string
  source: 'configured' | 'local' | 'direct'
}

/** 测试时可以替换网络请求和探测结果，不用真的连代理 */
export interface NetDeps {
  direct: (url: string, init: RequestInit) => Promise<Response>
  viaProxy: (url: string, init: RequestInit, key: string) => Promise<Response>
  plan: (url: string) => Promise<ProxyPlan>
  discover: () => Promise<string[]>
  proxyFailed?: (key: string) => void
}

/** 本机地址永远直连：面板自己、本机模型服务都不该经过代理 */
export function isLocalUrl(url: string) {
  try {
    const { hostname } = new URL(url)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** 环境变量 NO_PROXY 里列出的主机（或它的子域名）不走代理；* 表示都不走 */
export function noProxy(url: string, value = process.env.NO_PROXY ?? process.env.no_proxy ?? '') {
  const host = new URL(url).hostname.toLowerCase()
  return value
    .split(',')
    .map((x) =>
      x
        .trim()
        .toLowerCase()
        .replace(/:\d+$/, '')
        .replace(/^\*?\./, ''),
    )
    .filter(Boolean)
    .some((x) => x === '*' || host === x || host.endsWith(`.${x}`))
}

/** 补上协议并只保留 http(s)：ProxyAgent 不支持 socks，填了也不能用 */
function httpProxy(value: string) {
  const raw = value.trim()
  if (!raw) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const u = new URL(withScheme)
    return u.protocol === 'http:' || u.protocol === 'https:' ? withScheme : ''
  } catch {
    return ''
  }
}

/** 报错里显示代理地址时去掉里面的账号密码 */
function redact(proxy: string) {
  return proxy.replace(/\/\/[^/@]*@/, '//')
}

function dedupe(list: string[]) {
  return [...new Set(list)]
}

/**
 * Windows 系统代理：ProxyServer 可能是「host:port」，也可能是
 * 「http=host:port;https=host:port;socks=...」，https 优先、其次 http。
 * enable 是注册表里的值，开的时候是 0x1。
 */
export function windowsProxy(enable: string, server: string) {
  if (!/^(0x0*1|1)$/i.test(enable.trim())) return []
  const map = new Map<string, string>()
  for (const part of server
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const at = part.indexOf('=')
    if (at < 0) {
      map.set('http', part)
      map.set('https', part)
    } else map.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim())
  }
  return dedupe([map.get('https') ?? '', map.get('http') ?? ''].map(httpProxy).filter(Boolean))
}

/** 解析 `reg query` 的输出（ProxyEnable / ProxyServer 两行） */
export function parseWindowsProxy(text: string) {
  const value = (name: string) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im').exec(text)?.[1] ?? ''
  return windowsProxy(value('ProxyEnable'), value('ProxyServer'))
}

/** 解析 macOS `scutil --proxy` 的键值对，HTTPS 优先、其次 HTTP */
export function parseScutilProxy(text: string) {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (m) values.set(m[1], m[2])
  }
  const pick = (scheme: string) => {
    if (values.get(`${scheme}Enable`) !== '1') return ''
    const host = values.get(`${scheme}Proxy`) ?? ''
    const port = values.get(`${scheme}Port`) ?? ''
    return host ? httpProxy(port ? `${host}:${port}` : host) : ''
  }
  return dedupe([pick('HTTPS'), pick('HTTP')].filter(Boolean))
}

function run(cmd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 2000, windowsHide: true, encoding: 'utf8' }, (e, out) => {
      if (e) reject(e)
      else resolve(out)
    })
  })
}

let systemCache: { at: number; list: string[] } | undefined

/** 系统里配置的代理；Linux 等平台没有统一的读取方式，交给环境变量 */
export async function systemProxies(): Promise<string[]> {
  if (systemCache && Date.now() - systemCache.at < SYSTEM_TTL) return systemCache.list
  let list: string[] = []
  try {
    if (process.platform === 'win32') list = parseWindowsProxy(await run('reg', ['query', REG_KEY]))
    else if (process.platform === 'darwin') list = parseScutilProxy(await run('scutil', ['--proxy']))
  } catch {
    // 读不到系统代理不算错误：后面还有端口探测
  }
  systemCache = { at: Date.now(), list }
  return list
}

/**
 * 确认代理确实在运行并且能转发 HTTPS：向它发 CONNECT，看到 200（或要认证的 407）才算。
 * 只连端口不够：有些软件的其它服务也占着端口，但并没用代理。
 */
export function probeProxy(proxy: string, timeoutMs = PROBE_TIMEOUT_MS, target = 'api.github.com') {
  return new Promise<boolean>((resolve) => {
    let url: URL
    try {
      url = new URL(proxy)
    } catch {
      return resolve(false)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return resolve(false)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    const auth = url.username
      ? 'Basic ' +
        Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
      : ''
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request({
      host,
      port,
      method: 'CONNECT',
      path: `${target}:443`,
      headers: { host: `${target}:443`, ...(auth ? { 'proxy-authorization': auth } : {}) },
      timeout: timeoutMs,
      servername: host,
    } as HttpsRequestOptions)
    let settled = false
    let guard: ReturnType<typeof setTimeout> | undefined
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (guard) clearTimeout(guard)
      resolve(ok)
    }
    // req 的 timeout 是 socket 空闲超时，连接阶段（DNS / TCP 握手）卡住时不一定触发；
    // 没人接管的探测不能把一次更新拖住，自己再兜一条硬超时
    guard = setTimeout(() => {
      finish(false)
      req.destroy()
    }, timeoutMs)
    guard.unref?.()
    req.on('connect', (res, socket) => {
      socket.destroy()
      // 407：代理活着，只是要账号密码（地址里带了就会由 ProxyAgent 发过去）
      finish(res.statusCode === 200 || res.statusCode === 407)
    })
    req.on('timeout', () => {
      finish(false)
      req.destroy()
    })
    req.on('error', () => finish(false))
    req.end()
  })
}

/** 探测候选：系统代理 + 全部本地端口。并发探测，总耗时约等于一次握手超时，多几个端口不会变慢 */
export function localProxyCandidates(system: string[], ports: number[] = LOCAL_PROXY_PORTS) {
  return dedupe([...system.map(httpProxy).filter(Boolean), ...ports.map((port) => `http://127.0.0.1:${port}`)])
}

/**
 * 从探测结果里挑真正要试的：系统代理全部保留（通常是用户自己配的），
 * 本地端口按顺序最多 MAX_LOCAL_PROXIES 个。V2Ray 的 10809 排在第二个端口，不会被 Clash 的端口挤掉。
 */
export function pickLocalProxies(system: string[], alive: string[], max = MAX_LOCAL_PROXIES) {
  const sys = dedupe(system.map(httpProxy).filter(Boolean))
  const local = dedupe(alive.filter((proxy) => !sys.includes(proxy)))
  return [...sys.filter((proxy) => alive.includes(proxy)), ...local.slice(0, Math.max(0, max))]
}

interface ProxyCache {
  at: number
  list: string[]
  ttl: number
}

let localCache: ProxyCache | undefined

/** 探测本机正在运行的代理；同时探测所有候选，总耗时约等于一次握手超时 */
export async function localProxies(): Promise<string[]> {
  if (localCache && Date.now() - localCache.at < localCache.ttl) return localCache.list
  const system = await systemProxies()
  const candidates = localProxyCandidates(system)
  const alive = await Promise.all(candidates.map((proxy) => probeProxy(proxy)))
  const list = pickLocalProxies(
    system,
    candidates.filter((_, i) => alive[i]),
  )
  localCache = { at: Date.now(), list, ttl: list.length ? FOUND_TTL : MISS_TTL }
  return list
}

/** 某个代理请求失败后算出的新缓存：去掉它；全都不行了就按「没找到」的短间隔重新探测 */
export function dropBadProxy(cache: ProxyCache, proxy: string): ProxyCache {
  const list = cache.list.filter((x) => x !== proxy)
  return list.length === cache.list.length ? cache : { ...cache, list, ttl: list.length ? cache.ttl : MISS_TTL }
}

/** 某个代理请求失败：从探测结果里去掉，下次重新确认（代理软件关掉后也能重新检测） */
export function markProxyBad(proxy: string, cache: ProxyCache | undefined = localCache): ProxyCache | undefined {
  if (!cache) return undefined
  const next = dropBadProxy(cache, proxy)
  if (cache === localCache) localCache = next
  return next
}

/**
 * 尝试顺序：配置的代理（有的话）→ 本机代理 → 直连。
 * 空字符串表示直连；同一个地址只试一次。
 */
export function attemptOrder(configured: string | undefined, discovered: string[]) {
  return dedupe(configured ? [configured, ...discovered, ''] : ['', ...discovered])
}

const dispatchers = new Map<string, Dispatcher>()

function dispatcherFor(key: string) {
  let dispatcher = dispatchers.get(key)
  if (!dispatcher) {
    dispatcher = new ProxyAgent(key)
    dispatchers.set(key, dispatcher)
  }
  return dispatcher
}

/**
 * 这次请求一开始走哪条路：设置里的代理优先，其次环境变量（这时 NO_PROXY 生效），最后直连。
 * 设置里填的地址没写协议时补 http://，否则 ProxyAgent 解析不了；socks 这类不支持的照原样传下去，
 * 请求失败后按正常回退处理。
 */
export function planFor(
  url: string,
  set: string,
  env: string,
  noProxyValue = process.env.NO_PROXY ?? process.env.no_proxy ?? '',
): ProxyPlan {
  if (isLocalUrl(url)) return { kind: 'direct', fallback: false }
  if (set.trim()) {
    const key = httpProxy(set) || set.trim()
    return { kind: 'proxy', key, shown: redact(key) }
  }
  if (!env) return { kind: 'direct', fallback: true }
  if (noProxy(url, noProxyValue)) return { kind: 'direct', fallback: false }
  return { kind: 'proxy', key: env, shown: redact(env) }
}

/** 设置里的代理优先；没填时用环境变量（这时 NO_PROXY 也照常生效） */
async function defaultPlan(url: string): Promise<ProxyPlan> {
  let set = ''
  try {
    set = (await getSettings()).proxy.trim()
  } catch {
    // 设置读不出来时按没填处理，仍然可以走环境变量和自动检测
  }
  return planFor(url, set, ENV_PROXY.map((k) => process.env[k]).find(Boolean) ?? '')
}

const defaultDeps: NetDeps = {
  direct: (url, init) => fetch(url, init),
  viaProxy: (url, init, key) =>
    proxyFetch(url, { ...(init as object), dispatcher: dispatcherFor(key) }) as unknown as Promise<Response>,
  plan: defaultPlan,
  discover: localProxies,
  proxyFailed: markProxyBad,
}

type TryResult = { ok: true; response: Response } | { ok: false; error: unknown; cancelled: boolean }

/**
 * 每次尝试单独计时：上一次因为 timeoutMs 超时了，下一次要能重新计时。
 * 外部 signal 只用于调用方取消或它自己的总预算用完，一中止就整体停下（见 cancelled）。
 */
function attemptControl(external: AbortSignal | null | undefined, timeoutMs?: number) {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const forward = () => ac.abort(external?.reason)
  if (external) {
    if (external.aborted) forward()
    else external.addEventListener('abort', forward, { once: true })
  }
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      const reason = new Error('The operation was aborted due to timeout')
      reason.name = 'TimeoutError'
      ac.abort(reason)
    }, timeoutMs)
    timer.unref?.()
  }
  return {
    signal: ac.signal,
    /** 响应头拿到了：不再计超时，但外部取消仍然要能中断之后读 body */
    settle: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      external?.removeEventListener('abort', forward)
    },
  }
}

/**
 * 调用方中止（主动取消，或它用 AbortSignal.timeout 给自己的总预算用完）：
 * 不再换路径，把原因原样报出去。换路径只由我们自己每次尝试的 timeoutMs 触发。
 */
function cancelled(signal: AbortSignal | null | undefined) {
  return !!signal?.aborted
}

async function tryOnce(
  deps: NetDeps,
  url: string,
  init: RequestInit,
  attempt: Attempt,
  timeoutMs: number | undefined,
): Promise<TryResult> {
  const control = attemptControl(init.signal, timeoutMs)
  try {
    const request = { ...init, signal: control.signal }
    const response = attempt.key ? await deps.viaProxy(url, request, attempt.key) : await deps.direct(url, request)
    control.settle()
    return { ok: true, response }
  } catch (error) {
    control.dispose()
    return { ok: false, error, cancelled: cancelled(init.signal) }
  }
}

function pathLabel(attempt: Attempt) {
  if (attempt.source === 'direct') return t('直连')
  if (attempt.source === 'configured') return t('代理 {proxy}', { proxy: attempt.shown })
  return t('本机代理 {proxy}', { proxy: attempt.shown })
}

/** 最终失败的文案：原来的原因 + 试过哪些路径 + 有没有找到本机代理 */
function failure(error: unknown, tried: Attempt[], probed: boolean, stop: boolean) {
  const last = tried[tried.length - 1] ?? { key: '', shown: '', source: 'direct' as const }
  const base = last.source === 'direct' ? netError(error) : netError(error, last.shown)
  if (stop) return new Error(base, { cause: error })
  let message = base
  // 最后一条也是代理时，netError 的代理文案不会再提设置页；需求要求这条提示始终保留
  if (last.source !== 'direct')
    message += ' ' + t('访问不了 GitHub 时，可以在「设置 · 常规 · 网络代理」里填写本机代理。')
  if (tried.length > 1) {
    message += ' ' + t('尝试过的路径：{paths}。', { paths: tried.map(pathLabel).join('、') })
  }
  if (probed && !tried.some((a) => a.source === 'local')) message += ' ' + t('没有发现运行中的本机代理。')
  return new Error(message, { cause: error })
}

export async function netFetchWith(deps: NetDeps, url: string, init: NetInit = {}): Promise<Response> {
  const { timeoutMs, onAttempt, ...request } = init
  const plan = await deps.plan(url).catch((): ProxyPlan => ({ kind: 'direct', fallback: true }))
  const first: Attempt =
    plan.kind === 'proxy'
      ? { key: plan.key, shown: plan.shown, source: 'configured' }
      : { key: '', shown: '', source: 'direct' }
  const tried = [first]

  onAttempt?.()
  const started = await tryOnce(deps, url, request, first, timeoutMs)
  if (started.ok) return started.response
  if (started.cancelled) throw failure(started.error, tried, false, true)

  let error = started.error
  let probed = false
  const fallback = plan.kind === 'direct' ? plan.fallback : true
  if (fallback) {
    probed = true
    const discovered = await deps.discover().catch(() => [] as string[])
    for (const key of attemptOrder(plan.kind === 'proxy' ? plan.key : undefined, discovered).slice(1)) {
      const attempt: Attempt = key
        ? { key, shown: redact(key), source: 'local' }
        : { key: '', shown: '', source: 'direct' }
      tried.push(attempt)
      onAttempt?.()
      const result = await tryOnce(deps, url, request, attempt, timeoutMs)
      if (result.ok) return result.response
      if (result.cancelled) throw failure(result.error, tried, probed, true)
      error = result.error
      if (attempt.key) deps.proxyFailed?.(attempt.key)
    }
  }
  throw failure(error, tried, probed, false)
}

/** 和 fetch 一样用；有代理时经过代理，连不上时自动换本机代理再试 */
export async function netFetch(url: string, init: NetInit = {}): Promise<Response> {
  return netFetchWith(defaultDeps, url, init)
}

/** 把「fetch failed」换成能看懂的原因：真正的原因在 cause 里（连不上、超时、DNS 解析失败…） */
export function netError(e: unknown, proxy = ''): string {
  const err = e as Error & { cause?: { code?: string; message?: string } }
  const code = err.cause?.code ?? (err as { code?: string }).code ?? ''
  const why =
    err.name === 'TimeoutError' || /TIMEOUT/i.test(code)
      ? t('连接超时')
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? t('域名解析失败')
        : code === 'ECONNREFUSED'
          ? t('连接被拒绝')
          : code === 'ECONNRESET'
            ? t('连接被重置')
            : /certificate|CERT/i.test(code + (err.cause?.message ?? ''))
              ? t('证书校验失败')
              : ''
  const detail = [why, code, err.cause?.message && err.cause.message !== err.message ? err.cause.message : '']
    .filter(Boolean)
    .join(' · ')
  const base = detail ? `${err.message}（${detail}）` : err.message
  return proxy
    ? t('{error}。当前使用代理 {proxy}，请确认代理能访问 GitHub。', { error: base, proxy })
    : t('{error}。访问不了 GitHub 时，可以在「设置 · 常规 · 网络代理」里填写本机代理。', { error: base })
}
