// 项目知识：教训、经验、能力、Chat 记忆、模块文档。
// 从 shared/engine/host.ts 的 EngineHost / Orchestra 两个大接口里按能力拆出来（重构文档第 5 条），
// 新能力加进对应的小接口或新开一个，不再往大接口上加；成员数由 scripts/structure-check.mjs 盯着
import type { ModuleDocsLookup } from '../docs-first.ts'
import type { ExperienceInput, ProjectExperience } from '../experience.ts'
import type { LessonQuery } from '../lessons.ts'
import type { GlobalLesson, ParamValues, ProjectLesson } from '../schema.ts'

/** Orchestra 里项目知识的那部分（重构文档第 5 条：按能力拆成小接口，Orchestra 只是它们的组合） */
export interface OrchKnowledge {
  /** 调用者的角色挂了能力：可以 use_capability 就地加载它们的做法 */
  capabilities: boolean
  loadCapability(name: string, params?: ParamValues): { ok: boolean; info: string }
  /** 项目教训：按文件 / 关键词 / 标签取全文、记一条；不在项目里时没有。子任务只读不记（record 为空）：
   * 它不和用户对话、常并行多只，值得记的交回派它的对话决定，免得各记一条重复、口径不一的 */
  lessons?: {
    find(files: string[], opts?: LessonQuery): Promise<string>
    record?(input: LessonInput): Promise<{ ok: boolean; info: string }>
  }
  /** 项目经验（shared/experience.ts）：按关键词查；设置里关了经验、不在项目里时没有。子任务也能查 */
  experience?: {
    find(query: string, files: string[]): Promise<string>
    list(): Promise<ProjectExperience[]>
    /** 记一条（/learn 命令让 Agent 学一件事）：子任务没有，值得记的交回派它的对话 */
    record?(input: ExperienceInput): Promise<{ ok: boolean; info: string }>
  }
  /** Chat 模式的跨对话记忆（remember 工具，server/chat-memory.ts）：只有 Chat 页的对话有 */
  remember?: (text: string, forget?: boolean) => Promise<{ ok: boolean; info: string }>
}

/** EngineHost 里项目知识的那部分 */
export interface KnowledgeHost {
  /** 项目教训：按要改的文件查，Agent 被纠正后自己记一条（只有项目里的对话和节点有） */
  lessons?: {
    list: () => Promise<ProjectLesson[]>
    /** 全局教训：只读，Agent 改不了 */
    globals?: () => Promise<GlobalLesson[]>
    record: (input: LessonInput) => Promise<{ ok: boolean; info: string }>
    /** 查到并交出全文的那几条：记一次命中（shared/knowledge-hits.ts），不等写完 */
    hit?: (ids: string[]) => void
  }
  /** 项目经验：每次查都现读（刚学到的也能查到）；设置里关了经验时宿主不给 */
  experience?: {
    list: () => Promise<ProjectExperience[]>
    record: (input: ExperienceInput) => Promise<{ ok: boolean; info: string }>
    /** 同 lessons.hit */
    hit?: (ids: string[]) => void
  }
  /** Chat 模式的「关于我」和记忆（server/chat-memory.ts）：提示词带上，remember 工具往里记；只有 Chat 页的对话有 */
  chatMemory?: { about: string; items: string[]; remember: NonNullable<OrchKnowledge['remember']> }
  moduleDocs?: ModuleDocsLookup // 查模块文档（先建文档再开子对话，shared/docs-first.ts）
}

/** Agent 用 record_lesson 记的一条教训 */
export interface LessonInput {
  title: string
  rule: string
  cause: string
  paths: string[]
  /** 标签：优先用这个项目已有的 */
  tags?: string[]
  /** 改写已有的那条（用户的新要求和它冲突、找到两全的做法时）：那条的 id */
  replaces?: string
  /** 为什么改写 */
  why?: string
}
