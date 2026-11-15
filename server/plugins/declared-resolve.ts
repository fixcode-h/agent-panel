import type { McpServer } from '../../shared/library.ts'
import { pluginConfig, type PluginConfig } from '../../shared/plugins/index.ts'
import { fillPlaceholders } from '../../shared/plugins/placeholders.ts'
import { getSettings } from '../settings.ts'
import { pluginDataDir, type Installed } from './store.ts'

/** 插件接口 11 清单值里的占位符怎么取值（shared/plugins/placeholders.ts），env、mcp、services 共用 */

/** 一个插件的占位符取值；config 不给时按当前设置取 */
export async function placeholderVars(p: Installed, config?: PluginConfig) {
  const c = config ?? pluginConfig((await getSettings()).plugins, p.manifest.id)
  return { config: c, dir: p.dir, data: pluginDataDir(p.manifest.id) }
}

/** 值里的占位符换掉；命令、参数、环境变量、地址、请求头都能用 */
export async function resolvedMcp(p: Installed, config?: PluginConfig): Promise<McpServer[]> {
  const v = await placeholderVars(p, config)
  const f = (x: string) => fillPlaceholders(x, v)
  const map = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, f(x)]))
  return p.manifest.mcp.map((sv) => ({
    ...sv,
    command: f(sv.command),
    args: sv.args.map(f),
    env: map(sv.env),
    url: f(sv.url),
    headers: map(sv.headers),
  }))
}
