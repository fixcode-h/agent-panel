import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { t } from '../../shared/i18n.ts'
import type { PluginConfig } from '../../shared/plugins/types.ts'
import type { ActivateServer, McpCallContext, PluginAction, PluginRun, ServerPlugin } from './sdk.ts'
import { log } from '../log.ts'
import { withPluginLimit } from './limit.ts'
import { closePluginMcp, openPluginMcp, type PluginRunHooks } from './mcp.ts'
import { pluginDataDir, type Installed } from './store.ts'

/**
 * 插件的服务端部分在面板进程里跑（ADR 0059）：插件打开时 import 包里的 server 入口、调 activate，
 * 关掉、删除、升级、参数要求重启时调 stop。入口报错只影响这个插件：错误记下来显示在插件页上，面板照常。
 */
interface Active {
  key: string
  /** 插件的显示名：对话里的警告行要写明是哪个插件 */
  name: string
  plugin: ServerPlugin
  cfg: PluginConfig
}
const active = new Map<string, Active>() // 模块状态：会话，跟着进程或连接一起没
const errors = new Map<string, string>()

/** 同一个包重装、升级后要重新 import：按安装时间区分模块地址，ESM 缓存里的旧版本不会被拿来用 */
const keyOf = (p: Installed) => `${p.dir}|${p.installedAt}|${p.manifest.version}`

export const pluginError = (id: string) => errors.get(id) ?? ''

async function start(p: Installed, config: () => PluginConfig) {
  const id = p.manifest.id
  if (!p.manifest.server) return
  const entry = path.join(p.dir, p.manifest.server)
  const dataDir = pluginDataDir(id)
  await mkdir(dataDir, { recursive: true })
  // 开放给插件的面板模块（插件接口 4）：插件入口里的 import 在模块加载时就要取到，所以先挂上
  ;(await import('./host-modules.ts')).exposeHostModules()
  const mod = (await import(
    `${pathToFileURL(entry).href}?v=${encodeURIComponent(p.installedAt || p.manifest.version)}`
  )) as {
    default?: ActivateServer
  }
  if (typeof mod.default !== 'function') throw new Error(`${p.manifest.server} 没有默认导出 activate`)
  const activate = mod.default
  const plugin = await withPluginLimit('activate', () =>
    activate({
      id,
      version: p.manifest.version,
      previousVersion: p.previousVersion,
      dir: p.dir,
      dataDir,
      config,
      log: {
        info: (msg, data) => log.info(`plugin:${id}`, msg, data),
        warn: (msg, data) => log.warn(`plugin:${id}`, msg, data),
      },
      t,
    }),
  )
  active.set(id, { key: keyOf(p), name: p.manifest.name, plugin, cfg: config() })
  log.info('plugin', `已启动插件 ${p.manifest.name}`, { id, version: p.manifest.version })
}

export async function stopPlugin(id: string) {
  const a = active.get(id)
  active.delete(id)
  closePluginMcp(id)
  if (!a) return
  try {
    if (a.plugin.stop) await withPluginLimit('stop', () => a.plugin.stop!())
  } catch (e) {
    log.warn('plugin', `插件停止时出错：${id}`, { error: (e as Error).message })
  }
}

/** 让运行中的插件和「装着且开着」的列表一致：多的停掉，少的启动，包换了的重启 */
export async function syncRuntime(
  list: Installed[],
  on: (id: string) => boolean,
  config: (id: string) => PluginConfig,
) {
  const want = new Map(list.filter((p) => on(p.manifest.id)).map((p) => [p.manifest.id, p]))
  for (const id of [...active.keys()]) {
    const p = want.get(id)
    if (!p || keyOf(p) !== active.get(id)!.key) await stopPlugin(id)
  }
  for (const id of [...errors.keys()]) if (!want.has(id)) errors.delete(id)
  for (const [id, p] of want) {
    if (active.has(id) || !p.manifest.server) continue
    try {
      errors.delete(id)
      await start(p, () => config(id))
    } catch (e) {
      errors.set(id, (e as Error).message)
      log.warn('plugin', `插件启动失败：${id}`, { error: (e as Error).message })
    }
  }
}

/** 参数改了：插件说要重启就 stop 再 start */
export async function pluginConfigChanged(p: Installed, next: PluginConfig, config: () => PluginConfig) {
  const a = active.get(p.manifest.id)
  if (!a) return
  const prev = a.cfg
  a.cfg = next
  let restart = false
  try {
    if (a.plugin.onConfig) restart = !!(await withPluginLimit('onConfig', () => a.plugin.onConfig!(next, prev)))
  } catch (e) {
    log.warn('plugin', `插件处理参数变化出错：${p.manifest.id}`, { error: (e as Error).message })
  }
  if (!restart) return
  await stopPlugin(p.manifest.id)
  try {
    await start(p, config)
  } catch (e) {
    errors.set(p.manifest.id, (e as Error).message)
  }
}

export const runningPlugin = (id: string) => active.get(id)?.plugin

/** 开着的插件里认领了这个扩展名（小写、不带点）的文本化接口；按插件启动先后取第一个 */
export function textifierFor(ext: string) {
  for (const [id, a] of active) {
    const tx = a.plugin.textify
    if (tx?.exts.some((e) => e.toLowerCase() === ext)) return { id, text: tx.text }
  }
  return undefined
}

/** 开着的插件登记的面板动作（插件接口 6）：动作表每次现取，插件关掉就没了 */
export function pluginActions(): PluginAction[] {
  return [...active.values()].flatMap((a) => a.plugin.actions ?? [])
}

/** 插件页上的运行状态 */
export async function pluginStatus(id: string) {
  const p = active.get(id)?.plugin
  if (!p?.status) return undefined
  try {
    return await withPluginLimit('status', () => p.status!())
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** 一个插件这一轮没挂上工具：对话里要写一行警告（硬规则：错误显示给用户，不只写日志） */
export interface PluginToolError {
  id: string
  name: string
  error: string
}

/**
 * 一轮对话开始：问每个开着的插件要不要挂工具，要的开 MCP 会话（令牌只在这一轮有效）。
 * 插件出错、超时不拦对话：这一轮不挂它的工具，错误交回 runner 在对话里写警告行。
 * 各插件同时问（限时见 limit.ts），一个插件慢不叠加到别的插件上
 */
export async function pluginToolsForRun(run: PluginRun, confirm?: McpCallContext['confirm'], hooks?: PluginRunHooks) {
  const servers: { name: string; url: string }[] = []
  const hints: string[] = []
  const closers: (() => void)[] = []
  const errors: PluginToolError[] = []
  const notices: { name: string; text: string }[] = []
  const asked = [...active].filter(([, a]) => a.plugin.tools)
  const answers = await Promise.allSettled(asked.map(([, a]) => withPluginLimit('tools', () => a.plugin.tools!(run))))
  for (const [i, [id, a]] of asked.entries()) {
    const ans = answers[i]!
    if (ans.status === 'rejected') {
      const error = (ans.reason as Error)?.message ?? String(ans.reason)
      errors.push({ id, name: a.name, error })
      log.warn('plugin', `插件给对话挂工具时出错：${id}`, { error })
      continue
    }
    try {
      const r = ans.value
      if (!r) continue
      for (const s of r.servers) {
        const m = openPluginMcp(id, s.name, run.taskId, s.tools, confirm, hooks)
        servers.push({ name: m.name, url: m.url })
        closers.push(m.close)
      }
      if (r.hint) hints.push(r.hint)
      for (const text of r.notices ?? []) if (String(text).trim()) notices.push({ name: a.name, text: String(text) })
    } catch (e) {
      errors.push({ id, name: a.name, error: (e as Error).message })
      log.warn('plugin', `插件给对话挂工具时出错：${id}`, { error: (e as Error).message })
    }
  }
  return { servers, hint: hints.join('\n\n'), errors, notices, close: () => closers.forEach((c) => c()) }
}
