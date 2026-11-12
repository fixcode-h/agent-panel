/**
 * 项目设置、项目教训、全局教训的接口契约（写法见 ./define.ts）。项目的列表、新建、排序、删除在 ./catalog.ts。
 */
import { z } from 'zod'
import type { LessonReviewItem } from '../lesson-review.ts'
import type { ProjectProposal } from '../projects/init.ts'
import { GlobalLesson, GlobalLessons, Project, ProjectInput, type ProjectLesson } from '../schema.ts'
import { endpoint, shaped } from './define.ts'

export const projectsContract = {
  /** 带 expectedUpdatedAt 时按读取时的版本保存：期间被别处改过就回 409，不拿旧快照整份覆盖 */
  update: endpoint({
    method: 'PUT',
    path: '/projects/:id',
    body: shaped<ProjectInput & { expectedUpdatedAt?: string }>(ProjectInput),
    res: Project,
  }),
  /** 只更新「AI 初始化」的结果：服务端读最新项目再合并 */
  saveInitResult: endpoint({
    method: 'PUT',
    path: '/projects/:id/init-result',
    body: shaped<{ initResult: ProjectProposal }>(z.object({ initResult: z.unknown() })),
    res: Project,
  }),
  /** 记一条项目教训（同名的会更新），返回更新后的项目 */
  addLesson: endpoint({
    method: 'POST',
    path: '/projects/:id/lessons',
    body: shaped<Partial<ProjectLesson> & { title: string }>(z.looseObject({ title: z.string() })),
    res: Project,
  }),
  /** 应用 AI 评审的一条建议，返回更新后的项目 */
  applyLessonReview: endpoint({
    method: 'POST',
    path: '/projects/:id/lessons/review',
    body: shaped<{ item: LessonReviewItem }>(z.object({ item: z.unknown() })),
    res: Project,
  }),
  /** 项目是不是 agent-panel 自己的源代码 */
  panelSource: endpoint({
    method: 'GET',
    path: '/projects/:id/panel-source',
    res: z.object({ panelSource: z.boolean() }),
  }),
  globalLessons: endpoint({ method: 'GET', path: '/global-lessons', res: z.array(GlobalLesson) }),
  /** 全局教训只在用户确认后整份保存，confirmed 由确认按钮带上 */
  saveGlobalLessons: endpoint({
    method: 'PUT',
    path: '/global-lessons',
    body: z.object({ lessons: GlobalLessons, confirmed: z.literal(true) }),
    res: z.array(GlobalLesson),
  }),
}
