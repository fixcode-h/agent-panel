/**
 * 父对话收尾（finish_child）时把子对话的独立分支合进父对话的目录：换分支 → 挡路检查 → 试合并 → 提交。
 * 从 children.ts 抽出来，单测（server/tasks/merge.test.ts）直接调这个真函数，不再手抄一份口径。
 *
 * 失败按「谁能修」分类（见 ADR 0005 第四节）：
 * - conflict：两个分支改了同一处，只有子对话能在自己的分支里修，说法写给子对话；
 * - blocked / branch：父对话自己的目录状态不对（暂存区、没做完的合并、和分支重叠的未提交改动、换了分支），
 *   子对话动不了，说法写给父对话：在哪个目录、哪些文件 / 分支、怎么处理、不是自己改的不要动；
 * - error：合并提交本身出错，由父对话看报错决定自己处理还是交回子对话。
 */
import type { TaskWorktree } from '../../shared/schema.ts'
import { aroundMerge } from '../turn-changes.ts'
import {
  abortMerge,
  commitMerge,
  currentBranch,
  mergeBlocker,
  mergeSides,
  mergeSidesText,
  trialMerge,
} from './worktree.ts'

export type IntegrateKind = 'conflict' | 'blocked' | 'branch' | 'error'

export interface IntegrateResult {
  ok: boolean
  /** 给收件人的完整说法：冲突写给子对话，其余写给父对话 */
  info: string
  /** 失败类别；成功时没有 */
  kind?: IntegrateKind
  /** 一行的原因（带具体文件 / 分支）：计划步骤备注、界面提示用，不带做法 */
  why?: string
}

/** 文件清单：一行一个，太多时只列前 20 个 */
const fileList = (files: string[]) =>
  files.slice(0, 20).join('\n') + (files.length > 20 ? `\n……等 ${files.length} 个` : '')
const fileLine = (files: string[]) => files.slice(0, 5).join('、') + (files.length > 5 ? ` 等 ${files.length} 个` : '')

/** 挡路时给父对话的做法：先分清是不是自己的改动，不是自己的不动、交给用户 */
const ownOrAsk = (what: string) =>
  `是你这一轮自己${what}的：按版本控制的规则提交（或者 git stash 先挪开、合完再 git stash pop）；` +
  `不是你${what}的（用户在原目录里手动改的）不要提交、stash 或丢弃，告诉用户让他处理。`

/** 一次合并：试合并 → 提交；冲突或目录状态不对就撤回，目标目录不变 */
export async function integrateBranch(target: string, wt: TaskWorktree, title: string): Promise<IntegrateResult> {
  const base = wt.baseBranch || '原分支'
  // 从哪开的分支就合回哪：原目录后来换了分支就不合，免得合到别的分支上
  const now = await currentBranch(target)
  if (wt.baseBranch && now !== wt.baseBranch)
    return {
      ok: false,
      kind: 'branch',
      why: `目录现在在「${now || '分离的 HEAD'}」，不是开分支时的「${wt.baseBranch}」`,
      info:
        `你的目录 ${target} 现在在「${now || '分离的 HEAD'}」，子对话的分支是从「${wt.baseBranch}」开的，没有合并（只合回开分支的那个分支）。` +
        `是你自己切走的：先把当前分支上没提交的改动提交或 stash，再 git switch ${wt.baseBranch}；不是你切的（用户切的）不要切回去，问用户。`,
    }
  const blocked = await mergeBlocker(target)
  if (blocked?.kind === 'merge-head')
    return {
      ok: false,
      kind: 'blocked',
      why: '目录里有一次没做完的合并（MERGE_HEAD 还在）',
      info: `你的目录 ${target} 里有一次没做完的合并（MERGE_HEAD 还在），没有合并。是你开的：解决完提交，或者 git merge --abort；不是你开的告诉用户。`,
    }
  if (blocked?.kind === 'staged')
    return {
      ok: false,
      kind: 'blocked',
      why: `暂存区里有还没提交的改动：${fileLine(blocked.files)}`,
      info: `你的目录 ${target} 的暂存区里有还没提交的改动，合并提交会把它们一起带进去，没有合并：\n${fileList(blocked.files)}\n${ownOrAsk('暂存')}`,
    }
  // 两边都改过的文件：git 只在同一处改动上报冲突，同一个文件改不同位置会静默合上。
  // 合并前连同双方的提交记录一起记下来：合进去时一并告诉子对话和父对话「这个文件两边都动过」，
  // 并且让他们能按提交说明和文档看懂各自为什么这么改，而不是只看 diff 拿主意（见 project-vcs 的「合并审查」）
  const sides = await mergeSides(target, wt.branch).catch(() => null)
  const overlap = sides?.overlap ?? []
  const about = sides ? `\n\n${mergeSidesText(sides)}` : ''
  // 父对话总结下面的改动卡片不含子对话的改动：合并的那一下从父对话这一轮里切掉
  return aroundMerge(target, async (): Promise<IntegrateResult> => {
    const m = await trialMerge(target, wt.branch)
    if (!m.ok) {
      if (m.dirty) {
        // 解析不到文件名（git 换了说法）时退回整段报错，至少原文还在
        const files = m.blockers.length ? fileList(m.blockers) : m.error
        return {
          ok: false,
          kind: 'blocked',
          why: `这些文件有还没提交的改动、子对话的分支也改了它们：${m.blockers.length ? fileLine(m.blockers) : m.error.split('\n')[0]}`,
          info: `你的目录 ${target} 里这些文件有还没提交的改动，子对话的分支也改了它们，git 拒绝合并，你的目录没有改动：\n${files}\n${ownOrAsk('改')}${about}`,
        }
      }
      return {
        ok: false,
        kind: 'conflict',
        why: `和「${base}」上新合进去的改动冲突`,
        info: `和「${base}」上新合进去的改动冲突，已撤回，原目录没有改动。在你的目录里先 git merge ${base} 把它合进来、解决冲突、重新跑一遍验证并提交，再调用 submit_merge。\n${m.error}${about}`,
      }
    }
    if (m.nothing) return { ok: true, info: '分支上没有新的改动，原分支已经是最新的' }
    try {
      const sha = await commitMerge(target, `Agent 面板：合并「${title}」`)
      const both = overlap.length
        ? `\n两边都改了这些文件：${overlap.slice(0, 20).join('、')}${overlap.length > 20 ? ` 等 ${overlap.length} 个` : ''}。git 已经自动合并，但同一个文件两边都动过：必须逐文件核对有没有盖掉对方的改动，核对结论写进合并结论（见 project-vcs 技能 git.md 的「合并审查」）。`
        : ''
      return {
        ok: true,
        info: `已合进「${wt.baseBranch || '原目录'}」（${sha}），改了 ${m.files.length} 个文件。${both}`,
      }
    } catch (e) {
      await abortMerge(target)
      const msg = (e as Error).message
      return {
        ok: false,
        kind: 'error',
        why: `合并后提交失败：${msg.split('\n')[0]}`,
        info:
          `合并后提交失败，已撤回：${msg}\n` +
          '看报错：是你目录的问题（锁文件、提交身份）就处理后再 finish_child；是子对话的改动过不了提交钩子就用 send_to_conversation 把报错交回给它。',
      }
    }
  })
}
