import { type Project, type ProjectInput, ProjectLesson } from '../shared/schema.ts'
import { MAX_LESSONS, newLessonId, upsertLesson } from '../shared/lessons.ts'
import { t } from '../shared/i18n.ts'

type ProjectStore = {
  get(id: string): Promise<Project | null>
  update(id: string, input: ProjectInput): Promise<Project | null>
}

export type LessonDraft = Partial<Omit<ProjectLesson, 'title'>> & { title: string }

/**
 * 往项目里记教训：对话里的 Agent（record_lesson）和界面上的「记成教训」都走这里。
 * 读改写整个项目，几个对话同时记时排队，免得后写的盖掉先写的
 */
export function projectLessons(projects: ProjectStore) {
  let queue = Promise.resolve()
  const record = (projectId: string, draft: LessonDraft) => {
    const run = queue.then(async () => {
      const p = await projects.get(projectId)
      if (!p) return { ok: false, info: t('项目不存在') }
      const parsed = ProjectLesson.safeParse({
        ...draft,
        id: draft.id || newLessonId(),
        createdAt: draft.createdAt || new Date().toISOString(),
      })
      if (!parsed.success) return { ok: false, info: parsed.error.issues.map((i) => i.message).join('；') }
      const r = upsertLesson(p.lessons, parsed.data)
      if (r.full)
        return {
          ok: false,
          info: t('项目教训已经有 {n} 条，先在项目设置里合并同类项再记', { n: MAX_LESSONS }),
        }
      const { id, createdAt, updatedAt, ...input } = p
      const saved = await projects.update(projectId, { ...input, lessons: r.list })
      return {
        ok: !!saved,
        info: r.added ? `已记下：${parsed.data.title}` : `已更新同名的教训：${parsed.data.title}`,
        project: saved ?? undefined,
      }
    })
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
  return { record }
}
