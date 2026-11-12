/**
 * 回收站的接口契约（写法见 ./define.ts）：删掉的对话，和删掉的角色、工作流、项目。
 */
import { z } from 'zod'
import { endpoint } from './define.ts'

/** 回收站里的一个对话（只列顶层对话，子对话跟着父对话一起进出） */
export const TrashRow = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  parentTaskId: z.string(),
  /** 进回收站的时间 */
  deletedAt: z.string(),
  /** 还剩几天被物理删除，0 表示下次清理就删 */
  leftDays: z.number(),
  /** 跟着一起进回收站的子对话数 */
  children: z.number(),
  /** 独立分支状态：active 的恢复后能接着用，其他没有可用的分支 */
  worktree: z.string(),
})
export type TrashRow = z.infer<typeof TrashRow>

/** 回收站里的角色、工作流、项目 */
export const TrashItemRow = z.object({
  kind: z.enum(['agent', 'workflow', 'project']),
  id: z.string(),
  name: z.string(),
  deletedAt: z.string(),
  /** 删项目时一起进回收站的对话数 */
  tasks: z.number(),
  leftDays: z.number(),
  retentionDays: z.number(),
})
export type TrashItemRow = z.infer<typeof TrashItemRow>

const Kind = TrashItemRow.shape.kind

export const trashContract = {
  /** 删对话：进回收站，保留期内能恢复 */
  deleteTask: endpoint({ method: 'DELETE', path: '/tasks/:id', res: z.void() }),
  tasks: endpoint({ method: 'GET', path: '/tasks/trash', res: z.array(TrashRow) }),
  /** worktreeCleared：独立分支目录已经没了，恢复后要重新执行 */
  restoreTask: endpoint({
    method: 'POST',
    path: '/tasks/:id/restore',
    body: z.object({}),
    res: z.object({ worktreeCleared: z.boolean() }),
  }),
  /** 永久删除：不进回收站，内容直接清掉 */
  purgeTask: endpoint({ method: 'DELETE', path: '/tasks/:id/permanent', res: z.void() }),
  items: endpoint({ method: 'GET', path: '/trash/items', res: z.array(TrashItemRow) }),
  restoreItem: endpoint({
    method: 'POST',
    path: '/trash/items/:kind/:id/restore',
    body: z.object({}),
    res: z.object({ ok: z.literal(true), tasks: z.number() }),
  }),
  purgeItem: endpoint({ method: 'DELETE', path: '/trash/items/:kind/:id', res: z.void() }),
}
/** 路径参数 kind 只能是这几种 */
export type TrashKind = z.infer<typeof Kind>
