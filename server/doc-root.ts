import { resolveParams } from '../shared/agent-role.ts'
import { findCore } from '../shared/builtin/core.ts'
import { resolveDocRoot, type DocRootInfo } from '../shared/doc-root.ts'
import type { Agent } from '../shared/schema.ts'
import { detectVcs } from './projects-analyze.ts'

/**
 * 这个项目的文档根（只算 P4 / SVN 项目，见 shared/doc-root.ts）：按「文档」角色的参数（agents 已经套上项目里填的值）
 * 和项目目录现在的版本管理算。算不出来（目录读不到、不是 P4 / SVN）返回 undefined，提示词里就不写这一段
 */
export async function projectDocRoot(projectPath: string | undefined, agents: Agent[], vcs?: string) {
  if (!projectPath) return undefined
  const kind = vcs ?? (await detectVcs(projectPath).catch(() => null))?.vcs
  const doc = findCore(agents, 'docsync')
  const values = doc ? resolveParams(doc.params).values : {}
  return resolveDocRoot(projectPath, kind, values) satisfies DocRootInfo | undefined
}
