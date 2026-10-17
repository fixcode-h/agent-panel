import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Task, TaskMessage, type TaskData } from '../shared/schema.ts'
import { messageStamp } from '../shared/task.ts'
import { CACHE_DIR, DATA_DIR, onReset, readJson, writeJsonAtomic } from './store.ts'

/**
 * 任务按项目分目录存，每个任务两个文件：
 *
 *   tasks/projects/<项目 id>/<任务 id>.json            任务本身（节点、用量、改动…），只带用户发的消息
 *   tasks/projects/<项目 id>/<任务 id>.messages.json   全部对话消息
 *   tasks/chats/…                                      Chat 模式的聊天（不属于任何项目）
 *
 * 启动时只读第一种（小），列表、侧栏都够用；对话消息在打开任务时才读，读过的留一些在内存里。
 */
export const TASKS_ROOT = path.join(DATA_DIR, 'tasks')
/** 上一版：每个任务一个完整文件，不分项目 */
const ITEMS_DIR = path.join(TASKS_ROOT, 'items')
/** 更早的版本把所有任务放在一个文件里 */
const LEGACY = path.join(TASKS_ROOT, 'tasks.json')

const safeId = (id: string) => /^[\w-]+$/.test(id)
const dirOf = (projectId: string) =>
  projectId && safeId(projectId) ? path.join(TASKS_ROOT, 'projects', projectId) : path.join(TASKS_ROOT, 'chats')
const MSG = '.messages.json'

/** 任务文件里只放用户消息：摘要要第一条要求，清理附件要知道哪些附件还在用 */
const head = (t: Task): Task => ({ ...t, messages: t.messages.filter((m) => m.role === 'user') })
const stampOf = (msgs: TaskMessage[]) => `${msgs.length}:${msgs.map((m) => m.id + messageStamp(m)).join(';')}`

/** 读过对话的任务最多留这么多个在内存里（正在执行的另外由执行器拿着） */
const KEEP_FULL = 12

/**
 * 任务记录：任务本身全部读进内存，对话消息按需读。写入按任务串行化、原子写；
 * 消息没变时只重写小的任务文件。旧格式第一次读时转换，原文件挪到缓存目录备份。
 */
export function createTaskStore() {
  let metas: Map<string, Task> | null = null
  let loading: Promise<Map<string, Task>> | null = null
  /** 已经读了对话的任务（最近用过的在后面） */
  const full = new Map<string, Task>()
  /** 每个任务上次写入的消息指纹，没变就不重写消息文件 */
  const written = new Map<string, string>()
  const writing = new Map<string, Promise<void>>()
  onReset(() => {
    metas = null
    loading = null
    full.clear()
    written.clear()
  })

  const fileOf = (t: { id: string; projectId: string }) => path.join(dirOf(t.projectId), `${t.id}.json`)
  const msgFileOf = (t: { id: string; projectId: string }) => path.join(dirOf(t.projectId), `${t.id}${MSG}`)

  async function writeFull(t: Task) {
    const stamp = stampOf(t.messages)
    if (written.get(t.id) !== stamp) {
      await writeJsonAtomic(msgFileOf(t), t.messages, true)
      written.set(t.id, stamp)
    }
    await writeJsonAtomic(fileOf(t), head(t))
  }

  /** 旧格式：一个文件里是完整任务，拆成新的两个文件 */
  async function migrate(map: Map<string, Task>) {
    const olds: Task[] = []
    if (existsSync(LEGACY)) {
      const raw = await readJson(LEGACY)
      for (const r of Array.isArray(raw) ? raw : []) {
        const p = Task.safeParse(r)
        if (p.success && safeId(p.data.id)) olds.push(p.data)
      }
      const backup = path.join(CACHE_DIR, 'migrated', `tasks-${Date.now()}.json`)
      await mkdir(path.dirname(backup), { recursive: true })
      await rename(LEGACY, backup).catch(() => unlink(LEGACY).catch(() => {}))
    }
    if (existsSync(ITEMS_DIR)) {
      for (const f of await readdir(ITEMS_DIR)) {
        if (!f.endsWith('.json')) continue
        const p = Task.safeParse(await readJson(path.join(ITEMS_DIR, f)))
        if (p.success && safeId(p.data.id)) olds.push(p.data)
      }
    }
    for (const t of olds) {
      await mkdir(dirOf(t.projectId), { recursive: true })
      await writeFull(t)
      map.set(t.id, head(t))
    }
    if (existsSync(ITEMS_DIR)) {
      for (const t of olds) await unlink(path.join(ITEMS_DIR, `${t.id}.json`)).catch(() => {})
      await rmdir(ITEMS_DIR).catch(() => {})
    }
  }

  async function load() {
    const map = new Map<string, Task>()
    const dirs = [path.join(TASKS_ROOT, 'chats')]
    const projectsDir = path.join(TASKS_ROOT, 'projects')
    if (existsSync(projectsDir))
      for (const d of await readdir(projectsDir, { withFileTypes: true }))
        if (d.isDirectory()) dirs.push(path.join(projectsDir, d.name))
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.json') || f.endsWith(MSG)) continue
        const raw = await readJson(path.join(dir, f))
        const p = Task.safeParse(raw)
        if (p.success) map.set(p.data.id, p.data)
        else if (raw !== undefined) console.error(`任务记录格式不对，已跳过：${f}`)
      }
    }
    await migrate(map)
    return map
  }

  async function all() {
    if (metas) return metas
    loading ??= load().then((m) => (metas = m))
    return loading
  }

  /** 完整任务（带全部消息）；读过的放进内存，超出数量时丢掉最久没用的 */
  async function getFull(id: string): Promise<Task | null> {
    const hit = full.get(id)
    if (hit) {
      full.delete(id)
      full.set(id, hit)
      return hit
    }
    const meta = (await all()).get(id)
    if (!meta) return null
    const raw = await readJson(msgFileOf(meta))
    const p = TaskMessage.array().safeParse(raw)
    // 消息文件丢了或坏了：至少还有用户发的那些
    const task = { ...meta, messages: p.success ? p.data : meta.messages }
    if (p.success) written.set(id, stampOf(task.messages))
    remember(task)
    return task
  }

  function remember(task: Task) {
    full.delete(task.id)
    full.set(task.id, task)
    while (full.size > KEEP_FULL) full.delete(full.keys().next().value!)
  }

  function persist(task: Task) {
    const id = task.id
    // 同一个任务的写入排队，前一次失败不影响后面的
    const next = (writing.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(dirOf(task.projectId), { recursive: true })
        await writeFull(task)
      })
    writing.set(id, next)
    void next.finally(() => writing.get(id) === next && writing.delete(id)).catch(() => {})
    return next
  }

  return {
    /** 所有任务，只带用户发的消息（列表、摘要、附件清理用）；要完整对话用 get */
    async list(): Promise<Task[]> {
      return [...(await all()).values()]
    },
    get: getFull,
    async create(input: TaskData & { id?: string }) {
      const now = new Date().toISOString()
      const item = { ...input, id: input.id ?? randomUUID(), createdAt: now, updatedAt: now } as Task
      ;(await all()).set(item.id, head(item))
      remember(item)
      await persist(item)
      return item
    },
    async update(id: string, input: TaskData) {
      const old = await getFull(id)
      if (!old) return null
      const item = { ...old, ...input, id, projectId: old.projectId, updatedAt: new Date().toISOString() } as Task
      ;(await all()).set(id, head(item))
      remember(item)
      await persist(item)
      return item
    },
    async remove(id: string) {
      const map = await all()
      const meta = map.get(id)
      if (!meta) return false
      map.delete(id)
      full.delete(id)
      written.delete(id)
      await (writing.get(id) ?? Promise.resolve()).catch(() => {})
      await unlink(fileOf(meta)).catch(() => {})
      await unlink(msgFileOf(meta)).catch(() => {})
      return true
    },
  }
}
