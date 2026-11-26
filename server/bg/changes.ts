/**
 * 后台命令跑的期间工作目录变了没有、改了哪些文件（2026-11-26 复盘 §5-3：产物核对做成通用能力）。
 * 以前只比 git 的 HEAD + status 指纹，只能说「结果可能不准」，P4 项目连这句都没有；
 * 现在另外按版本管理的改动统计（server/vcs/change-stat.ts）做差：导表、生成代码这类命令把共享文件整份写坏时，
 * 推回结果里写明哪个文件删了多少行（shared/vcs/change-summary.ts 的大量删除告警），不用等子任务碰巧 diff 才发现
 */
import { createHash } from 'node:crypto'
import { gitRun } from '../exec/git.ts'
import { changeDelta, changeStat, type ChangeStat } from '../vcs/change-stat.ts'
import { changeSummary, type ChangeDelta } from '../../shared/vcs/change-summary.ts'

async function fingerprint(dir: string) {
  // --no-optional-locks：status 默认会顺手刷新索引并加锁，这里禁止它写
  const status = await gitRun(dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], {
    timeoutMs: 30_000,
  })
  if (status.code !== 0) return ''
  const head = await gitRun(dir, ['rev-parse', 'HEAD'], { timeoutMs: 10_000 })
  return createHash('sha1').update(`${head.stdout.trim()}\n${status.stdout}`).digest('hex')
}

export interface JobSnapshot {
  fp: string
  stat: ChangeStat | null
}

/** 跑之前记一次：git 指纹（连提交一起比）和版本管理的改动统计 */
export async function jobSnapshot(root: string): Promise<JobSnapshot> {
  const [fp, stat] = await Promise.all([fingerprint(root).catch(() => ''), changeStat(root).catch(() => null)])
  return { fp, stat }
}

/** 跑完再记一次，算出 changed（结果可能不准）和这段时间里变了的文件 */
export async function jobChanges(
  root: string,
  before: JobSnapshot,
): Promise<{ changed: boolean; changes?: ChangeDelta[] }> {
  const after = await jobSnapshot(root)
  const changes = before.stat && after.stat ? changeDelta(before.stat, after.stat) : []
  const moved = !!before.fp && !!after.fp && before.fp !== after.fp
  return { changed: moved || changes.length > 0, ...(changes.length && { changes: changes.slice(0, 50) }) }
}

/** 推回结果里那一段：没记到改动时为空 */
export const jobChangesText = (changes: ChangeDelta[] | undefined) =>
  changes?.length ? changeSummary(changes, 8, '跑的期间工作目录里改了') : ''
