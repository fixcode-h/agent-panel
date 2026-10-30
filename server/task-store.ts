import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Task, TaskMessage, type TaskData } from '../shared/schema.ts'
import { t } from '../shared/i18n.ts'
import { messageStamp, taskTitle } from '../shared/task.ts'
import { removeTaskLog, setTaskLogPath } from './task-log.ts'
import {
  CACHE_DIR,
  DATA_DIR,
  archiveBrokenFile,
  onReset,
  readJson,
  readJsonDetailed,
  writeJsonAtomic,
} from './store.ts'

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
/**
 * 留在内存里的对话合计最多这么多字符（正文、思考、工具的输入输出）。只按个数限的话，
 * 十几个带大段工具输出的长对话（每个几百万字符）能占上百 MB，打开过一遍就一直挂着；
 * 超了先丢最久没用的，最近用的两个总是留着（刚打开的那个马上还要用）。中文字符在内存里两个字节，约 32 MB
 */
const KEEP_CHARS = 16_000_000
const KEEP_MIN = 2

/** 一个任务的对话大概多大：只累加字符串长度，不序列化，执行中每次落盘都算一遍也不贵 */
export function messageChars(msgs: TaskMessage[]) {
  let n = 0
  for (const m of msgs) {
    n += m.text.length + (m.thinking?.length ?? 0) + (m.prompt?.length ?? 0)
    for (const t of m.tools) n += t.label.length + (t.input?.length ?? 0) + (t.output?.length ?? 0)
  }
  return n
}

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
  /** full 里每个任务的对话字符数（messageChars）和合计 */
  const sizes = new Map<string, number>()
  let fullChars = 0
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
    sizes.clear()
    fullChars = 0
    written.clear()
    stamps.clear()
    for (const timer of msgTimers.values()) clearTimeout(timer)
    msgTimers.clear()
    msgPending.clear()
    msgAt.clear()
  })

  const fileOf = (t: { id: string; projectId: string }) => path.join(dirOf(t.projectId), `${t.id}.json`)
  const msgFileOf = (t: { id: string; projectId: string }) => path.join(dirOf(t.projectId), `${t.id}${MSG}`)
  // 对话专属日志和对话文件放在一起（见 task-log.ts）：按 id 找它属于哪个项目目录，内存里没有的不写
  const logFileOf = (t: { id: string; projectId: string }) => path.join(dirOf(t.projectId), `${t.id}.log`)
  setTaskLogPath((id) => {
    const t = full.get(id) ?? metas?.get(id)
    return t ? logFileOf(t) : undefined
  })

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
    // 「在排队等名额」是内存里的临时状态（此刻真的在排队才该有），进程重启后不可能还在排。
    // 旧版本可能在让出名额 / 保活等下一句时漏清它，快照里就带着一条陈旧标记（页面上显示成在排队）；
    // 这里丢掉，免得重启后凭空显示排队。以后每轮跑起来写回快照时再按当时情况重新写
    delete t.apiWait
    for (const s of t.steps) delete s.apiWait
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
    const dirs: { dir: string; projectId: string }[] = [{ dir: path.join(TASKS_ROOT, 'chats'), projectId: '' }]
    const projectsDir = path.join(TASKS_ROOT, 'projects')
    if (existsSync(projectsDir))
      for (const d of await readdir(projectsDir, { withFileTypes: true }))
        if (d.isDirectory()) dirs.push({ dir: path.join(projectsDir, d.name), projectId: d.name })
    const rebuilt: string[] = []
    /** 任务记录过不了 schema、没能留档的 id：原文件还在原位，重建时不能覆盖它 */
    const kept = new Set<string>()
    for (const { dir, projectId } of dirs) {
      if (!existsSync(dir)) continue
      const names = await readdir(dir)
      for (const f of names) {
        if (!f.endsWith('.json') || f.endsWith(MSG)) continue
        const file = path.join(dir, f)
        const raw = await readJsonDetailed(file)
        // 坏了的那份已经被 readJsonDetailed 挪进缓存目录并打了日志：这里当「这个任务的记录读不出来」处理，
        // 下面会用同目录的 `.messages.json` 把它重建回来，不能让整个对话从列表里消失
        const task = raw.state === 'ok' ? parseTask(raw.value) : undefined
        if (task) map.set(task.id, task)
        else if (raw.state === 'ok' && !(await archiveBadMeta(file, f))) kept.add(f.slice(0, -'.json'.length))
      }
      // 只有 `.messages.json`、没有（或丢了、坏了）任务记录：从对话反推一个最小的任务记录，
      // 让这个对话重新出现在列表里、内容能打开。同一个 load 里做，不另起一次扫描
      for (const f of names) {
        if (!f.endsWith(MSG)) continue
        const id = f.slice(0, -MSG.length)
        if (map.has(id)) continue
        if (!safeId(id)) {
          console.error(`任务对话文件名不是合法 id，已跳过：${f}`)
          continue
        }
        if (await rebuildMeta(dir, projectId, id, map, kept.has(id))) rebuilt.push(id)
      }
    }
    if (rebuilt.length) console.error(`这些对话的任务记录丢失，已从对话内容重建：${rebuilt.join('、')}`)
    await migrate(map)
    return map
  }

  /**
   * 能读成 JSON、但过不了任务 schema 的记录：先留档再当「读不出来」处理。
   * 不留档的话，从对话反推的记录会直接把它盖掉：原来那份（可能手修一下还能用）就没了。
   * 返回是否真的留档了：没留档（文件被占着）时调用方不能再往同一个路径写。
   */
  async function archiveBadMeta(file: string, name: string) {
    const size = (await stat(file).catch(() => null))?.size ?? 0
    const broken = await archiveBrokenFile(file, '任务记录格式不对', size)
    console.error(
      broken.archived
        ? `任务记录格式不对，已留档为 ${broken.backup}（按对话内容重建）：${name}`
        : `任务记录格式不对，没能挪进缓存目录：${name}`,
    )
    return broken.archived
  }

  /**
   * 从 `.messages.json` 反推缺失的任务记录（meta），写盘后放进 map。
   * 返回是否真的重建了。
   *
   * 宁可不重建也不写半截：对话文件本身坏了 / 不是一个消息数组时，把它当作坏文件留档、打日志，
   * 不伪造内容；反推出的记录过不了 schema 校验时也只打日志。
   * 坏文件被挪走后下次启动不会再在目录里看到它，所以不会反复重试。
   *
   * keepExisting：原来的 meta 还在原位（没能留档）时为 true，这时只让它本次可见、不写盘，
   * 不能拿新记录覆盖原来那份可能手修还能用的。
   */
  async function rebuildMeta(
    dir: string,
    projectId: string,
    id: string,
    map: Map<string, Task>,
    keepExisting = false,
  ): Promise<boolean> {
    const file = path.join(dir, `${id}${MSG}`)
    let res: Awaited<ReturnType<typeof readJsonDetailed>>
    try {
      res = await readJsonDetailed(file)
    } catch (err) {
      // 文件被杀软 / 索引服务占着（EBUSY / EPERM）或权限不对：这一个任务跳过，不能让整个任务列表崩掉
      console.error(`任务 ${id} 的对话文件读不出来，这次跳过（下次启动会再试）：${String(err)}`)
      return false
    }
    // 名字是 readdir 时看到的，这中间被别的流程挪走了：没什么可重建的
    if (res.state === 'missing') return false
    if (res.state === 'broken') {
      console.error(
        res.broken.archived
          ? `任务 ${id} 的任务记录已丢失，对话文件也损坏（${res.broken.size} 字节），无法恢复：已留档为 ${res.broken.backup}`
          : `任务 ${id} 的任务记录已丢失，对话文件也损坏（${res.broken.size} 字节），无法恢复（也没能挪进缓存目录）`,
      )
      return false
    }
    const parsed = TaskMessage.array().safeParse(res.value)
    if (!parsed.success) {
      // 能读成 JSON，但内容不是对话（比如被写成了插件配置）：同样留档，免得到点又重读一遍
      const size = (await stat(file).catch(() => null))?.size ?? 0
      const broken = await archiveBrokenFile(file, '对话内容不是一个消息数组', size)
      console.error(
        broken.archived
          ? `任务 ${id} 的任务记录已丢失，对话文件内容不是消息列表，无法恢复：已留档为 ${broken.backup}`
          : `任务 ${id} 的任务记录已丢失，对话文件内容不是消息列表，无法恢复（也没能挪进缓存目录）`,
      )
      return false
    }
    const messages = parsed.data
    // 空对话没有可恢复的内容：不造一个 0 条消息的空任务（断电后正好可能留下「meta 全 0 + messages 为 []」）
    if (!messages.length) {
      console.error(`任务 ${id} 的任务记录已丢失，对话文件是空的，没有可恢复的内容`)
      return false
    }
    const mtime = new Date()
    const users = messages.filter((m) => m.role === 'user')
    const original = Task.safeParse({
      id,
      projectId,
      // 标题用用户自己写的第一句，没有用户消息时给个能认出来的占位
      title: (users[0] && taskTitle(users[0].text)) || t('恢复的对话'),
      // 工作流快照、节点、运行记录都在丢掉的记录里，只能按对话恢复
      mode: 'chat',
      // 记录丢了就不知道它当时在干什么：启动后当作被重启打断的旧对话，让用户可以继续
      status: 'stopped',
      stopReason: 'restart',
      createdAt: messages[0]?.at || mtime.toISOString(),
      updatedAt: messages[messages.length - 1]?.at || mtime.toISOString(),
      // 任务记录里只放用户消息，完整对话在消息文件里
      messages: users,
      // 这是真实数据，按演示数据画出来会误导用户
      simulated: false,
      // 重建出来的对话先当已看过，不要升级成一片未读红点
      turnSeenAt: messages[messages.length - 1]?.at ?? '',
    })
    if (!original.success) {
      console.error(`任务 ${id} 的任务记录已丢失，按对话反推的记录不合法，不重建：${original.error.message}`)
      return false
    }
    if (keepExisting) {
      // 原来的 meta 没能留档、还在原位：这次只让它出现在列表里，不写盘，下次启动再处理那份原文件
      map.set(original.data.id, head(original.data))
      console.error(`任务 ${id} 已按对话内容恢复（原记录还在原位、没能留档，本次不覆盖）`)
      return true
    }
    try {
      // 写回扫描时的那个目录：不按 projectId 重新算路径，免得目录名不规范时写错地方
      await writeJsonAtomic(path.join(dir, `${id}.json`), head(original.data))
    } catch (err) {
      // 写不下去也让它本次启动可见：用户至少能把对话打开、导出，下次启动还会再试一次重建
      console.error(`任务 ${id} 的任务记录重建后写盘失败（本次仍可使用）：${String(err)}`)
    }
    map.set(original.data.id, head(original.data))
    console.error(`任务记录丢失，已从对话内容恢复：${original.data.id}（${original.data.title}）`)
    return true
  }

  async function all() {
    if (metas) return metas
    loading ??= load().then(
      (m) => (metas = m),
      (err) => {
        // 一次瞬时读错误（文件被杀软占着之类）不能变成永久故障：清掉 loading，下一次请求重新读
        loading = null
        throw err
      },
    )
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

  function drop(id: string) {
    full.delete(id)
    fullChars -= sizes.get(id) ?? 0
    sizes.delete(id)
  }

  function remember(task: Task) {
    drop(task.id)
    full.set(task.id, task)
    const n = messageChars(task.messages)
    sizes.set(task.id, n)
    fullChars += n
    while (full.size > KEEP_FULL || (fullChars > KEEP_CHARS && full.size > KEEP_MIN)) {
      const old = full.keys().next().value!
      drop(old)
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

  /** 每个对话的两个文件在磁盘上占多少（数据页按项目、父子对话列占用用） */
  async function diskSizes() {
    const out: { id: string; bytes: number }[] = []
    for (const meta of (await all()).values()) {
      let bytes = 0
      for (const f of [fileOf(meta), msgFileOf(meta)])
        bytes += await stat(f).then(
          (x) => x.size,
          () => 0,
        )
      out.push({ id: meta.id, bytes })
    }
    return out
  }

  return {
    diskSizes,
    /** 所有任务，只带用户发的消息（列表、摘要、附件清理用）；要完整对话用 get */
    async list(): Promise<Task[]> {
      return [...(await all()).values()]
    },
    get: getFull,
    /**
     * 只读对话消息，不进 full 缓存：对话搜索一次要扫几十个对话，
     * 走 get 会把用户正在看的那份挤出缓存（下次打开又要重读几 MB）
     */
    /**
     * 消息文件现在的指纹（mtime + 大小）：调用方按它判断要不要重读。
     * 搜索缓存不能用任务的 updatedAt 当 key——消息文件有 400ms 合并写窗口，任务文件先更新，
     * 按 updatedAt 缓存会把「少一条消息」的盘面留到这些消息真的落盘之后
     */
    async messagesStamp(id: string): Promise<string> {
      const meta = (await all()).get(id)
      if (!meta) return ''
      const st = await stat(msgFileOf(meta)).catch(() => null)
      return st ? `${st.mtimeMs}:${st.size}` : ''
    },
    async readMessages(id: string): Promise<TaskMessage[] | null> {
      const meta = (await all()).get(id)
      if (!meta) return null
      const raw = await readJson(msgFileOf(meta))
      const p = TaskMessage.array().safeParse(raw)
      return p.success ? p.data : null
    },
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
     * 已经在内存里的任务（正在跑的、读过的、启动时加载过摘要的）：同步拿，不读盘。
     * 只给必须同步判断的路径用（转交子任务前确认父对话在不在，见 ADR 0019）；拿到的是内存副本，不要改它
     */
    known(id: string): Task | null {
      return full.get(id) ?? metas?.get(id) ?? null
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
    /**
     * 只改任务本身的几个字段，不读也不写 `.messages.json`。
     *
     * 打开对话页（`/seen`）这类请求每次都要改一个小字段：走 `update` 要么把几 MB 的对话读一遍再校验
     * （实测 2MB / 611 条要 91–133ms），要么调用方传一份不完整的 messages 进来、把对话文件覆盖掉。
     * patch 里不允许带 messages：对话只能经 `update` / 执行器落盘那条路写。
     */
    async updateMeta(
      id: string,
      patch: Partial<Omit<TaskData, 'messages'>> & { updatedAt?: string },
      opts?: { keepUpdatedAt?: boolean },
    ) {
      const map = await all()
      const old = map.get(id)
      if (!old) return null
      const updatedAt = opts?.keepUpdatedAt ? (patch.updatedAt ?? old.updatedAt) : new Date().toISOString()
      const item = { ...old, ...patch, id, projectId: old.projectId, updatedAt } as Task
      map.set(id, head(item))
      // 内存里还留着这份对话（刚读过、正在执行）时一起改：不然下一次落盘或推送会把旧值带回去
      const hit = full.get(id)
      if (hit) Object.assign(hit, patch, { updatedAt })
      await queueWrite(item, writeFull)
      return item
    },
    async remove(id: string) {
      const map = await all()
      const meta = map.get(id)
      if (!meta) return false
      map.delete(id)
      drop(id)
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
      removeTaskLog(logFileOf(meta))
      return true
    },
  }
}
