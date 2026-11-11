import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { t } from '../../shared/i18n.ts'
import type { PluginConfig } from '../../shared/plugins/types.ts'
import type { ActivateServer, McpCallContext, PluginRun, ServerPlugin } from './sdk.ts'
import { log } from '../log.ts'
import { closePluginMcp, openPluginMcp } from './mcp.ts'
import { pluginDataDir, type Installed } from './store.ts'

/**
 * 插件的服务端部分在面板进程里跑（ADR 0059）：插件打开时 import 包里的 server 入口、调 activate，
 * 关掉、删除、升级、参数要求重启时调 stop。入口报错只影响这个插件：错误记下来显示在插件页上，面板照常。
 */
interface Active {
  key: string
  plugin: ServerPlugin
  cfg: PluginConfig
}
const active = new Map<string, Active>()
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
  const mod = (await import(
    `${pathToFileURL(entry).href}?v=${encodeURIComponent(p.installedAt || p.manifest.version)}`
  )) as {
    default?: ActivateServer
  }
  if (typeof mod.default !== 'function') throw new Error(`${p.manifest.server} 没有默认导出 activate`)
  const plugin = await mod.default({
    id,
    version: p.manifest.version,
    dir: p.dir,
    dataDir,
    config,
    log: {
      info: (msg, data) => log.info(`plugin:${id}`, msg, data),
      warn: (msg, data) => log.warn(`plugin:${id}`, msg, data),
    },
    t,
  })
  active.set(id, { key: keyOf(p), plugin, cfg: config() })
  log.info('plugin', `已启动插件 ${p.manifest.name}`, { id, version: p.manifest.version })
}

export async function stopPlugin(id: string) {
  const a = active.get(id)
  active.delete(id)
  closePluginMcp(id)
  if (!a) return
  try {
    await a.plugin.stop?.()
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
    restart = !!(await a.plugin.onConfig?.(next, prev))
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

/** 插件页上的运行状态 */
export async function pluginStatus(id: string) {
  const p = active.get(id)?.plugin
  if (!p?.status) return undefined
  try {
    return await p.status()
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/**
 * 一轮对话开始：问每个开着的插件要不要挂工具，要的开 MCP 会话（令牌只在这一轮有效）。
 * 插件出错不拦对话：记日志、这一轮不挂它的工具
 */
export async function pluginToolsForRun(run: PluginRun, confirm?: McpCallContext['confirm']) {
  const servers: { name: string; url: string }[] = []
  const hints: string[] = []
  const closers: (() => void)[] = []
  for (const [id, a] of active) {
    if (!a.plugin.tools) continue
    try {
      const r = await a.plugin.tools(run)
      if (!r) continue
      for (const s of r.servers) {
        const m = openPluginMcp(id, s.name, run.taskId, s.tools, confirm)
        servers.push({ name: m.name, url: m.url })
        closers.push(m.close)
      }
      if (r.hint) hints.push(r.hint)
    } catch (e) {
      log.warn('plugin', `插件给对话挂工具时出错：${id}`, { error: (e as Error).message })
    }
  }
  return { servers, hint: hints.join('\n\n'), close: () => closers.forEach((c) => c()) }
}
