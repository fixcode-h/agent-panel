import { Hono } from 'hono'
import path from 'node:path'
import type { InterruptedTask, InterruptedTasks } from '../shared/version.ts'
import type { Task } from '../shared/schema.ts'
import { t } from '../shared/i18n.ts'
import { openPlan } from '../shared/plan.ts'
import { CACHE_DIR, readJson, writeJsonAtomic } from './store.ts'

/**
 * 被「强制更新」打断的任务：停 CLI 之前记下 id，新版本启动后弹窗问用户要不要继续。
 * 只记强制更新这一次（普通更新、崩溃、手动重启不记），文件放在缓存目录，用户可以随时清理。
 */
const FILE = () => path.join(CACHE_DIR, 'interrupted-by-update.json')

/** 记下的是「当时在做的事」，重启之后节点状态已经变了，所以在这里一起存下来 */
export interface InterruptedEntry {
  id: string
  doing: string
}

export interface InterruptedRecord {
  at: string
  /** 用户已经在弹窗里处理过了：保留记录，但不再自动弹 */
  acknowledged: boolean
  tasks: InterruptedEntry[]
}

const EMPTY: InterruptedRecord = { at: '', acknowledged: false, tasks: [] }

/** 记下这次强制更新打断的任务，覆盖上一次的记录；没有任务时不写，免得把上次没处理完的记录冲掉 */
export async function recordInterrupted(tasks: InterruptedEntry[]) {
  if (!tasks.length) return
  const record: InterruptedRecord = { at: new Date().toISOString(), acknowledged: false, tasks }
  await writeJsonAtomic(FILE(), record)
}

/** 读记录；文件不在或格式不对时当作没有 */
export async function readInterrupted(): Promise<InterruptedRecord> {
  const raw = await readJson(FILE())
  if (!raw || typeof raw !== 'object') return EMPTY
  const r = raw as Partial<InterruptedRecord>
  if (!Array.isArray(r.tasks)) return EMPTY
  return {
    at: typeof r.at === 'string' ? r.at : '',
    acknowledged: r.acknowledged === true,
    tasks: r.tasks
      .filter((x): x is InterruptedEntry => !!x && typeof x.id === 'string' && typeof x.doing === 'string')
      .map((x) => ({ id: x.id, doing: x.doing })),
  }
}

/** 用户处理过了：不再自动弹，记录留着（设置里清理缓存时一起删掉） */
export async function acknowledgeInterrupted() {
  const r = await readInterrupted()
  if (!r.tasks.length) return
  await writeJsonAtomic(FILE(), { ...r, acknowledged: true })
}

/**
 * 换成页面上能显示的列表：任务可能已经被删掉、归档、导入，或者在弹窗出现前就已经跑完了，
 * 这些都不列出来。项目名从项目列表取，取不到时用空字符串（页面只显示任务标题）。
 */
export async function resolveInterrupted(
  record: InterruptedRecord,
  getTask: (id: string) => Promise<Task | null>,
  projectName: (id: string) => Promise<string>,
): Promise<InterruptedTask[]> {
  const out: InterruptedTask[] = []
  for (const entry of record.tasks) {
    const task = await getTask(entry.id)
    if (!task || task.imported || task.archived || !isResumable(task)) continue
    out.push({
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      projectName: task.projectId ? await projectName(task.projectId) : '',
      // 记下来的节点标题比现在的状态可靠：重启时节点已经变回 pending 了
      doing: entry.doing || lastAsk(task),
    })
  }
  return out
}

/**
 * 页面读、确认这两个接口：放在 /app 下面（和版本更新同一组）。
 * 读取时顺便把记录里的任务过滤一遍，已删除、归档、导入、又跑起来的都不再列出。
 */
export function interruptedApi(deps: {
  /** 等启动时的迁移做完 */
  ready: () => Promise<unknown>
  getTask: (id: string) => Promise<Task | null>
  projectName: (id: string) => Promise<string>
}) {
  const body = async (): Promise<InterruptedTasks> => {
    await deps.ready().catch(() => {})
    const r = await readInterrupted()
    return {
      at: r.at,
      acknowledged: r.acknowledged,
      tasks: await resolveInterrupted(r, deps.getTask, deps.projectName),
    }
  }
  return (
    new Hono()
      .get('/interrupted', async (c) => c.json(await body()))
      // 用户关掉弹窗或点「继续执行」之后调用：保留记录，但不再自动弹
      .post('/interrupted/ack', async (c) => {
        await acknowledgeInterrupted()
        return c.json(await body())
      })
  )
}

/** 继续执行接口接受的两种状态 */
const isResumable = (task: Task) => task.status === 'stopped' || task.status === 'failed'

/**
 * 记下来的「被打断时在做什么」：正在执行的节点 → 没做完的计划进度 → 最后一条要求。
 * 停在等下一句、计划只做到 12/17 的父对话也要进恢复名单（见 restartUnfinished），
 * 它没有在跑的节点，只写最后一条要求看不出还剩多少活没做完
 */
export function restartDoing(task: Pick<Task, 'steps' | 'plans' | 'messages'>) {
  const step = task.steps.find((s) => s.status === 'running')?.title
  if (step) return step
  const plan = openPlan(task)
  if (plan) return t('计划 {done}/{total}', { done: plan.done, total: plan.total })
  return lastAsk(task)
}

/** 最后一条要求的第一行：没有节点时用它说明当时在做什么 */
export function lastAsk(task: Pick<Task, 'messages'>) {
  const last = [...task.messages].reverse().find((m) => m.role === 'user')
  return (last?.text ?? '').trim().split('\n')[0].slice(0, 60)
}
