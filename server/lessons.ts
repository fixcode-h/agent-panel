import path from 'node:path'
import {
  type Agent,
  type GlobalLesson,
  GlobalLessons,
  type Project,
  type ProjectInput,
  ProjectLesson,
} from '../shared/schema.ts'
import { MAX_LESSONS, newLessonId, normTags, upsertLesson } from '../shared/lessons.ts'
import { t } from '../shared/i18n.ts'
import { applyReviewItem, type LessonReviewItem } from '../shared/lesson-review.ts'
import { loadProjectLessons, saveProjectLessons } from './projects/lessons.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'

type ProjectStore = {
  get(id: string): Promise<Project | null>
  update(id: string, input: ProjectInput): Promise<Project | null>
}

export interface ProjectLessonDeps {
  /** 找「文档」角色（SVN 的文档根在哪）和判断版本管理时用；不传时按没有目录处理 */
  agents: { list(): Promise<Agent[]> }
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
export function projectLessons(projects: ProjectStore, deps?: ProjectLessonDeps) {
  let queue = Promise.resolve()
  const agentList = async () => (deps ? deps.agents.list() : [])
  /** 写文件后把旧项目 JSON 里的 lessons 清空：新条目只存在文件里，旧条目删掉后不会再从 JSON 冒出来 */
  const persist = async (projectId: string, project: Project, agents: Agent[], lessons: ProjectLesson[]) => {
    const written = await saveProjectLessons(project, agents, lessons)
    if (!written.ok) return { ok: false as const, project: undefined, info: written.error || t('项目教训写入失败') }
    const { id, createdAt, updatedAt, ...input } = project
    const saved = await projects.update(projectId, { ...input, lessons: written.inFile ? [] : written.lessons })
    if (!saved) return { ok: false as const, project: undefined, info: t('项目不存在') }
    // 接口返回给界面的项目要带上刚写进去的教训，不能是刚清空的旧字段
    return { ok: true as const, project: { ...saved, lessons: written.lessons } }
  }
  const record = (projectId: string, draft: LessonDraft) => {
    const run = queue.then(async () => {
      const p = await projects.get(projectId)
      if (!p) return { ok: false, project: undefined, info: t('项目不存在') }
      const agents = await agentList()
      // 读的是文件 + 旧 JSON 的合并结果：旧条目一样能改写
      const current = (await loadProjectLessons(p, agents)).lessons
      const { replaces, why, ...rest } = draft
      if (replaces && !current.some((l) => l.id === replaces))
        return {
          ok: false,
          project: undefined,
          info: replaces.startsWith('g')
            ? '全局教训只有用户能改。和它冲突时以项目教训为准：不带 id 记一条项目教训，写明这个项目的例外。'
            : `没有 id 为 ${replaces} 的项目教训：先用 project_lessons 查到它的 id；要新记一条就不带 id。`,
        }
      const parsed = ProjectLesson.safeParse({
        ...rest,
        // 和已有标签只差大小写、带 # 的统一成已有的写法
        tags: normTags(
          rest.tags ?? [],
          current.flatMap((l) => l.tags),
        ),
        // 改写时的 id 用原来那条的，新记的才生成
        id: replaces || rest.id || newLessonId(),
        createdAt: rest.createdAt || new Date().toISOString(),
      })
      if (!parsed.success)
        return { ok: false, project: undefined, info: parsed.error.issues.map((i) => i.message).join('；') }
      const r = upsertLesson(current, parsed.data, { replaces, why })
      if (r.full)
        return {
          ok: false,
          project: undefined,
          info: t('项目教训已经有 {n} 条，先在项目设置里合并同类项再记', { n: MAX_LESSONS }),
        }
      const saved = await persist(projectId, p, agents, r.list)
      return {
        ...saved,
        info: r.added
          ? `已记下：${parsed.data.title}`
          : replaces
            ? `已改写教训：${parsed.data.title}`
            : `已更新同名的教训：${parsed.data.title}`,
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
      if (!p) return { ok: false, project: undefined, info: t('项目不存在') }
      const agents = await agentList()
      const current = (await loadProjectLessons(p, agents)).lessons
      if (item.action !== 'delete' && !current.some((l) => l.id === item.id))
        return { ok: false, project: undefined, info: t('这条教训已经不在了') }
      const saved = await persist(projectId, p, agents, applyReviewItem(current, item))
      return { ...saved, info: '' }
    })
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
  /**
   * 项目设置里整份保存教训（PUT /projects/:id 带 lessons）：
   * 和 record / review 用同一个队列，在队列里再核对一次版本——校验之后、写文件之前 Agent 刚记了新教训时，
   * 不能拿用户打开设置时的旧快照把文件整份覆盖掉。
   */
  const replace = (projectId: string, input: ProjectInput, expectedUpdatedAt?: string) => {
    const run = queue.then(async () => {
      const p = await projects.get(projectId)
      if (!p) return { ok: false as const, project: undefined, info: t('项目不存在'), status: 404 as const }
      if (expectedUpdatedAt !== undefined && p.updatedAt !== expectedUpdatedAt)
        return {
          ok: false as const,
          project: undefined,
          info: t('项目在别处被修改过，请刷新后重试'),
          status: 409 as const,
        }
      const written = await saveProjectLessons(
        { path: input.path, agentParams: input.agentParams },
        await agentList(),
        input.lessons,
      )
      if (!written.ok)
        return {
          ok: false as const,
          project: undefined,
          info: written.error || t('项目教训写入失败'),
          status: 400 as const,
        }
      const saved = await projects.update(projectId, { ...input, lessons: written.inFile ? [] : written.lessons })
      if (!saved) return { ok: false as const, project: undefined, info: t('项目不存在'), status: 404 as const }
      return { ok: true as const, project: { ...saved, lessons: written.lessons } }
    })
    queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
  return { record, review, replace }
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
