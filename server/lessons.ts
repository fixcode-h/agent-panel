import path from 'node:path'
import { type GlobalLesson, GlobalLessons, type Project, type ProjectInput, ProjectLesson } from '../shared/schema.ts'
import { MAX_LESSONS, newLessonId, normTags, upsertLesson } from '../shared/lessons.ts'
import { t } from '../shared/i18n.ts'
import { applyReviewItem, type LessonReviewItem } from '../shared/lesson-review.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'

type ProjectStore = {
  get(id: string): Promise<Project | null>
  update(id: string, input: ProjectInput): Promise<Project | null>
}

export type LessonDraft = Partial<Omit<ProjectLesson, 'title'>> & {
  title: string
  /** 要改写的那条的 id（用户的新要求和它冲突、找到两全的做法时） */
  replaces?: string
  /** 为什么改写 */
  why?: string
}

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
      const { replaces, why, ...rest } = draft
      if (replaces && !p.lessons.some((l) => l.id === replaces))
        return {
          ok: false,
          info: replaces.startsWith('g')
            ? '全局教训只有用户能改。和它冲突时以项目教训为准：不带 id 记一条项目教训，写明这个项目的例外。'
            : `没有 id 为 ${replaces} 的项目教训：先用 project_lessons 查到它的 id；要新记一条就不带 id。`,
        }
      const parsed = ProjectLesson.safeParse({
        ...rest,
        // 和已有标签只差大小写、带 # 的统一成已有的写法
        tags: normTags(
          rest.tags ?? [],
          p.lessons.flatMap((l) => l.tags),
        ),
        // 改写时的 id 用原来那条的，新记的才生成
        id: replaces || rest.id || newLessonId(),
        createdAt: rest.createdAt || new Date().toISOString(),
      })
      if (!parsed.success) return { ok: false, info: parsed.error.issues.map((i) => i.message).join('；') }
      const r = upsertLesson(p.lessons, parsed.data, { replaces, why })
      if (r.full)
        return {
          ok: false,
          info: t('项目教训已经有 {n} 条，先在项目设置里合并同类项再记', { n: MAX_LESSONS }),
        }
      const { id, createdAt, updatedAt, ...input } = p
      const saved = await projects.update(projectId, { ...input, lessons: r.list })
      return {
        ok: !!saved,
        info: r.added
          ? `已记下：${parsed.data.title}`
          : replaces
            ? `已改写教训：${parsed.data.title}`
            : `已更新同名的教训：${parsed.data.title}`,
        project: saved ?? undefined,
      }
    })
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
  /** 应用 AI 评审的一条建议（用户在评审卡片上点的）：和 record 同一个队列，不和角色正在记的互相覆盖 */
  const review = (projectId: string, item: LessonReviewItem) => {
    const run = queue.then(async () => {
      const p = await projects.get(projectId)
      if (!p) return { ok: false, info: t('项目不存在') }
      if (item.action !== 'delete' && !p.lessons.some((l) => l.id === item.id))
        return { ok: false, info: t('这条教训已经不在了') }
      const { id, createdAt, updatedAt, ...input } = p
      const saved = await projects.update(projectId, { ...input, lessons: applyReviewItem(p.lessons, item) })
      return { ok: !!saved, info: '', project: saved ?? undefined }
    })
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
  return { record, review }
}

const GLOBAL_FILE = path.join(DATA_DIR, 'config', 'global-lessons.json')

/** 全局教训：文件不存在或格式不对时当作没有（不让坏文件挡住对话） */
export async function readGlobalLessons(): Promise<GlobalLesson[]> {
  const raw = (await readJson(GLOBAL_FILE)) as { lessons?: unknown } | undefined
  const p = GlobalLessons.safeParse(raw?.lessons ?? [])
  return p.success ? p.data : []
}

/** 整份替换：只有界面上用户确认过的修改走这里，Agent 没有写全局教训的工具 */
export async function writeGlobalLessons(list: GlobalLesson[]) {
  await writeJsonAtomic(GLOBAL_FILE, { lessons: list })
  return list
}
