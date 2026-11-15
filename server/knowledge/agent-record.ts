import type { KnowledgeProposal, LessonInput } from '../../shared/host/knowledge.ts'
import { admitLesson } from '../../shared/knowledge/admission.ts'
import { addMiss, addSubtaskCandidate, dropCandidate } from '../../shared/knowledge/capture.ts'
import type { ProjectLesson } from '../../shared/schema.ts'
import type { LessonDraft } from '../lessons.ts'
import { convLessons, ownCandidate } from '../../shared/knowledge/conv-lessons.ts'
import { readKnowledgeState, updateKnowledgeState } from './store.ts'

/**
 * 对话里的 Agent 记知识（knowledge_record）在服务端的那一半：入库校验、补上当场捕获的命令和报错、
 * 子任务记的进候选、没配上的查询。
 * 新记的教训不直接进项目教训（第 8 条，2026-11-15 用户定）：放进候选（origin: agent，convs 是这个顶层对话），
 * 在这个对话和它的子对话里立即生效（shared/knowledge/conv-lessons.ts），别的对话等用户在知识页收下。
 * 带 id 改写已在项目教训里的那条，仍交给调用方给的 record（项目教训的同一个排队写入口）
 */
export async function lessonFromAgent(
  projectId: string,
  input: LessonInput,
  current: ProjectLesson[],
  record: (draft: LessonDraft) => Promise<{ ok: boolean; info: string }>,
  conv: string,
): Promise<{ ok: boolean; info: string }> {
  const { strict, global, episode, commands, ...rest } = input
  if (strict) {
    const a = admitLesson(input, current, global)
    if (!a.ok) return { ok: false, info: `没记下，按下面改了再记：\n${a.problems.map((p) => `- ${p}`).join('\n')}` }
  }
  const state = await readKnowledgeState(projectId)
  const cand = episode ? state.candidates.find((c) => c.id === episode) : undefined
  if (episode && !cand)
    return { ok: false, info: `没有编号为 ${episode} 的当场记录（可能已经被记过）：不带 episode，写上 commands 再记` }
  const draft = {
    ...rest,
    wrong: rest.wrong || cand?.wrong || '',
    cause: rest.cause || cand?.cause || '',
    triggers: {
      commands: [...new Set([...(commands ?? []), ...(cand?.commands ?? [])])].slice(0, 10),
      errors: cand?.errors ?? [],
      intents: [],
    },
  }
  const mine = rest.replaces ? ownCandidate(state, conv, rest.replaces) : undefined
  if (rest.replaces && !mine) {
    const r = await record(draft)
    // 记下了，候选就没用了
    if (r.ok && cand) await updateKnowledgeState(projectId, (s) => ({ next: dropCandidate(s, cand.id), out: null }))
    return r
  }
  const now = new Date().toISOString()
  const fields = {
    kind: 'lesson' as const,
    title: draft.title,
    rule: draft.rule,
    wrong: draft.wrong,
    cause: draft.cause,
    paths: draft.paths,
    tags: draft.tags ?? [],
    commands: draft.triggers.commands,
    errors: draft.triggers.errors,
    failed: cand?.failed ?? '',
    fixed: cand?.fixed ?? '',
  }
  await updateKnowledgeState(projectId, (s) => {
    // 改写自己记的那条：就地换内容，id 不变（推送、命中都按 id 记）
    if (mine)
      return {
        next: { ...s, candidates: s.candidates.map((c) => (c.id === mine.id ? { ...c, ...fields, lastAt: now } : c)) },
        out: null,
      }
    const base = cand ? dropCandidate(s, cand.id) : s
    return { next: addSubtaskCandidate(base, fields, conv, now, 'agent').next, out: null }
  })
  return {
    ok: true,
    info: `${mine ? '已改写' : '已记下'}：${draft.title}。在这个对话（和它派出的子对话）里立即生效；别的对话要等用户在项目设置的知识候选里收下才生效`,
  }
}

/** 子任务记的：进知识候选，等用户在知识页收下 */
export async function proposeKnowledge(projectId: string, input: KnowledgeProposal, conv: string) {
  const now = new Date().toISOString()
  const cand =
    input.kind === 'lesson'
      ? {
          kind: 'lesson' as const,
          title: input.title,
          rule: input.rule,
          wrong: input.wrong ?? '',
          cause: input.cause,
          paths: input.paths,
          tags: input.tags ?? [],
          commands: input.commands ?? [],
        }
      : {
          kind: 'experience' as const,
          title: input.exp.title,
          body: input.exp.body,
          expKind: input.exp.kind,
          keywords: input.exp.keywords,
          paths: input.exp.paths,
        }
  await updateKnowledgeState(projectId, (s) => {
    const r = addSubtaskCandidate(s, cand, conv, now)
    return { next: r.next, out: null }
  })
  return { ok: true, info: '已放进项目的知识候选，等用户在项目设置里收下（子任务记的不直接生效）' }
}

/** knowledge_lookup 什么都没配上：记一次，不等写完、写不上不影响查询 */
export function noteMiss(projectId: string, query: string, conv: string) {
  void updateKnowledgeState(projectId, (s) => ({
    next: addMiss(s, query, conv, new Date().toISOString()),
    out: null,
  })).catch((e) => console.warn('记录没配上的查询失败：', e))
}

/** 项目教训后面接上这个对话自己记下、还没被收下的（第 8 条）：推送、查询、提示词都用这一份 */
export async function withConvLessons(projectId: string, lessons: ProjectLesson[], conv: string) {
  if (!conv) return lessons
  const state = await readKnowledgeState(projectId).catch(() => undefined)
  return state ? [...lessons, ...convLessons(state, conv, lessons)] : lessons
}
