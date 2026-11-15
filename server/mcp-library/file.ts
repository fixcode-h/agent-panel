/**
 * 「按项目」的 MCP 条目存在面板自己的数据目录（config/mcp-library.json）：它们不再写进各 CLI 的全局配置，
 * 不然所有项目都会加载（设计稿 Agent侧栏与项目管理重设计 6.2）。「全局」的条目照旧只在 CLI 配置里，面板不另存。
 * 只有 server/mcp-store.ts（增删改）和 ./run.ts（每轮注入）读写这里
 */
import { z } from 'zod'
import { McpServer } from '../../shared/library.ts'
import { dataPath, readJson, writeJsonAtomic } from '../store.ts'

const FILE = () => dataPath('config/mcp-library.json')

export const LibraryEntry = z.object({
  server: McpServer,
  /** 交给哪些 CLI：能每轮注入的按项目注入，不能的退回全局写入 */
  clis: z.array(z.string()).default([]),
})
export type LibraryEntry = z.infer<typeof LibraryEntry>

const LibraryFile = z.object({ servers: z.record(z.string(), LibraryEntry).default({}) })

/** 读不懂的条目跳过（不让一条坏数据拖垮整个 MCP 页），文件不在就是空的 */
export async function loadProjectMcp(): Promise<Record<string, LibraryEntry>> {
  const raw = (await readJson(FILE())) as { servers?: Record<string, unknown> } | undefined
  const out: Record<string, LibraryEntry> = {}
  for (const [name, v] of Object.entries(raw?.servers ?? {})) {
    const p = LibraryEntry.safeParse(v)
    if (p.success && p.data.server.name === name) out[name] = p.data
  }
  return out
}

export async function saveProjectMcp(servers: Record<string, LibraryEntry>) {
  await writeJsonAtomic(FILE(), LibraryFile.parse({ servers }))
}
