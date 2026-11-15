import { CLIS } from '../../shared/clis.ts'
import type { LibraryEntry } from '../mcp-library/file.ts'
import { loadProjectMcp } from '../mcp-library/file.ts'
import { activePlugins } from './declared-env.ts'
import { resolvedMcp } from './declared-resolve.ts'

/**
 * 插件声明的外部 MCP 服务（插件接口 11 的 mcp）：不进插件进程，也不改 CLI 的全局配置，
 * 和 MCP 库的「按项目」条目一样每轮注入（shared/mcp-library/inject.ts）。关掉、删掉插件时什么都不用撤。
 * CLI 定义里没写 mcpStore.inject 的（Pi）只能退回全局写入，见 declared-sync.ts
 */

/** 这一轮要注入的插件 MCP：用户 MCP 库里同名的以用户的为准，两个插件同名的先到先得 */
export async function pluginMcpForRun(projectId: string | undefined, taken: string[]): Promise<LibraryEntry[]> {
  const names = new Set(taken)
  const lib = await loadProjectMcp()
  const clis = CLIS.filter((d) => d.mcpStore?.inject).map((d) => d.id)
  const out: LibraryEntry[] = []
  for (const p of await activePlugins(projectId))
    for (const sv of await resolvedMcp(p)) {
      if (names.has(sv.name) || lib[sv.name]) continue
      names.add(sv.name)
      out.push({ server: sv, clis })
    }
  return out
}
