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
 * 消息文件的最小写入间隔。流式输出时一秒会更新几十次，每次都把几 MB 的对话重新算一遍指纹、
 * 序列化、写一遍盘，磁盘和事件循环都被占满（推送跟着变慢、延迟，前端还会收到积压后一起重渲染）。
 * 窗口内只留最后一次，到点写最新的；任务本身的小文件（不带对话）照旧每次写，崩溃最多丢窗口内这点对话。
 */
const MSG_GAP = 400

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
  /** 消息文件上次写入的时间、窗口内等着写的最新一份和定时器 */
  const msgAt = new Map<string, number>()
  const msgPending = new Map<string, Task>()
  const msgTimers = new Map<string, ReturnType<typeof setTimeout>>()
  onReset(() => {
    metas = null
    loading = null
    full.clear()
    written.clear()
    for (const timer of msgTimers.values()) clearTimeout(timer)
    msgTimers.clear()
    msgPending.clear()
    msgAt.clear()
  })

  const fileOf = (t: { id: string; projectId: string }) => path.join(dirOf(t.projectId), `${t.id}.json`)
  const msgFileOf = (t: { id: string; projectId: string }) => path.join(dirOf(t.projectId), `${t.id}${MSG}`)

  async function writeFull(t: Task) {
    await writeJsonAtomic(fileOf(t), head(t))
  }

  /** 写对话消息：指纹没变就跳过 */
  async function writeMessages(t: Task) {
    const stamp = stampOf(t.messages)
    if (written.get(t.id) === stamp) return
    written.set(t.id, stamp)
    await writeJsonAtomic(msgFileOf(t), t.messages, true)
  }

  /** 同任务的写入排队，前一次失败不影响后面的 */
  function queueWrite(t: Task, run: (x: Task) => Promise<void>) {
    const id = t.id
    const next = (writing.get(id) ?? Promise.resolve()).catch(() => {}).then(() => run(t))
    writing.set(id, next)
    void next.finally(() => writing.get(id) === next && writing.delete(id)).catch(() => {})
    return next
  }

  /**
   * 写对话消息文件：不在窗口内就写，窗口内只留最后一次，到点写最新的一份。
   * 窗口内也要排队写，不能和小文件抢顺序
   */
  function persistMessages(t: Task): Promise<void> | undefined {
    const id = t.id
    const wait = (msgAt.get(id) ?? 0) + MSG_GAP - Date.now()
    if (wait > 0) {
      msgPending.set(id, t)
      if (!msgTimers.has(id)) {
        msgTimers.set(
          id,
          setTimeout(() => {
            msgTimers.delete(id)
            const last = msgPending.get(id)
            msgPending.delete(id)
            if (last) void queueWrite(last, writeMessages)
          }, wait),
        )
      }
      return undefined
    }
    msgAt.set(id, Date.now())
    return queueWrite(t, writeMessages)
  }

  /**
   * 早期版本没有 turnSeenAt：那时的已完成对话都算看过，
   * 否则升级后旧会话会全部亮成未读，还会一直留着 CLI 进程
   */
  function parseTask(raw: unknown): Task | undefined {
    const p = Task.safeParse(raw)
    if (!p.success) return undefined
    const t = p.data
    if (raw && typeof raw === 'object' && !Object.prototype.hasOwnProperty.call(raw, 'turnSeenAt'))
      t.turnSeenAt = t.turnDoneAt
    return t
  }

  /** 旧格式：一个文件里是完整任务，拆成新的两个文件 */
  async function migrate(map: Map<string, Task>) {
    const olds: Task[] = []
    if (existsSync(LEGACY)) {
      const raw = await readJson(LEGACY)
      for (const r of Array.isArray(raw) ? raw : []) {
        const t = parseTask(r)
        if (t && safeId(t.id)) olds.push(t)
      }
      const backup = path.join(CACHE_DIR, 'migrated', `tasks-${Date.now()}.json`)
      await mkdir(path.dirname(backup), { recursive: true })
      await rename(LEGACY, backup).catch(() => unlink(LEGACY).catch(() => {}))
    }
    if (existsSync(ITEMS_DIR)) {
      for (const f of await readdir(ITEMS_DIR)) {
        if (!f.endsWith('.json')) continue
        const t = parseTask(await readJson(path.join(ITEMS_DIR, f)))
        if (t && safeId(t.id)) olds.push(t)
      }
    }
    for (const t of olds) {
      await mkdir(dirOf(t.projectId), { recursive: true })
      await writeFull(t)
      // 拆文件时对话一起写到新的消息文件里，不能只留任务本身
      await writeMessages(t)
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
        const t = parseTask(raw)
        if (t) map.set(t.id, t)
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
    const next = queueWrite(task, writeFull)
    // 对话文件单独节流：任务本身的小文件每次都写，状态和列表不会落后
    const msgs = persistMessages(task)
    return msgs ? Promise.all([next, msgs]).then(() => {}) : next
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
    async update(id: string, input: TaskData & { updatedAt?: string }, opts?: { keepUpdatedAt?: boolean }) {
      const old = await getFull(id)
      if (!old) return null
      // 默认用现在的时间；预热收尾这类要保留原来的列表时间时，用调用方给的值
      const updatedAt = opts?.keepUpdatedAt ? (input.updatedAt ?? old.updatedAt) : new Date().toISOString()
      const item = { ...old, ...input, id, projectId: old.projectId, updatedAt } as Task
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
      // 窗口里还等着写的那份一起丢掉，不能删完又被定时器写回来
      const timer = msgTimers.get(id)
      if (timer) clearTimeout(timer)
      msgTimers.delete(id)
      msgPending.delete(id)
      msgAt.delete(id)
      await (writing.get(id) ?? Promise.resolve()).catch(() => {})
      await unlink(fileOf(meta)).catch(() => {})
      await unlink(msgFileOf(meta)).catch(() => {})
      return true
    },
  }
}
