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

/** 读过对话的任务最多留这么多个在内存里（正在执行的另外由执行器拿着） */
const KEEP_FULL = 12

/** 每个任务的指纹缓存：跟上一次算的时候比，只重算变了的那几条消息 */
type StampCache = {
  ids: string[]
  /** 与 ids 对应的骨架（不含工具输出内容），用来认出中间哪条被原地改过 */
  shapes: string[]
  /** 与 ids 对应的完整指纹 */
  stamps: string[]
  /** 上次整体核对的时间 */
  verifiedAt: number
}

/**
 * 消息指纹的增量计算。
 *
 * 为什么不再每次全量算：任务越长，算一次越贵——`messageStamp` 要把每条消息的每个工具输出逐字符扫一遍，
 * 而执行中的任务每秒钟都会被问一次「消息变了没有、要不要落盘」（`server/tasks.ts` 的 `changed`）。
 * 一秒一次 O(全部工具输出) 的字符串扫描就是持续的抖动和高位堆，任务越长越明显。
 *
 * 现在只在这些位置重算，其余沿用上次存的指纹：
 * - 最后一条消息：流式输出一直在改它，代价有上界（只有一条）；
 * - 骨架变了的那条：并发节点会去改不是末尾的消息，骨架（文字、工具名和输出长度类字段）变了就能认出来；
 * - 到隔一段时间整体重算一次：工具输出是按快照替换的，长度可能刚好不变（边跑边刷新的状态行），
 *   骨架看不出来，靠这个兜底。漏写盘最多晚一个间隔，下次核对时会认出来并补写。
 */
export function createStampTracker(verifyMs = 10_000) {
  const cache = new Map<string, StampCache>()
  /** 测试和测量用：完整指纹、骨架各算了多少次 */
  let full = 0
  let shape = 0
  return {
    /** 消息数组的指纹（存进 written 的那份）：条数 + 每条 id 和指纹 */
    stamp(id: string, msgs: TaskMessage[]): string {
      const prev = cache.get(id)
      const now = Date.now()
      const verify = !prev || now - prev.verifiedAt >= verifyMs
      const last = msgs.length - 1
      const next: StampCache = { ids: [], shapes: [], stamps: [], verifiedAt: verify ? now : prev!.verifiedAt }
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        const skeleton = messageStamp(m, false)
        shape++
        // 末尾那条每次重算；中间的骨架没变就沿用上次的完整指纹
        const same = !verify && i !== last && prev!.ids[i] === m.id && prev!.shapes[i] === skeleton
        let stamp: string
        if (same) stamp = prev!.stamps[i]
        else {
          stamp = messageStamp(m)
          full++
        }
        next.ids.push(m.id)
        next.shapes.push(skeleton)
        next.stamps.push(stamp)
      }
      cache.set(id, next)
      return `${msgs.length}:${next.ids.map((x, i) => x + next.stamps[i]).join(';')}`
    },
    forget(id: string) {
      cache.delete(id)
    },
    clear() {
      cache.clear()
    },
    stats() {
      return { full, shape }
    },
  }
}

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
  /** 消息指纹的增量缓存，按任务一份 */
  const stamps = createStampTracker()
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
    stamps.clear()
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

  /** 写对话消息：指纹没变就跳过（增量算，不每次扫全部工具输出） */
  async function writeMessages(t: Task) {
    const stamp = stamps.stamp(t.id, t.messages)
    if (written.get(t.id) === stamp) return
    await writeJsonAtomic(msgFileOf(t), t.messages, true)
    // 写成功才记指纹：写失败（磁盘满、杀毒软件占着文件）时下一次还要重试，不然这段对话就再也不落盘了
    written.set(t.id, stamp)
    // 窗口按「真的写了盘」的时间算：窗口里合并写的那一次也要算，不然下一次会提前破窗口
    msgAt.set(t.id, Date.now())
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
   * window 为 false（关键节点、任务结束/失败/停止）时立即写，窗口里排着的那份作废：写的就是最新内容
   */
  function persistMessages(t: Task, window = true): Promise<void> | undefined {
    const id = t.id
    const wait = (msgAt.get(id) ?? 0) + MSG_GAP - Date.now()
    if (window && wait > 0) {
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
    // 立即写：排着的定时器和那份旧内容一起收掉，不做到点又把旧内容写回来
    const timer = msgTimers.get(id)
    if (timer) clearTimeout(timer)
    msgTimers.delete(id)
    msgPending.delete(id)
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
    if (p.success) written.set(id, stamps.stamp(id, task.messages))
    remember(task)
    return task
  }

  function remember(task: Task) {
    full.delete(task.id)
    full.set(task.id, task)
    while (full.size > KEEP_FULL) {
      const old = full.keys().next().value!
      full.delete(old)
      // 对话已经不在内存里了，它的指纹缓存也一起丢：下次真的写它的时候重算一次（指纹值不变，不会多写一次盘）
      stamps.forget(old)
    }
  }

  function persist(task: Task, opts?: { now?: boolean }) {
    const next = queueWrite(task, writeFull)
    // 对话文件单独节流：任务本身的小文件每次都写，状态和列表不会落后
    const msgs = persistMessages(task, !opts?.now)
    return msgs ? Promise.all([next, msgs]).then(() => {}) : next
  }

  return {
    /** 所有任务，只带用户发的消息（列表、摘要、附件清理用）；要完整对话用 get */
    async list(): Promise<Task[]> {
      return [...(await all()).values()]
    },
    get: getFull,
    /**
     * 任务本身（用量、节点、状态、标题…），不读 `.messages.json`：
     * 返回的 messages 只有任务文件里的那几条用户消息。
     * 每秒都在刷的用量统计用它——用 getFull 会把整棵树每个任务的对话都读进内存，还会把打开过的任务挤出 full 缓存
     */
    async getMeta(id: string): Promise<Task | null> {
      const hit = full.get(id)
      if (hit) return hit
      return (await all()).get(id) ?? null
    },
    async create(input: TaskData & { id?: string }) {
      const now = new Date().toISOString()
      const item = { ...input, id: input.id ?? randomUUID(), createdAt: now, updatedAt: now } as Task
      ;(await all()).set(item.id, head(item))
      remember(item)
      await persist(item)
      return item
    },
    /** 只要任务本身（不带对话）：实时推送判断有没有变化时用，不为一个没变的任务去读几 MB 的对话文件 */
    async peek(id: string): Promise<Task | null> {
      return (await all()).get(id) ?? null
    },
    /**
     * keepUpdatedAt：保留原来的列表时间（预热收尾这类）。
     * now：对话消息立即写，不走 400ms 合并窗口——关键节点（节点开始/结束、提问、任务结束/失败/停止）
     * 用它，面板被强杀时不会丢最后一段内容；流式输出途中的中间态仍然合并写
     */
    async update(
      id: string,
      input: TaskData & { updatedAt?: string },
      opts?: { keepUpdatedAt?: boolean; now?: boolean },
    ) {
      // 调用方给了完整对话（执行中的落盘都是）就不用再读旧的：读过的对话只留 KEEP_FULL 个，
      // 同时在跑的对话一多（父对话派出十几个子对话），每次落盘都会把别人挤出去、自己又从磁盘重读一遍对话，
      // 读文件 + 校验几 MB 的 JSON 一秒几十次，事件循环被占满，整个面板跟着卡
      const old = Array.isArray(input.messages) ? (await all()).get(id) : await getFull(id)
      if (!old) return null
      // 默认用现在的时间；预热收尾这类要保留原来的列表时间时，用调用方给的值
      const updatedAt = opts?.keepUpdatedAt ? (input.updatedAt ?? old.updatedAt) : new Date().toISOString()
      const item = { ...old, ...input, id, projectId: old.projectId, updatedAt } as Task
      ;(await all()).set(id, head(item))
      remember(item)
      await persist(item, opts)
      return item
    },
    async remove(id: string) {
      const map = await all()
      const meta = map.get(id)
      if (!meta) return false
      map.delete(id)
      full.delete(id)
      written.delete(id)
      stamps.forget(id)
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
