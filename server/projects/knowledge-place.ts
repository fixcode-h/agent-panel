/**
 * 项目教训、经验存在哪（用户 2026-11-20 定：默认随仓库，项目设置里可切到数据目录；取代 2026-11-15 复查报告 B5 的「默认数据目录」）。
 * 默认放项目文档目录（server/projects/lessons.ts 的 projectDocBase，Git 项目是 docs/），随代码提交。
 * 项目设置里关掉「随仓库」时放 <数据目录>/knowledge/<项目 id>/，不往用户仓库里写文件。旧项目的取值由迁移 0013 定。
 * 项目没有目录（独立聊天、没填路径）时两种都不用，调用方仍存回项目 JSON
 */
import path from 'node:path'
import type { Agent, Project } from '../../shared/schema.ts'
import { DATA_DIR } from '../store.ts'

export type KnowledgeProject = Pick<Project, 'id' | 'path' | 'agentParams' | 'knowledgeInRepo'>

/** 数据目录里这个项目的知识目录 */
export const dataKnowledgeDir = (projectId: string, dataDir = DATA_DIR) =>
  path.join(dataDir, 'knowledge', projectId.replace(/[^A-Za-z0-9_-]/g, '_'))

/** 教训、经验目录的上一层和它在不在仓库里；没有目录时返回 undefined */
export async function knowledgeBase(
  project: KnowledgeProject,
  agents: Agent[],
  docBase: (p: KnowledgeProject, agents: Agent[]) => Promise<string | undefined>,
): Promise<{ base: string; inRepo: boolean } | undefined> {
  if (!project.path?.trim()) return undefined
  if (!project.knowledgeInRepo) return { base: dataKnowledgeDir(project.id), inRepo: false }
  const base = await docBase(project, agents)
  return base ? { base, inRepo: true } : undefined
}
