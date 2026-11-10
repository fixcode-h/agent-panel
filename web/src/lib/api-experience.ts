import type { ExperienceEdit, ExperienceListView, ExperienceReviewView, ProjectExperience } from '@shared/experience'
import { json, request } from './api'

/**
 * 项目经验的接口（server/experience-routes.ts）：列表、加、改、删一批 / 应用评审的精简写法、AI 评审。
 * 单独一个文件：api.ts 到了行数上限。演示版的同样路径交给 demo-experience.ts
 */
type Items = { items: ProjectExperience[] }

export const experienceApi = {
  list: (id: string) => request<ExperienceListView>(`/projects/${id}/experience`),
  add: (id: string, e: ExperienceEdit) => request<Items>(`/projects/${id}/experience`, json('POST', e)),
  update: (id: string, eid: string, e: ExperienceEdit) =>
    request<Items>(`/projects/${id}/experience/${eid}`, json('PUT', e)),
  apply: (id: string, input: { remove?: string[]; trim?: { id: string; title: string; body: string }[] }) =>
    request<Items>(`/projects/${id}/experience/apply`, json('POST', input)),
  /** 按原样写回一条（撤销删除、撤回合并）；expect 是写回前应有的 updatedAt，对不上返回 409 */
  restore: (id: string, item: ProjectExperience, expect?: string) =>
    request<Items>(`/projects/${id}/experience/restore`, json('POST', { item, expect })),
  review: (id: string) => request<ExperienceReviewView>(`/projects/${id}/experience/review`, json('POST', {})),
}
