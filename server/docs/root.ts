import { resolveParams } from '../../shared/agent-role.ts'
import { findCore } from '../../shared/builtin/core.ts'
import { DOC_PLACE_SIBLING, isDocVcs, isInside, resolveDocRoot, type DocRootInfo } from '../../shared/doc-root.ts'
import type { Agent } from '../../shared/schema.ts'
import { resolveDocGroup } from './group.ts'
import { log } from '../log.ts'
import { detectVcs } from '../projects-analyze.ts'

/**
 * 这个项目的文档根（只算 P4 / SVN 项目，见 shared/doc-root.ts）：按「文档」角色的参数（agents 已经套上项目里填的值）
 * 和项目目录现在的版本管理算。算不出来（目录读不到、不是 P4 / SVN）返回 undefined，提示词里就不写这一段。
 * 文档根在项目外（默认）时换成文档组的共用文档根（server/docs/group.ts）：同一工程的各分支读写同一份文档
 */
export async function projectDocRoot(projectPath: string | undefined, agents: Agent[], vcs?: string) {
  if (!projectPath) return undefined
  const kind = vcs ?? (await detectVcs(projectPath).catch(() => null))?.vcs
  const doc = findCore(agents, 'docsync')
  const values = doc ? resolveParams(doc.params).values : {}
  const d = resolveDocRoot(projectPath, kind, values)
  if (!d || d.place !== DOC_PLACE_SIBLING) return d satisfies DocRootInfo | undefined
  try {
    const g = await resolveDocGroup(projectPath, d.vcs)
    return {
      ...d,
      root: g.root,
      outside: !isInside(g.root, projectPath),
      branch: g.branch,
      branchDir: g.branchDir,
      ...(g.conflicts.length > 0 && { conflicts: g.conflicts }),
    } satisfies DocRootInfo
  } catch (e) {
    // 文档组记录读写失败时退回按目录算的旧位置，不让对话因此起不来；错误进日志
    log.warn('docs', '文档组算不出来，先用旧的文档根', { projectPath, error: (e as Error).message })
    return d
  }
}

/**
 * P4 / SVN 项目各分支共用的文档根，不看「文档根」下拉：项目教训固定放这里（ADR 0039、0052），
 * 选了「项目内 docs」的项目教训也和其他分支共用。不是 P4 / SVN 时返回 undefined
 */
export async function sharedDocRoot(projectPath: string, vcs: string | undefined) {
  if (!isDocVcs(vcs)) return undefined
  return (await resolveDocGroup(projectPath, vcs)).root
}
