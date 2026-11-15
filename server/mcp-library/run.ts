/**
 * 每轮对话要带上的「按项目」MCP 条目：项目「能力」里打开了（capabilities.mcp）、存在面板库里的那些。
 * 按 CLI 过滤、换成参数在 invoke 里做（shared/mcp-library/inject.ts），这里只按项目挑。
 * 没有项目（Chat）时不带：Chat 默认只有面板自带的工具
 */
import type { Project } from '../../shared/schema.ts'
import { loadProjectMcp, type LibraryEntry } from './file.ts'

export async function projectMcpForRun(project: Pick<Project, 'capabilities'> | undefined): Promise<LibraryEntry[]> {
  const on = project?.capabilities?.mcp ?? []
  if (!on.length) return []
  const lib = await loadProjectMcp()
  return on.map((name) => lib[name]).filter((e): e is LibraryEntry => !!e)
}
