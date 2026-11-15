import type { KnowledgeProposal, LessonInput } from '../../shared/host/knowledge.ts'
import { admitLesson } from '../../shared/knowledge/admission.ts'
import { addMiss, addSubtaskCandidate, dropCandidate } from '../../shared/knowledge/capture.ts'
import type { ProjectLesson } from '../../shared/schema.ts'
import type { LessonDraft } from '../lessons.ts'
import { readKnowledgeState, updateKnowledgeState } from './store.ts'

/**
 * 对话里的 Agent 记知识（knowledge_record）在服务端的那一半：入库校验、补上当场捕获的命令和报错、
 * 子任务记的进候选、没配上的查询。存储交给调用方给的 record（项目教训的同一个排队写入口）
 */
export async function lessonFromAgent(
  projectId: string,
  input: LessonInput,
  current: ProjectLesson[],
  record: (draft: LessonDraft) => Promise<{ ok: boolean; info: string }>,
): Promise<{ ok: boolean; info: string }> {
  const { strict, global, episode, commands, ...rest } = input
  if (strict) {
    const a = admitLesson(input, current, global)
    if (!a.ok) return { ok: false, info: `没记下，按下面改了再记：\n${a.problems.map((p) => `- ${p}`).join('\n')}` }
  }
  const cand = episode ? (await readKnowledgeState(projectId)).candidates.find((c) => c.id === episode) : undefined
  if (episode && !cand)
    return { ok: false, info: `没有编号为 ${episode} 的当场记录（可能已经被记过）：不带 episode，写上 commands 再记` }
  const r = await record({
    ...rest,
    wrong: rest.wrong || cand?.wrong || '',
    cause: rest.cause || cand?.cause || '',
    triggers: {
      commands: [...new Set([...(commands ?? []), ...(cand?.commands ?? [])])].slice(0, 10),
      errors: cand?.errors ?? [],
      intents: [],
    },
  })
  // 记下了，候选就没用了
  if (r.ok && cand) await updateKnowledgeState(projectId, (s) => ({ next: dropCandidate(s, cand.id), out: null }))
  return r
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
