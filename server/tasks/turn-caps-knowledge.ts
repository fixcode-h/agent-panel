// 一轮执行交给引擎的「知识」类能力（重构文档第 3、5 条：从 createRun 的 start 里拆出来，按 EngineHost 的小接口分组）。
import type { RealContext } from '../exec/real-context.ts'
import { chatMemoryFor } from '../chat-memory.ts'
import { isChatMode } from '../../shared/conv-mode.ts'
import { readGlobalLessons } from '../lessons.ts'
import { loadProjectLessons } from '../projects/lessons.ts'
import { loadProjectExperience } from '../projects/experience.ts'
import { recordKnowledgeHits } from '../knowledge-hits.ts'
import { recordExperience } from '../experience-learn.ts'

import type { TurnCapsCtx } from './turn-caps-conv.ts'

/** 知识类能力：项目教训、项目经验、Chat 页的跨对话记忆 */
export async function knowledgeCaps(c: TurnCapsCtx) {
  const { sc, task, agents, settings, rootId } = c
  return {
    // 项目教训：每次查都读最新的（别的对话刚记的也能看到）；文件里的新教训和旧项目 JSON 合并后交给 Agent
    lessons: task.projectId
      ? {
          list: async () => {
            const p = await sc.deps.projects.get(task.projectId)
            return p ? (await loadProjectLessons(p, agents)).lessons : []
          },
          globals: readGlobalLessons,
          record: async (input) =>
            sc.deps.recordLesson
              ? sc.deps.recordLesson(task.projectId, { ...input, source: 'agent', taskId: task.id })
              : { ok: false, info: '这里记不了项目教训' },
          hit: (ids) => void recordKnowledgeHits(task.projectId, 'lessons', ids, rootId),
        }
      : undefined,
    // 项目经验：设置里关了总开关就整个不给（工具、开头那一行都没有）；每次查都现读，刚学到的也能查到
    experience:
      task.projectId && settings.experience.enabled
        ? {
            list: async () => {
              const p = await sc.deps.projects.get(task.projectId)
              return p ? (await loadProjectExperience(p, agents)).items : []
            },
            record: async (input) => {
              const p = await sc.deps.projects.get(task.projectId)
              if (!p?.path) return { ok: false, info: '这个项目没有目录，存不了经验' }
              return recordExperience(p, agents, input, task.parentTaskId || task.id)
            },
            hit: (ids) => void recordKnowledgeHits(task.projectId, 'experience', ids, rootId),
          }
        : undefined,
    // Chat 页的对话：「关于我」和跨对话记忆进提示词，remember 工具往里记（server/chat-memory.ts）
    chatMemory: isChatMode(task) ? await chatMemoryFor() : undefined,
  } satisfies Partial<RealContext>
}
