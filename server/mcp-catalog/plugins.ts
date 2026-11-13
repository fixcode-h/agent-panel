/**
 * 插件这一侧的能力目录和自检（设置 →「MCP」，插件接口 8）。
 * - 目录：问插件的 catalog()；旧插件没有时只能按清单的 mcpServers / toolNames 列出名字，标成 legacy。
 * - 自检：拿一个预演的 run（dryRun: true）问插件的 tools(run)，插件按真实规则回答挂不挂、挂哪些，
 *   不挂时可以给原因（skip）。和对话里一样有限时（limit.ts），出错、超时照原文显示。
 */
import { activePlugins, pluginToolNames } from '../../shared/plugins/index.ts'
import type { PluginManifest } from '../../shared/plugins/types.ts'
import { describeTool, paramsOf } from '../../shared/mcp-catalog/describe.ts'
import type {
  CatalogServer,
  CatalogSource,
  CatalogTool,
  McpCheckRow,
  ToolEffect,
} from '../../shared/mcp-catalog/types.ts'
import { t } from '../../shared/i18n.ts'
import { withPluginLimit } from '../plugins/limit.ts'
import { pluginError, runningPlugins } from '../plugins/runtime.ts'
import type { McpTool, PluginRun, ServerPlugin } from '../plugins/sdk.ts'
import { actionRow } from './panel.ts'

type ToolDef = Omit<McpTool, 'call' | 'targets'>

/** 工具的徽标：声明的 effect 加上「会请你确认」「不可撤回」 */
function effectsOf(x: ToolDef): ToolEffect[] {
  const out: ToolEffect[] = [x.effect ?? 'read']
  if (x.confirms) out.push('confirm')
  if (x.irreversible) out.push('danger')
  return out
}

export function pluginToolRow(m: PluginManifest, x: ToolDef): CatalogTool {
  return {
    name: x.name,
    title: x.guide?.title || pluginToolNames(m)[x.name] || x.name,
    ...(x.guide && { guide: x.guide }),
    effects: effectsOf(x),
    description: describeTool(x.description, x.guide),
    params: paramsOf(x.inputSchema),
  }
}

/**
 * 旧插件（没有 catalog）：只能按清单列出服务和工具名。清单的 toolNames 不分服务，
 * 有几个服务（Blender 的 blender、blender-model）时合成一块列一次，不能每个服务各列一遍全部工具
 */
export function legacyServers(m: PluginManifest): CatalogServer[] {
  const names = pluginToolNames(m)
  const tools = Object.entries(names).map(([n, title]) => ({
    name: n,
    title,
    effects: [],
    description: '',
    params: [],
  }))
  if (!m.mcpServers.length && !tools.length) return []
  return [
    {
      name: m.mcpServers.join(', ') || m.id,
      summary: '',
      attach: t('插件没有提供能力目录（插件接口 8 以前），只能列出名字；升级插件后会补上说明'),
      tools,
    },
  ]
}

async function catalogServers(m: PluginManifest, plugin: ServerPlugin): Promise<CatalogServer[]> {
  const cat = await withPluginLimit('tools', () => plugin.catalog!())
  return Promise.all(
    cat.servers.map(async (s) => {
      try {
        const tools = await withPluginLimit('tools', async () => s.tools())
        return {
          name: s.name,
          summary: s.summary,
          attach: s.attach,
          hint: s.hint,
          tools: tools.map((x) => pluginToolRow(m, x)),
        }
      } catch (e) {
        return {
          name: s.name,
          summary: s.summary,
          attach: s.attach,
          hint: s.hint,
          tools: [],
          error: (e as Error).message,
        }
      }
    }),
  )
}

/** 开着的插件各一个来源；插件登记的面板动作也归在自己名下 */
export async function pluginSources(): Promise<{ sources: CatalogSource[]; actionNames: Set<string> }> {
  const running = new Map(runningPlugins().map((r) => [r.id, r]))
  const actionNames = new Set<string>()
  const sources = await Promise.all(
    activePlugins().map(async (m): Promise<CatalogSource> => {
      const r = running.get(m.id)
      const actions = (r?.plugin.actions ?? []).map(actionRow)
      for (const a of actions) actionNames.add(a.name)
      const base = { id: `plugin:${m.id}`, kind: 'plugin' as const, name: m.name, version: m.version, icon: m.icon }
      const summary = m.description
      if (!r) return { ...base, summary, servers: legacyServers(m), actions, error: pluginError(m.id) || undefined }
      if (!r.plugin.catalog) return { ...base, summary, servers: legacyServers(m), actions, legacy: true }
      try {
        return { ...base, summary, servers: await catalogServers(m, r.plugin), actions }
      } catch (e) {
        return { ...base, summary, servers: legacyServers(m), actions, error: (e as Error).message }
      }
    }),
  )
  return { sources, actionNames }
}

/** 自检：每个开着、有工具的插件一行 */
export async function pluginCheckRows(run: PluginRun): Promise<McpCheckRow[]> {
  const byId = new Map(activePlugins().map((m) => [m.id, m]))
  const rows: McpCheckRow[] = []
  for (const r of runningPlugins()) {
    const m = byId.get(r.id)
    if (!m) continue
    const actions = r.plugin.actions?.length ?? 0
    // 只有面板动作、没有工具的插件（表格）：动作和面板自己的动作同一个条件
    if (!r.plugin.tools) {
      if (actions)
        rows.push({
          source: `plugin:${m.id}`,
          name: m.name,
          server: 'app_do',
          state: run.conversation ? 'on' : 'off',
          count: run.conversation ? actions : 0,
          reason: run.conversation
            ? t('{n} 个面板动作，经 app_actions / app_do 调', { n: actions })
            : t('派出的子任务和工作流节点没有操控软件的动作'),
        })
      continue
    }
    const server = m.mcpServers.join(', ') || m.id
    try {
      const ans = await withPluginLimit('tools', async () => r.plugin.tools!(run))
      if (!ans || 'skip' in ans) {
        rows.push({
          source: `plugin:${m.id}`,
          name: m.name,
          server,
          state: 'off',
          count: 0,
          reason: ans?.skip ? t('不挂：{why}', { why: ans.skip }) : t('不挂（插件没说明原因）'),
        })
        continue
      }
      for (const s of ans.servers) {
        const tools = await withPluginLimit('tools', async () => s.tools())
        rows.push({
          source: `plugin:${m.id}`,
          name: m.name,
          server: s.name,
          state: 'on',
          count: tools.length,
          reason: ans.hint
            ? t('挂上 {n} 个；新会话开头附用法说明', { n: tools.length })
            : t('挂上 {n} 个', { n: tools.length }),
        })
      }
    } catch (e) {
      rows.push({
        source: `plugin:${m.id}`,
        name: m.name,
        server,
        state: 'error',
        count: 0,
        reason: (e as Error).message,
      })
    }
  }
  return rows
}

/** 挂上了、但有工具没写使用时机的来源 */
export function missingGuides(sources: CatalogSource[], on: Set<string>) {
  return sources
    .filter((s) => on.has(s.id))
    .map((s) => ({
      source: s.id,
      name: s.name,
      count: s.servers.flatMap((x) => x.tools).filter((x) => !x.guide).length,
    }))
    .filter((x) => x.count > 0)
}
