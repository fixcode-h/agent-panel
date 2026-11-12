import { stat } from 'node:fs/promises'
import path from 'node:path'
import { globBase } from '../shared/experience.ts'
import {
  ProjectKnowledgeHits,
  addHits,
  pruneHits,
  type KnowledgeKind,
  type KnowledgeHitsView,
} from '../shared/knowledge-hits.ts'
import { enqueueWrite, writeTextAtomic } from './projects/lessons.ts'
import { DATA_DIR, readJson } from './store.ts'

/**
 * 经验、教训的命中记录（shared/knowledge-hits.ts）：每个项目一个 JSON，放在面板数据目录，
 * 不写进项目里的经验 / 教训文件（那些常跟项目一起提交，查一次改一次会全是噪音）
 */
const hitsFile = (projectId: string) =>
  path.join(DATA_DIR, 'knowledge-hits', `${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

export async function readKnowledgeHits(projectId: string): Promise<ProjectKnowledgeHits> {
  return ProjectKnowledgeHits.parse((await readJson(hitsFile(projectId))) ?? {})
}

/** 记一次命中：同一个文件排队写，读改写不会互相覆盖。失败只打日志——记不上不该影响 Agent 查到的结果 */
export function recordKnowledgeHits(projectId: string, kind: KnowledgeKind, ids: string[], taskId: string) {
  if (!projectId || !ids.length) return Promise.resolve()
  const file = hitsFile(projectId)
  return enqueueWrite(file, async () => {
    const cur = await readKnowledgeHits(projectId)
    cur[kind] = addHits(cur[kind], ids, taskId, new Date().toISOString())
    await writeTextAtomic(file, JSON.stringify(cur, null, 2))
  }).catch((e) => console.warn(`记录${kind === 'lessons' ? '教训' : '经验'}命中失败：`, e))
}

/** 路径已经不在的：按 glob 的固定前缀核对；命令类经验的「路径」写的是命令，不核对 */
export async function missingPaths(root: string, items: { id: string; paths: string[]; kind?: string }[]) {
  const out: Record<string, string[]> = {}
  for (const e of items) {
    if (e.kind === 'command') continue
    const gone: string[] = []
    for (const x of e.paths) {
      const base = globBase(x)
      if (base && !(await stat(path.join(root, base)).catch(() => null))) gone.push(x)
    }
    if (gone.length) out[e.id] = gone
  }
  return out
}

/** 设置页用：命中记录（只留还在的条目）+ 路径失效的条目 */
export async function knowledgeHitsView(
  projectId: string,
  root: string,
  experience: { id: string; paths: string[]; kind?: string }[],
  lessons: { id: string; paths: string[] }[],
): Promise<KnowledgeHitsView> {
  const hits = await readKnowledgeHits(projectId)
  return {
    experience: pruneHits(
      hits.experience,
      experience.map((x) => x.id),
    ),
    lessons: pruneHits(
      hits.lessons,
      lessons.map((x) => x.id),
    ),
    stale: {
      experience: root ? await missingPaths(root, experience) : {},
      lessons: root ? await missingPaths(root, lessons) : {},
    },
  }
}
