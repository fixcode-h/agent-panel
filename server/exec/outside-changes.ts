import type { FileChange, Task, TaskStep } from '../../shared/schema.ts'
import { mergeChanges } from '../../shared/task.ts'
import { mergeOutside, outsideFiles } from '../own-changes.ts'

/**
 * 项目根之外写过的文件：git 差异里没有它们，统一从 CLI 的写文件事件收进 Task.outsideChanges。
 * 返回这批里项目外路径的个数（>0 表示有项目外文件，调用方据此决定要不要刷新界面）。
 */
export function trackOutside(task: Pick<Task, 'outsideChanges'>, cwd: string, files: Iterable<string>) {
  const outside = outsideFiles(cwd, files)
  if (outside.length) mergeOutside(task, outside)
  return outside.length
}

/**
 * 非 git 项目的一次写文件事件：项目外的记到 outsideChanges，项目内的并进任务和节点的 changes。
 * git 项目里项目内的改动由 git 差异统计，这里只在非 git 项目里调用。
 */
export function trackFileWrite(
  task: Pick<Task, 'outsideChanges' | 'changes'>,
  owner: Pick<TaskStep, 'changes'> | undefined,
  cwd: string,
  file: FileChange,
) {
  if (trackOutside(task, cwd, [file.path])) return
  mergeChanges(task.changes, [file])
  if (owner) mergeChanges((owner.changes ??= []), [file])
}
