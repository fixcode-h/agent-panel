import type { Project } from '../../shared/schema.ts'
import type { LessonDraft } from '../lessons.ts'

/**
 * 记项目教训的入口（server/lessons.ts 的 projectLessons(...).record）：服务启动时登记一次。
 * 钩子里自动转正候选（复发的坑）要记教训，钩子拿不到项目存储，走这里；没登记（单测）时记不了，返回原因
 */
type Recorder = (projectId: string, draft: LessonDraft) => Promise<{ ok: boolean; info: string; project?: Project }>

let recorder: Recorder | undefined // 模块状态：启动时登记一次的入口，之后不改

export function setLessonRecorder(fn: Recorder) {
  recorder = fn
}

export function recordLessonDraft(projectId: string, draft: LessonDraft): ReturnType<Recorder> {
  return recorder ? recorder(projectId, draft) : Promise.resolve({ ok: false, info: '面板还没准备好记教训' })
}
