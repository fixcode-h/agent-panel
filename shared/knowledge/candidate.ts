import { z } from 'zod'
import { ErrorPrint } from '../schema.ts'

/**
 * 知识候选和「没配上的查询」（设计稿 4.5、4.6、三期）：存在面板数据目录 knowledge/<项目 id>.json（server/knowledge/store.ts），
 * 不写进项目里的教训 / 经验文件——候选还没被认可，不该跟项目一起提交。
 * - 失败后换了做法才成（episode）：面板机械地记下失败的命令、报错指纹和改对后的命令，当场提示 Agent 记；
 *   同一个报错指纹在另一个对话里再出现时自动转正成教训（Q2）。
 * - 子对话记的（subtask）：子对话不和用户对话、常并行多只，记的先放候选，等用户在知识页点「收下」。
 * - 对话记的（agent）：Agent 用 knowledge_record / record_lesson 新记的教训，在记下它的对话里立即生效，
 *   对别的对话是候选，等用户收下（第 8 条，shared/knowledge/conv-lessons.ts）。
 * 界面（项目设置 → 候选）和演示后端都用这里的类型
 */

export const CANDIDATE_MAX = 200
export const MISS_MAX = 100
/** 一条候选最多记几个对话：够判断「复发」就行 */
export const CANDIDATE_CONVS_MAX = 10

export const KnowledgeCandidate = z.object({
  id: z.string().min(1),
  kind: z.enum(['lesson', 'experience']).catch('lesson'),
  /** episode：面板从「失败后改对」机械捕获的；subtask：子对话用 knowledge_record 记的；agent：对话里的 Agent 记的 */
  origin: z.enum(['episode', 'subtask', 'agent']).catch('episode'),
  title: z.string().max(200).catch('').default(''),
  /** 教训：对的做法；经验：一两句补充写在 body */
  rule: z.string().max(1500).catch('').default(''),
  wrong: z.string().max(300).catch('').default(''),
  cause: z.string().max(500).catch('').default(''),
  paths: z.array(z.string().max(200)).max(20).catch([]).default([]),
  tags: z.array(z.string().max(20)).max(5).catch([]).default([]),
  /** 命令触发键（失败的那条命令的「目的」，如 npx tsc） */
  commands: z.array(z.string().max(200)).max(10).catch([]).default([]),
  errors: z.array(ErrorPrint).max(5).catch([]).default([]),
  /** 失败的那条、改对后的那条命令原文：界面上给人看，转正时写进 wrong / rule */
  failed: z.string().max(400).catch('').default(''),
  fixed: z.string().max(400).catch('').default(''),
  /** 经验候选的字段 */
  expKind: z.string().max(20).catch('').default(''),
  body: z.string().max(1500).catch('').default(''),
  keywords: z.array(z.string().max(60)).max(20).catch([]).default([]),
  /** 出现在哪些顶层对话（新的在前） */
  convs: z.array(z.string()).max(CANDIDATE_CONVS_MAX).catch([]).default([]),
  count: z.number().int().min(0).catch(1).default(1),
  firstAt: z.string().catch('').default(''),
  lastAt: z.string().catch('').default(''),
})
export type KnowledgeCandidate = z.infer<typeof KnowledgeCandidate>

/** 搜了、查了却什么都没配上的查询（四期「没配上的查询」）：反复出现的说明该补一条经验 */
export const KnowledgeMiss = z.object({
  query: z.string().max(200),
  count: z.number().int().min(0).catch(1).default(1),
  convs: z.array(z.string()).max(CANDIDATE_CONVS_MAX).catch([]).default([]),
  lastAt: z.string().catch('').default(''),
})
export type KnowledgeMiss = z.infer<typeof KnowledgeMiss>

export const ProjectKnowledgeState = z
  .object({
    candidates: z.array(KnowledgeCandidate).max(CANDIDATE_MAX).catch([]).default([]),
    misses: z.array(KnowledgeMiss).max(MISS_MAX).catch([]).default([]),
  })
  .prefault({})
export type ProjectKnowledgeState = z.infer<typeof ProjectKnowledgeState>

/**
 * 面板对一条教训的建议（设计稿 4.7，shared/knowledge/lifecycle.ts 算）：
 * upgrade 推了还是犯（violated 多次），建议升级成拦截；stale 很久没用上或锚点不在了，建议降权 / 停用；
 * promote 用上很多次、帮上过，建议提炼进 AGENTS.md 或钩子。只是建议，按钮由用户点
 */
export interface LessonSuggestion {
  id: string
  action: 'upgrade' | 'stale' | 'promote'
  /** 给人看的一句理由（已翻译） */
  why: string
}

/** GET /projects/:id/knowledge：候选、没配上的查询、对教训的建议 */
export interface KnowledgeStateView extends ProjectKnowledgeState {
  suggestions: LessonSuggestion[]
}

/** POST /projects/:id/knowledge/candidates/:cid：收下（accept）转正成教训 / 经验，或忽略（dismiss）删掉 */
export const CandidateAction = z.object({ action: z.enum(['accept', 'dismiss']) })

/**
 * 四期「提炼」（shared/knowledge/distill.ts）：POST /projects/:id/knowledge/distill。
 * agents：挑够格的教训写成 AGENTS.md 补丁；docs：按模块合进模块文档；panel：面板自身该改进的地方；
 * misses：没配上的查询该补哪些经验——这四种返回一段发给项目对话的提示词，界面照「AI 评审」那样开一个项目对话，补丁走评审弹窗确认。
 * hook：把一条（拦截档的）教训转成项目的用户钩子（tool.before 拒绝对得上的命令），直接写入，返回钩子 id
 */
export const DistillRequest = z.object({
  target: z.enum(['agents', 'docs', 'panel', 'misses', 'hook']),
  /** hook 时必填：哪条教训 */
  lessonId: z.string().optional(),
})
export type DistillRequest = z.infer<typeof DistillRequest>

export interface DistillResult {
  ok: boolean
  /** 失败原因或成功的一句话（已翻译） */
  info: string
  /** agents / docs / panel / misses：开对话用的标题和提示词；挑不出可提炼的条目时为空，info 说明原因 */
  title?: string
  prompt?: string
  /** 这次挑中的教训 id */
  picked?: string[]
  /** hook：写入的钩子 id */
  hookId?: string
}
