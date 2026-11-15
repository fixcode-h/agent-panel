import type { ExperienceEdit, ExperienceListView, ExperienceReviewView, ProjectExperience } from '@shared/experience'
import type { KnowledgeHitsView } from '@shared/knowledge-hits'
import type { DistillRequest, DistillResult, KnowledgeStateView } from '@shared/knowledge/candidate'
import type { Project } from '@shared/schema'
import { json, request } from './api'

/**
 * 项目经验的接口（server/experience/routes.ts）：列表、加、改、删一批 / 应用评审的精简写法、AI 评审。
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
  /** 经验和教训的命中记录、路径失效的条目（设置页按「很久没用上」排序、标过期） */
  hits: (id: string) => request<KnowledgeHitsView>(`/projects/${id}/knowledge-hits`),
}

/** 收下 / 忽略一条候选的回执：收下的是教训时带上写好的项目（界面换掉项目列表里那一份） */
export interface CandidateResult {
  ok: boolean
  info: string
  project?: Project
}

/**
 * 知识候选、没配上的查询、对教训的建议和提炼（shared/knowledge/candidate.ts 的契约）。
 * 打开候选页、提炼页时拉一次，操作后再拉，不轮询
 */
export const knowledgeApi = {
  state: (id: string) => request<KnowledgeStateView>(`/projects/${id}/knowledge`),
  candidate: (id: string, cid: string, action: 'accept' | 'dismiss') =>
    request<CandidateResult>(
      `/projects/${id}/knowledge/candidates/${encodeURIComponent(cid)}`,
      json('POST', { action }),
    ),
  distill: (id: string, req: DistillRequest) =>
    request<DistillResult>(`/projects/${id}/knowledge/distill`, json('POST', req)),
}
