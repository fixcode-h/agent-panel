import type { Project, Task } from '../../shared/schema.ts'
import { gitRun } from '../exec/git.ts'
import { placedFiles } from '../attachments.ts'
import type { TasksScope } from './scope.ts'

/** 清单最多列这么多个：只是让父对话知道有哪些，太长反而淹没要它做的选择 */
const LIST_MAX = 20

/**
 * 父对话目录里没提交、没跟踪的文件（相对路径）。不是 git 仓库、git 出错时返回 null（不拦）。
 * 面板自己放进来的附件不算，和改动清单同一个排除名单（server/attachments.ts 的 placedFiles）
 */
export async function uncommittedFiles(dir: string, ignore: Iterable<string> = []): Promise<string[] | null> {
  const r = await gitRun(dir, ['status', '--porcelain', '--untracked-files=all'])
  if (r.code !== 0) return null
  const skip = new Set(ignore)
  return r.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ').pop()! : p))
    .filter((p) => !skip.has(p))
}

/**
 * 独立分支模式下父对话派「要改代码」的子对话之前：父对话目录里有没提交的改动时先不开，把清单交回给父对话选
 * （先提交再派，或者明确说子对话不需要它们）。子对话的独立分支从当前提交开出，看不到这些改动——
 * 实测里父对话先写了模块文档没提交，接着开的三个子对话都找不到派单里要它们更新的文档（2026-11-05）。
 * 不自动带进 worktree：stash 不含未跟踪文件，合回时还会和父对话目录里同一份改动撞在一起。
 * 返回空字符串表示可以开；edits 没写的子对话先在父对话目录里做事，只在返回里提醒一句（见 dirtyParentNote）
 */
export async function dirtyParentBlock(sc: Pick<TasksScope, 'taskDir'>, parent: Task, project: Project) {
  const files = await dirtyOf(sc, parent, project)
  if (!files?.length) return ''
  return (
    `还没开：你的目录里有 ${files.length} 个没提交的改动，子对话的独立分支从当前提交开出，看不到它们：\n${listOf(files)}\n` +
    '子对话要用到的（文档、公共改动）先提交再派；提交前确认是这次对话自己改的，用户自己的改动不要替他提交。' +
    '确定子对话不需要它们，再调用一次 create_conversation 并写上 ignore_uncommitted: true。'
  )
}

/** edits 没写的子对话：先在父对话目录里调研，要改文件时才开独立分支，那时同样看不到这些改动，返回里提醒一句 */
export async function dirtyParentNote(sc: Pick<TasksScope, 'taskDir'>, parent: Task, project: Project) {
  const files = await dirtyOf(sc, parent, project)
  if (!files?.length) return ''
  return `注意：你的目录里有 ${files.length} 个没提交的改动，子对话要改文件时开出的独立分支看不到它们：\n${listOf(files)}\n它要用到的话先提交。`
}

async function dirtyOf(sc: Pick<TasksScope, 'taskDir'>, parent: Task, project: Project) {
  if (project.childIsolation !== 'worktree' || !project.path) return null
  const dir = await sc.taskDir(parent).catch(() => '')
  return dir ? uncommittedFiles(dir, placedFiles(parent)).catch(() => null) : null
}

function listOf(files: string[]) {
  const shown = files.slice(0, LIST_MAX).map((f) => `- ${f}`)
  if (files.length > LIST_MAX) shown.push(`- ……还有 ${files.length - LIST_MAX} 个`)
  return shown.join('\n')
}
