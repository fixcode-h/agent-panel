/**
 * 项目目录里自带的 MCP 自动导入并在这个项目里打开（用户 2026-11-17 定）：
 * 读到项目目录里有 MCP 配置（.mcp.json、.cursor/mcp.json…，见 ./mcp.ts 的 SOURCES），默认导入成「按项目」的条目
 * （面板库 config/mcp-library.json），并在这个项目的能力里打开（capabilities.mcp）。
 *
 * 每个项目每个名字只自动处理一次，处理过的记在数据目录 config/project-mcp-auto.json：
 * 用户之后在项目里关掉、或者在 MCP 页删掉，都不会被再打开（用户定：手动关掉的不再自动启用）。
 * 记在单独的文件而不是项目记录里：项目设置是整份保存的，界面上的旧快照不该把这份记录冲掉。
 *
 * 只管项目目录里的文件。Agent 自己配置里的（例如 Claude Code 只对这个项目生效的那份）只识别出来列为可导入，
 * 不自动导入，见 ./mcp.ts。
 */
import { z } from 'zod'
import type { ProjectMcpDetected } from '../../shared/projects/mcp.ts'
import { sameServer } from '../../shared/mcp-library/inject.ts'
import { McpServer } from '../../shared/library.ts'
import { dataPath, readJson, writeJsonAtomic } from '../store.ts'
import { mcpOverview, saveMcpEntry } from '../mcp-store.ts'

const FILE = () => dataPath('config/project-mcp-auto.json')
const AutoFile = z.object({ projects: z.record(z.string(), z.array(z.string())).default({}) })

async function loadSeen(): Promise<Record<string, string[]>> {
  const p = AutoFile.safeParse((await readJson(FILE())) ?? {})
  return p.success ? p.data.projects : {}
}

/** 手动导入、自动导入都记一下：之后这个名字在这个项目里由用户说了算 */
export async function markSeen(projectId: string, names: string[]) {
  if (!projectId || !names.length) return
  const all = await loadSeen()
  const cur = all[projectId] ?? []
  const next = [...new Set([...cur, ...names])]
  if (next.length === cur.length) return
  all[projectId] = next
  await writeJsonAtomic(FILE(), { projects: all })
}

/** 自动导入的结果：imported 是新建了按项目条目的，enabled 是这次在项目里打开的（含已有同样配置、只差打开的） */
export interface AutoImportResult {
  imported: string[]
  enabled: string[]
}

// 同一时间只跑一份：侧栏、项目页可能同时读同一个项目，两边都导入会把同一条写两遍
// 模块状态：运行时，只是串行化的队列，重启后从空队列开始没事
let queue: Promise<unknown> = Promise.resolve()

/**
 * 按项目目录里识别到的配置自动导入、打开。
 * enable 把名字加进项目的 capabilities.mcp（server/index.ts 注入，项目记录只在那边改）。
 * 跳过的情况：名字不合规（要用户改名）、已经处理过、全局已有同名（已经对所有项目生效）、
 * 面板库里有同名但配置不同（不替用户选哪份，留在列表里让用户自己导入）
 */
export function autoImportProjectMcp(
  projectId: string,
  detected: ProjectMcpDetected[],
  enable: (projectId: string, names: string[]) => Promise<void>,
): Promise<AutoImportResult> {
  const run = queue.then(() => doImport(projectId, detected, enable))
  queue = run.catch(() => {})
  return run
}

async function doImport(
  projectId: string,
  detected: ProjectMcpDetected[],
  enable: (projectId: string, names: string[]) => Promise<void>,
): Promise<AutoImportResult> {
  const out: AutoImportResult = { imported: [], enabled: [] }
  if (!projectId || !detected.length) return out
  const seen = new Set((await loadSeen())[projectId] ?? [])
  const todo = detected.filter((d) => d.nameOk && !d.fromAgent && !seen.has(d.name))
  if (!todo.length) return out
  const overview = await mcpOverview()
  const allClis = overview.clis.map((c) => c.id)
  const handled: string[] = []
  for (const d of todo) {
    // 同一个名字在几个文件里都有：按 SOURCES 的顺序第一份为准
    if (handled.includes(d.name)) continue
    const cur = overview.servers.find((s) => s.name === d.name)
    const sv = McpServer.safeParse({ ...d.server, name: d.name })
    if (!sv.success) continue
    if (cur?.activation === 'global') {
      handled.push(d.name)
      continue
    }
    if (cur && !sameServer(cur, sv.data)) continue
    if (!cur) {
      await saveMcpEntry(sv.data, allClis, 'project')
      out.imported.push(d.name)
    }
    out.enabled.push(d.name)
    handled.push(d.name)
  }
  if (out.enabled.length) await enable(projectId, out.enabled)
  await markSeen(projectId, handled)
  return out
}
