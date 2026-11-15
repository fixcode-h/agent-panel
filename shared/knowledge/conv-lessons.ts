import { lessonExtras, type ProjectLesson } from '../schema.ts'
import type { KnowledgeCandidate, ProjectKnowledgeState } from './candidate.ts'

/**
 * 对话里记下、还没被用户收下的教训（第 8 条，2026-11-15 用户定）：Agent 记的教训只在记下它的那个对话
 * （顶层对话和它的子对话）里立即生效，对别的对话只是候选；用户在知识页收下后才进项目教训、对所有对话生效。
 * 候选按顶层对话 id 记在 convs 里，这里把属于这个对话的换成教训的样子，接在项目教训后面一起推送、一起查
 */
const own = (c: KnowledgeCandidate, conv: string) =>
  c.kind === 'lesson' && (c.origin === 'agent' || c.origin === 'subtask') && !!conv && c.convs.includes(conv)

export function convLessons(
  state: ProjectKnowledgeState,
  conv: string,
  project: ProjectLesson[] = [],
): ProjectLesson[] {
  const key = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  // 同名的已经在项目教训里了（用户收下过、或别处记过同一条）：以项目教训为准
  const titles = new Set(project.map((l) => key(l.title)))
  return state.candidates
    .filter((c) => own(c, conv) && c.title.trim() && !titles.has(key(c.title)))
    .map((c) => ({
      ...lessonExtras(),
      id: c.id,
      title: c.title.slice(0, 120),
      rule: c.rule,
      cause: c.cause,
      wrong: c.wrong,
      paths: c.paths,
      tags: c.tags,
      enabled: true,
      source: 'agent' as const,
      taskId: conv,
      createdAt: c.firstAt,
      updatedAt: c.lastAt,
      history: [],
      triggers: { commands: c.commands, errors: c.errors, intents: [] },
    }))
}

/** 这条是不是这个对话自己记的候选（带 id 改写时改候选本身，不去项目教训里找） */
export const ownCandidate = (state: ProjectKnowledgeState, conv: string, id: string) =>
  state.candidates.find((c) => c.id === id && own(c, conv))
