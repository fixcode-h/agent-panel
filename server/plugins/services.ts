import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import type { ServiceStatus } from '../../shared/api-contract/plugin-services.ts'
import type { PluginConfig } from '../../shared/plugins/index.ts'
import { fillPlaceholders } from '../../shared/plugins/placeholders.ts'
import type { PluginService } from '../../shared/plugins/runtime-schema.ts'
import { t } from '../../shared/i18n.ts'
import { childEnv, exitReason, runProcess } from '../exec/process.ts'
import { log } from '../log.ts'
import { signalPages } from '../page-events.ts'
import { prependPath } from './declared-path.ts'
import { pluginDataDir, type Installed } from './store.ts'

/**
 * 插件的托管进程（插件接口 11 的 services，设计稿 GitHub项目一键变插件与网页页签 第 5、7 节）：
 * 网页应用、要常驻的本地服务由面板起停，插件不用自己写进程管理。
 * - 端口只绑 127.0.0.1：auto 时面板找一个空闲端口，通过 {port} 交给进程；
 * - 起来后按 health 路径轮询，2xx / 3xx 才算能用，超过 startTimeoutSec 算失败（错误原样给用户看，不悄悄重试）；
 * - 输出写进 plugin-data/<id>/logs/<进程>.log，接口只回路径；
 * - start = on-open 的在打开页面时才起，stopAfterIdleMin 分钟没人看（touchService）就停；
 * - 插件关掉、删掉时（syncServices）和面板退出时（runProcess 登记的进程统一清理）一起停；
 * - 环境变量用 childEnv，不带账号设置里的凭据，只多带清单里声明的那几个；
 * - 状态变化走插件推送通道（事件 service），网页不轮询。
 */

interface Running {
  status: ServiceStatus
  abort: AbortController
  /** 最近一次有页面在用（打开、转发请求）的时间 */
  touched: number
  logStream?: WriteStream
}

interface Known {
  p: Installed
  config: PluginConfig
}

const known = new Map<string, Known>() // 模块状态：会话，跟着进程或连接一起没（开着的插件，syncServices 更新）
const running = new Map<string, Running>() // 模块状态：会话，跟着进程或连接一起没（键 插件/进程）
const starting = new Map<string, Promise<ServiceStatus>>() // 模块状态：会话，跟着进程或连接一起没（正在起的，并发的调用等同一次）
let idleTimer: ReturnType<typeof setInterval> | undefined // 模块状态：会话，跟着进程或连接一起没

const keyOf = (plugin: string, id: string) => `${plugin}/${id}`

const blank = (plugin: string, id: string): ServiceStatus => ({
  plugin,
  id,
  state: 'stopped',
  port: 0,
  error: '',
  log: '',
  startedAt: '',
})

function publish(s: ServiceStatus) {
  signalPages({ type: 'plugin', plugin: s.plugin, event: 'service', data: s })
}

function setStatus(r: Running, patch: Partial<ServiceStatus>) {
  r.status = { ...r.status, ...patch }
  publish(r.status)
  return r.status
}

/** 找一个空闲端口：让系统在 127.0.0.1 上分一个，拿到就关掉 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** 健康检查：在 timeoutMs 内拿到 2xx / 3xx 返回空字符串，否则返回原因；进程先退出了也停 */
export async function waitHealthy(url: string, timeoutMs: number, gone: () => boolean): Promise<string> {
  const end = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < end) {
    if (gone()) return t('进程已经退出')
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
      if (r.status >= 200 && r.status < 400) return ''
      last = `HTTP ${r.status}`
    } catch (e) {
      last = (e as Error).message
    }
    await new Promise((ok) => setTimeout(ok, 300))
  }
  return t('{sec} 秒内没起来（{last}）', { sec: Math.round(timeoutMs / 1000), last: last || t('连不上') })
}

/** 命令：带路径分隔符的按包里的文件算（./bin/app、dist/server.js），其余交给 PATH（node、npx、python） */
function commandOf(p: Installed, cmd: string) {
  return /[\\/]/.test(cmd) ? path.resolve(p.dir, cmd) : cmd
}

function serviceDef(plugin: string, id: string): { k: Known; def: PluginService } {
  const k = known.get(plugin)
  if (!k) throw new Error(t('插件 {id} 没开着或没装', { id: plugin }))
  const def = k.p.manifest.services.find((s) => s.id === id)
  if (!def) throw new Error(t('插件 {plugin} 没有托管进程 {id}', { plugin, id }))
  return { k, def }
}

async function launch(plugin: string, def: PluginService, k: Known): Promise<ServiceStatus> {
  const key = keyOf(plugin, def.id)
  const port = def.port === 'auto' ? await freePort() : def.port
  const vars = { config: k.config, dir: k.p.dir, data: pluginDataDir(plugin), port }
  const fill = (s: string) => fillPlaceholders(s, vars)
  const logDir = path.join(pluginDataDir(plugin), 'logs')
  await mkdir(logDir, { recursive: true })
  const logFile = path.join(logDir, `${def.id}.log`)
  const abort = new AbortController()
  const r: Running = {
    status: { ...blank(plugin, def.id), state: 'starting', port, log: logFile, startedAt: new Date().toISOString() },
    abort,
    touched: Date.now(),
    logStream: createWriteStream(logFile, { flags: 'a' }),
  }
  running.set(key, r)
  publish(r.status)
  r.logStream?.write(`\n==== ${r.status.startedAt} 启动 ${def.command} ${def.args.join(' ')}（端口 ${port}）\n`)
  // 清单里写的 PATH 前置同样带上：进程可能要调包里的其他可执行文件
  const pathVar = Object.entries(k.p.manifest.env).find(([n]) => n.toUpperCase() === 'PATH')?.[1]
  const env = childEnv([
    ...Object.entries(def.env).map(([key, value]) => ({ key, value: fill(value) })),
    { key: 'PORT', value: String(port) },
    { key: 'HOST', value: '127.0.0.1' },
  ])
  if (typeof pathVar === 'object')
    prependPath(
      env,
      pathVar.prepend.map((d) => path.join(k.p.dir, d)),
    )
  let exited = false
  void runProcess({
    command: commandOf(k.p, fill(def.command)),
    args: def.args.map(fill),
    cwd: def.cwd === '.' ? k.p.dir : path.join(k.p.dir, def.cwd),
    env,
    signal: abort.signal,
    onLine: (line) => r.logStream?.write(`${line}\n`),
    onStderr: (text) => r.logStream?.write(text),
  }).then((res) => {
    exited = true
    r.logStream?.end(`==== 退出：${res.spawnError ?? exitReason(res)}\n`)
    if (running.get(key) !== r) return
    running.delete(key)
    // 自己停的（关插件、空闲、用户点停止）算正常停下；其余是进程自己退出了，原样报给用户
    if (abort.signal.aborted) publish({ ...r.status, state: 'stopped', port: 0, startedAt: '' })
    else {
      const why = res.spawnError ?? exitReason(res)
      log.warn('plugin', `插件 ${plugin} 的托管进程 ${def.id} 退出了`, { why, log: logFile })
      publish({ ...r.status, state: 'failed', port: 0, error: t('进程退出了：{why}', { why }) })
    }
  })
  const health = `http://127.0.0.1:${port}${def.health.startsWith('/') ? def.health : `/${def.health}`}`
  const err = await waitHealthy(health, def.startTimeoutSec * 1000, () => exited)
  if (!err) return setStatus(r, { state: 'running' })
  abort.abort()
  running.delete(key)
  const failed = { ...r.status, state: 'failed' as const, port: 0, error: err }
  publish(failed)
  return failed
}

/** 起来（已经在跑或正在起的直接等那一次），并记一次「有人在用」 */
export async function startService(plugin: string, id: string): Promise<ServiceStatus> {
  const { k, def } = serviceDef(plugin, id)
  const key = keyOf(plugin, id)
  const pending = starting.get(key)
  if (pending) return pending
  const cur = running.get(key)
  if (cur) {
    cur.touched = Date.now()
    return cur.status
  }
  const ready = launch(plugin, def, k).finally(() => starting.delete(key))
  starting.set(key, ready)
  ensureIdleTimer()
  return ready
}

export function stopService(plugin: string, id: string): ServiceStatus {
  const r = running.get(keyOf(plugin, id))
  if (!r) return blank(plugin, id)
  r.abort.abort()
  return { ...r.status, state: 'stopped', port: 0, startedAt: '' }
}

/** 网页页签、沙箱源转发请求时调：记一次「有人在用」，空闲计时从头算 */
export function touchService(plugin: string, id: string) {
  const r = running.get(keyOf(plugin, id))
  if (r) r.touched = Date.now()
}

/** 给网页页签和沙箱源用：起来（没起就起），返回本机地址；起不来抛出原因 */
export async function serviceOrigin(plugin: string, id: string): Promise<string> {
  const s = await startService(plugin, id)
  if (s.state !== 'running') throw new Error(s.error || t('托管进程没起来'))
  return `http://127.0.0.1:${s.port}`
}

export function serviceStatuses(plugin: string): ServiceStatus[] {
  const k = known.get(plugin)
  return (k?.p.manifest.services ?? []).map((d) => running.get(keyOf(plugin, d.id))?.status ?? blank(plugin, d.id))
}

/** 每分钟看一次：on-open 的进程超过 stopAfterIdleMin 没人用就停 */
function ensureIdleTimer() {
  if (idleTimer) return
  idleTimer = setInterval(() => {
    for (const [key, r] of running) {
      const [plugin, id] = key.split('/')
      const def = known.get(plugin)?.p.manifest.services.find((s) => s.id === id)
      if (!def || def.start !== 'on-open' || !def.stopAfterIdleMin) continue
      if (Date.now() - r.touched > def.stopAfterIdleMin * 60_000) {
        log.info('plugin', `插件 ${plugin} 的托管进程 ${id} 空闲 ${def.stopAfterIdleMin} 分钟，已停`)
        stopService(plugin, id)
      }
    }
    if (!running.size && idleTimer) {
      clearInterval(idleTimer)
      idleTimer = undefined
    }
  }, 60_000)
  idleTimer.unref?.()
}

/**
 * 开着的插件变了（declared-sync.ts 调）：不在列表里的插件的进程停掉，清单里不再有的进程停掉，
 * 新开的插件里 start = on-load 的起来。参数变了的进程不自动重启（下次打开页面或用户点重启时按新参数起）
 */
export async function syncServices(enabled: Installed[], config: (id: string) => PluginConfig) {
  known.clear()
  for (const p of enabled)
    if (p.manifest.services.length) known.set(p.manifest.id, { p, config: config(p.manifest.id) })
  for (const key of [...running.keys()]) {
    const [plugin, id] = key.split('/')
    if (!known.get(plugin)?.p.manifest.services.some((s) => s.id === id)) stopService(plugin, id)
  }
  for (const [plugin, k] of known)
    for (const def of k.p.manifest.services)
      if (def.start === 'on-load' && !running.has(keyOf(plugin, def.id)))
        void startService(plugin, def.id).catch((e) =>
          log.warn('plugin', `插件 ${plugin} 的托管进程 ${def.id} 没起来`, { error: (e as Error).message }),
        )
}
