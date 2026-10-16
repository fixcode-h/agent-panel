import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Task, type TaskData } from '../shared/schema.ts'
import { CACHE_DIR, DATA_DIR, onReset, readJson, writeJsonAtomic } from './store.ts'

/** 每个任务一个文件：执行时只重写正在跑的那一个，不用把所有历史任务一起重写 */
export const TASKS_DIR = path.join(DATA_DIR, 'tasks', 'items')
/** 旧版本把所有任务放在一个文件里 */
const LEGACY = path.join(DATA_DIR, 'tasks', 'tasks.json')

const fileOf = (id: string) => path.join(TASKS_DIR, `${id}.json`)
const safeId = (id: string) => /^[\w-]+$/.test(id)

/**
 * 任务记录。全部读进内存（列表、侧栏都要用），写入按任务分别串行化、原子写。
 * 旧的 tasks.json 第一次读时拆成单个文件，原文件挪到缓存目录备份。
 */
export function createTaskStore() {
  let cache: Map<string, Task> | null = null
  let loading: Promise<Map<string, Task>> | null = null
  const writing = new Map<string, Promise<void>>()
  onReset(() => {
    cache = null
    loading = null
  })

  async function load() {
    const map = new Map<string, Task>()
    await mkdir(TASKS_DIR, { recursive: true })
    if (existsSync(LEGACY)) {
      const raw = await readJson(LEGACY)
      for (const r of Array.isArray(raw) ? raw : []) {
        const p = Task.safeParse(r)
        if (p.success && safeId(p.data.id)) await writeJsonAtomic(fileOf(p.data.id), p.data)
      }
      const backup = path.join(CACHE_DIR, 'migrated', `tasks-${Date.now()}.json`)
      await mkdir(path.dirname(backup), { recursive: true })
      await rename(LEGACY, backup).catch(() => unlink(LEGACY).catch(() => {}))
    }
    for (const f of await readdir(TASKS_DIR)) {
      if (!f.endsWith('.json')) continue
      const raw = await readJson(path.join(TASKS_DIR, f))
      const p = Task.safeParse(raw)
      if (p.success) map.set(p.data.id, p.data)
      else if (raw !== undefined) console.error(`任务记录格式不对，已跳过：${f}`)
    }
    return map
  }

  async function all() {
    if (cache) return cache
    loading ??= load().then((m) => (cache = m))
    return loading
  }

  function persist(task: Task) {
    const id = task.id
    // 同一个任务的写入排队，前一次失败不影响后面的
    const next = (writing.get(id) ?? Promise.resolve()).catch(() => {}).then(() => writeJsonAtomic(fileOf(id), task))
    writing.set(id, next)
    void next.finally(() => writing.get(id) === next && writing.delete(id)).catch(() => {})
    return next
  }

  return {
    async list(): Promise<Task[]> {
      return [...(await all()).values()]
    },
    async get(id: string) {
      return (await all()).get(id) ?? null
    },
    async create(input: TaskData & { id?: string }) {
      const now = new Date().toISOString()
      const item = { ...input, id: input.id ?? randomUUID(), createdAt: now, updatedAt: now } as Task
      ;(await all()).set(item.id, item)
      await persist(item)
      return item
    },
    async update(id: string, input: TaskData) {
      const map = await all()
      const old = map.get(id)
      if (!old) return null
      const item = { ...old, ...input, id, updatedAt: new Date().toISOString() } as Task
      map.set(id, item)
      await persist(item)
      return item
    },
    async remove(id: string) {
      const map = await all()
      if (!map.delete(id)) return false
      await (writing.get(id) ?? Promise.resolve()).catch(() => {})
      await unlink(fileOf(id)).catch(() => {})
      return true
    },
  }
}
