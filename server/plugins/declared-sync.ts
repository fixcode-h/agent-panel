import type { McpServer } from '../../shared/library.ts'
import type { PluginConfig } from '../../shared/plugins/index.ts'
import { loadProjectMcp } from '../mcp-library/file.ts'
import { syncFallbackServers } from '../mcp-store.ts'
import { log } from '../log.ts'
import { dataPath, readJson, writeJsonAtomic } from '../store.ts'
import { resolvedMcp } from './declared-resolve.ts'
import { syncServices } from './services.ts'
import type { Installed } from './store.ts'

/**
 * 插件装删开关、参数改了之后（manager.ts 在 syncRuntime 之后调）同步插件接口 11 里要「落地」的两样：
 * - mcp 退回全局写入：CLI 定义里没写 mcpStore.inject 的（Pi）没法每轮注入，开着的插件的 MCP 写进它的全局配置，
 *   不再开着的删掉。按项目的插件也写（全局写入没法分项目），和 MCP 库按项目条目的退回方式一致，界面上注明。
 *   写过什么记在 config/plugin-mcp-fallback.json，下次只删自己写的；
 * - 托管进程：关掉、删掉的插件的进程停掉，开着的插件里 start = on-load 的起来（services.ts）
 */
export async function syncDeclared(
  list: Installed[],
  on: (id: string) => boolean,
  config: (id: string) => PluginConfig,
) {
  const enabled = list.filter((p) => on(p.manifest.id))
  await syncPluginMcpFallback(enabled, config)
  await syncServices(enabled, config)
}

const FALLBACK_FILE = () => dataPath('config/plugin-mcp-fallback.json')

/**
 * 插件装删开关、参数改了之后调：开着的插件的 MCP 写进只能全局写入的 CLI，不再开着的删掉。
 * 按项目的插件也写（全局写入没法分项目），和 MCP 库按项目条目的退回方式一致，界面上注明
 */
async function syncPluginMcpFallback(on: Installed[], config: (id: string) => PluginConfig) {
  const prev = ((await readJson(FALLBACK_FILE())) as { servers?: McpServer[] } | undefined)?.servers ?? []
  const want: McpServer[] = []
  const lib = await loadProjectMcp()
  for (const p of on)
    for (const sv of await resolvedMcp(p, config(p.manifest.id)))
      if (!lib[sv.name] && !want.some((w) => w.name === sv.name)) want.push(sv)
  if (!want.length && !prev.length) return
  try {
    const written = await syncFallbackServers(want, prev)
    await writeJsonAtomic(FALLBACK_FILE(), { servers: written })
  } catch (e) {
    log.warn('plugin', '插件的 MCP 服务没能写进只能全局配置的 CLI', { error: (e as Error).message })
  }
}
