/**
 * 排查补丁放到用户工作区 / 还原（分析稿 B1）：Bug 子对话在独立分支里加了 `[排查-` 临时日志（或者修完了），
 * 用户在自己的项目目录里复现不到。面板把独立分支里这几个文件相对分支起点的改动打到项目目录（放之前给这几个
 * 文件拍快照，有冲突就什么都不动），复现完按快照写回去并核对一致；放了之后用户自己又改过这些文件的不覆盖。
 * 只对 Git 项目、开了独立分支的对话做：P4 / SVN / 共用目录没有这回事（共用目录里改动本来就在工作区）。
 * 这里只放纯函数（放哪些文件、能不能还原、说明文字的整理）；跑 git、读写文件在 server/tasks/bug-patch.ts
 */
import type { Diagnosis } from './bug-diagnosis-schema.ts'
import { lastPlan, logFilesOf, phaseOf } from './bug-phase.ts'

/** logs：论证阶段的临时日志（等你复现时用）；fix：修复（验证那一步，把修复临时放到工作区试一下） */
export type PatchKind = 'logs' | 'fix'

/** 快照里「这个文件当时不存在」的记号（补丁新建的文件，还原时删掉） */
export const PATCH_ABSENT = 'absent'

/**
 * 放到工作区之后记下的状态（存在对话数据目录，不进仓库、不进任务数据）：
 * 每个被补丁改到的文件，放之前（before）和放之后（after）内容的哈希；内容按哈希另存
 */
export type PatchState = {
  kind: PatchKind
  at: string
  files: Record<string, { before: string; after: string }>
}

/**
 * 这一版报告现在能放哪种补丁：论证阶段等你复现（日志已加好）是 logs，验证等你确认是 fix；别的时候没有。
 * 只看报告的阶段和状态，不看 Agent 说了什么
 */
export function patchKindOf(d: Pick<Diagnosis, 'phase' | 'confirmed' | 'status' | 'awaiting'> | undefined) {
  if (!d || d.status !== 'pending') return undefined
  const phase = phaseOf(d)
  if (phase === 'evidence' && d.awaiting) return 'logs' as const
  if (phase === 'verify') return 'fix' as const
  return undefined
}

/** 补丁的文件范围：logs 是日志计划涉及的文件，fix 是确认过的方案里的文件 */
export function patchFilesOf(list: Diagnosis[], kind: PatchKind): string[] {
  const files = kind === 'logs' ? logFilesOf(list) : (lastPlan(list)?.files ?? [])
  return [...new Set(files.filter(Boolean))]
}

/**
 * 还原之前核对：放了之后用户又改过的文件（现在的内容和放完那一刻不一样）。有一个就整个不还原——
 * 只还原一部分会让工作区停在「日志删了一半」的样子，比不动更难收拾
 */
export function restoreConflicts(state: PatchState, now: Record<string, string>): string[] {
  return Object.entries(state.files)
    .filter(([file, h]) => (now[file] ?? PATCH_ABSENT) !== h.after)
    .map(([file]) => file)
}

/** git apply --check 的报错整理成几行给用户看：去掉 error: 前缀和重复行，最多留 8 行 */
export function applyErrorLines(stderr: string): string[] {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^(error|fatal|warning):\s*/i, '').trim())
    .filter(Boolean)
  return [...new Set(lines)].slice(0, 8)
}

/** 接口返回给页面的状态 */
export type PatchStatus = {
  /** Git 项目、对话在独立分支里：才显示按钮 */
  eligible: boolean
  /** 已经放在工作区里的那一份（还没还原） */
  applied?: { kind: PatchKind; at: string; files: string[] }
}

/** 放 / 还原的结果：ok 为 false 时什么都没动，reason 说明为什么，files 是有冲突的文件 */
export type PatchResult = { ok: boolean; reason: string; files: string[]; status: PatchStatus }
