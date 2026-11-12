// 一轮执行交给引擎的「版本管理」类能力（重构文档第 3、5 条：从 createRun 的 start 里拆出来，按 EngineHost 的小接口分组）。
import type { RealContext } from '../exec/real-context.ts'
import { statSync } from 'node:fs'
import path from 'node:path'
import { holderState, ownP4Files, releaseUnchanged } from '../claims.ts'
import { p4Runner, splitChangelists } from '../p4-split.ts'
import { projectDocRoot } from '../docs/root.ts'
import { cherryPickFor } from '../cherry-pick.ts'
import { currentBranch } from '../exec/worktree.ts'
import { isGit, isolated, isP4 } from './helpers.ts'

import type { TurnCapsCtx } from './turn-caps-conv.ts'

/** 版本管理和改文件的能力：独立分支、P4 分 changelist、cherry-pick、子对话收尾、就地微改动、文件认领 */
export async function vcsCaps(c: TurnCapsCtx) {
  const { sc, entry, task, project, found, agents, dir, rootId, coordinatorRole, ueRole, startAgent, changed } = c
  return {
    worktreeHome: isolated(entry.task) && found ? await sc.worktreeHome(entry.task, found) : undefined,
    // P4 项目里的对话和节点都能用：分 changelist 由面板照类型执行，不靠 Agent 自己记得分（见 p4-split.ts）
    p4Split:
      dir && project?.path && (await isP4(project.path))
        ? async (input) => {
            // 项目外的文档根里的文件不分（见 shared/doc-root.ts）：分之前现算，项目设置改了下一次就按新的
            const docs = await projectDocRoot(project.path, agents, 'p4')
            // 共用目录的子对话和兄弟在同一个 workspace、同一个 default changelist：没写 files 时只分它名下的认领和改过的文件，
            // 否则会把兄弟打开的文件一起分进它的 changelist
            const isDir = (p: string) => !!statSync(path.join(dir, p), { throwIfNoEntry: false })?.isDirectory()
            const own = input.files?.length ? [] : ownP4Files(sc.claims, entry.task, isDir)
            const opts = docs?.outside ? { skipUnder: docs.root } : {}
            return splitChangelists(p4Runner(dir), own.length ? { ...input, files: own } : input, opts)
          }
        : undefined,
    // 项目设了 cherry-pick 目标的顶层对话：由面板核对后搬，只收这个对话自己的提交 / 改动（用户 2026-10-31 定的强制要求）
    cherryPick:
      !task.parentTaskId && dir && project?.path && project.cherryPick?.trim()
        ? await cherryPickFor(dir, project.path, project.cherryPick.trim(), () => entry.task)
        : undefined,
    // 不管用哪种版本管理，子对话都要请父对话收尾：评审、测试、交接和父对话验收挂在这一步上（独立分支还要合回）
    submitMerge:
      task.parentTaskId && task.projectId
        ? (note, tests, build, handoff, triage, override) =>
            sc.submitMerge(task.id, note, tests, ueRole === 'child' && build !== false, handoff, triage, override)
        : undefined,
    isolated: !!task.parentTaskId && isolated(entry.task),
    // 父对话（协调器）就地微改动：角色开了才有，护栏在 beginInlineEdit / endInlineEdit（shared/inline-edit.ts）
    inlineEdit:
      // 就地改动按 Git 的提交核对改了什么（server/tasks/merge.ts 的 begin/endInlineEdit）：P4 / SVN 项目里不给，
      // 以前照样给，Agent 调用后才被「不是 git 仓库」拒掉
      coordinatorRole && startAgent?.inlineEdit === 'tiny' && dir && (await isGit(dir))
        ? {
            begin: (files, reason) => sc.beginInlineEdit(entry.task, dir, files, reason),
            end: () => sc.endInlineEdit(entry.task, dir),
          }
        : undefined,
    // 父对话（协调器）不开独立分支（靠角色说明约束，不关它的工具）：就在项目目录的当前分支上，子对话从这里开、合回这里
    beginEdit:
      task.mode === 'chat' && !coordinatorRole && entry.task.wantsWorktree && !isolated(entry.task)
        ? () => sc.beginEdit(entry, changed)
        : undefined,
    branch: coordinatorRole && dir ? await currentBranch(dir).catch(() => '') : undefined,
    // 独立分支里的子对话改不到别人的文件，不用认领；要改时才开分支的也一样
    claimFiles:
      task.parentTaskId && !isolated(entry.task) && !entry.task.wantsWorktree
        ? (paths) => {
            const r = sc.claims.claim(rootId, { taskId: task.id, title: entry.task.title }, paths)
            // 被拒时写明对方现在怎样：停下等验收的要找父对话协调，不是「过一会儿再认领」
            const held = r.held.map((h) => ({ ...h, state: holderState(sc.live.get(h.byId)?.task) }))
            return { ...r, held }
          }
        : undefined,
    releaseFiles:
      task.parentTaskId && !isolated(entry.task) && !entry.task.wantsWorktree
        ? (paths) => releaseUnchanged(sc.claims, entry.task, paths)
        : undefined,
  } satisfies Partial<RealContext>
}
