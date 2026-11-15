import path from 'node:path'
import { ProjectKnowledgeState } from '../../shared/knowledge/candidate.ts'
import { enqueueWrite, writeTextAtomic } from '../projects/lessons.ts'
import { DATA_DIR, readJson } from '../store.ts'

/**
 * 知识候选和没配上的查询（shared/knowledge/candidate.ts）：每个项目一个 JSON，放面板数据目录 knowledge/，
 * 不写进项目——候选还没被认可，不该跟项目一起提交。和命中记录（server/knowledge-hits.ts）一样排队读改写
 */
const stateFile = (projectId: string) =>
  path.join(DATA_DIR, 'knowledge', `${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

export async function readKnowledgeState(projectId: string): Promise<ProjectKnowledgeState> {
  return ProjectKnowledgeState.parse((await readJson(stateFile(projectId))) ?? {})
}

/** 读改写：fn 返回新状态和要交回的值；同一个文件排队，几个对话同时记不会互相覆盖 */
export function updateKnowledgeState<R>(
  projectId: string,
  fn: (cur: ProjectKnowledgeState) => { next: ProjectKnowledgeState; out: R },
): Promise<R> {
  const file = stateFile(projectId)
  let out!: R
  return enqueueWrite(file, async () => {
    const r = fn(await readKnowledgeState(projectId))
    out = r.out
    await writeTextAtomic(file, JSON.stringify(ProjectKnowledgeState.parse(r.next), null, 2))
  }).then(() => out)
}
