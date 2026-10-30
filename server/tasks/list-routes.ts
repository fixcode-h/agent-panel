import { createHash } from 'node:crypto'
import { Task, type TaskMessage } from '../../shared/schema.ts'
import { taskDeleted, trashLeftDays, taskSummary } from '../../shared/task.ts'
import { isViewing } from '../presence.ts'
import { messageChars } from '../task-store.ts'
import {
  SEARCH_CHAR_BUDGET,
  SEARCH_HIT_LIMIT,
  SEARCH_HITS_PER_TASK,
  SEARCH_TASK_BUDGET,
  messageHit,
  type SearchHit,
} from '../../shared/task-search.ts'
import { log } from '../log.ts'
import { taskCliAlive } from '../exec/process.ts'
import { trackedClis } from '../exec/orphans.ts'
import { processSnapshot, subtree, sumRss } from '../exec/proc-stats.ts'
import { SEARCH_CACHE_TASKS, SEARCH_CACHE_CHARS } from './helpers.ts'
import type { TasksScope } from './scope.ts'

/**
 * 对话列表类接口：列表（带 ETag）、磁盘占用、保活列表与释放、回收站列表、对话内容搜索（带消息缓存）。
 */
export function registerListRoutes(s: TasksScope) {
  /**
   * 保活中的会话：回复完停在等下一句、CLI 进程还留着的对话，连同进程（含子进程）占的内存。
   * 设置「数据」里列出来，用户可以一键释放；正开着的页面单独标出，释放全部时不动它们
   */
  async function keepAliveList() {
    const map = await processSnapshot()
    const tracked = trackedClis()
    return [...s.live.values()]
      .filter((e) => e.task.awaitingUser && !e.task.working)
      .map((e) => {
        const pids = new Set<number>()
        for (const x of tracked.filter((x) => x.owner?.taskId === e.task.id))
          for (const pid of map ? subtree(x.pid, map) : [x.pid]) pids.add(pid)
        return {
          id: e.task.id,
          title: e.task.title,
          projectId: e.task.projectId,
          parentTaskId: e.task.parentTaskId,
          cli: e.task.sessionCli || e.task.cli,
          viewing: isViewing(e.task.id),
          since: e.task.turnDoneAt || e.task.updatedAt,
          rss: map && pids.size ? sumRss(pids, map) : null,
        }
      })
      .sort((a, b) => a.since.localeCompare(b.since))
  }
  /** 每个对话的磁盘占用（任务文件 + 对话文件），设置「数据」里按项目、父子对话列出来 */
  s.routes.get('/disk', async (c) => {
    const bytes = new Map((await s.store.diskSizes()).map((x) => [x.id, x.bytes]))
    // 回收站里的另在「回收站」那一节列，这里不重复算
    return c.json(
      (await s.store.list())
        .filter((x) => !taskDeleted(x))
        .map((x) => ({
          id: x.id,
          title: x.title,
          projectId: x.projectId,
          parentTaskId: x.parentTaskId,
          updatedAt: x.updatedAt,
          archived: !!x.archived,
          working: !!(s.live.get(x.id)?.task.working ?? x.working),
          bytes: bytes.get(x.id) ?? 0,
        })),
    )
  })

  s.routes.get('/keepalive', async (c) => c.json(await keepAliveList()))
  /** 释放保活的会话：给了 ids 就只放这几个，否则放掉所有没开着页面的；下次发消息时冷启动续接原会话 */
  s.routes.post('/keepalive/release', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
    const only = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null
    const released: string[] = []
    for (const x of await keepAliveList()) {
      if (only ? !only.has(x.id) : x.viewing) continue
      // 名下有子对话在跑的父对话不动：结束它会把子对话一起停掉
      if ([...s.live.values()].some((e) => e.task.parentTaskId === x.id && e.task.working)) continue
      s.stopTask(x.id, 'idle')
      released.push(x.id)
    }
    if (released.length) log.info('task', '手动释放保活的会话', { tasks: released })
    return c.json({ released })
  })

  s.routes.get('/', async (c) => {
    const pid = c.req.query('projectId')
    // 列表只给摘要：侧栏和项目首页不需要消息内容，任务多了也不会越来越慢。
    // 进了回收站的对话不在任何列表里出现（回收站自己有一个入口，见 GET /trash）
    const all = (await s.store.list()).filter((t) => !taskDeleted(t)).map((t) => s.idle(s.live.get(t.id)?.task ?? t))
    // 子对话还在运行时父对话也算在运行：一次算好所有父对话名下的数量，前端不用再为每个任务发请求。
    // 口径和标题栏、能不能回收是同一个（childActive）：等结果、等回答的子对话也算，不只看 working
    const kids = new Map<string, number>()
    // 名下 CLI 还活着的子对话数：侧栏不点开父对话也能看出里面还开着 CLI
    const kidsCli = new Map<string, number>()
    for (const k of all) {
      if (!k.parentTaskId) continue
      if (taskCliAlive(k.id)) kidsCli.set(k.parentTaskId, (kidsCli.get(k.parentTaskId) ?? 0) + 1)
      if (!s.childActive(k)) continue
      kids.set(k.parentTaskId, (kids.get(k.parentTaskId) ?? 0) + 1)
    }
    let list = all.map((t) => {
      const n = kids.get(t.id) ?? 0
      // 带上还在跑的后台命令：交出去的命令没跑完，列表里这个对话就还在「等结果」，不能显示成做完了
      return taskSummary(
        s.withJobs(t.parentTaskId ? t : { ...t, childrenWorking: n, childrenCli: kidsCli.get(t.id) ?? 0 }),
      )
    })
    // 子对话不进入项目列表：按 parentId 查询时才返回它们
    const parent = c.req.query('parentId')
    list = parent ? list.filter((t) => t.parentTaskId === parent) : list.filter((t) => !t.parentTaskId)
    const body = JSON.stringify(pid ? list.filter((t) => t.projectId === pid) : list)
    // 列表每 2.5 秒被拉一次（有任务在跑时）：内容没变就回 304，前端不用重新序列化、侧栏不用重渲染。
    // 指纹直接算最终响应体：摘要字段多，挑几个字段拼容易漏（改了名、换了摘要却不刷新列表）
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`
    c.header('ETag', etag)
    const asked = c.req.header('If-None-Match') ?? ''
    if (asked === etag || asked === `W/${etag}`) return c.body(null, 304)
    return c.body(body, 200, { 'Content-Type': 'application/json' })
  })

  /**
   * 回收站：进回收站还没到期的对话（见 Task.deletedAt），设置页的「回收站」读它。
   * 只列顶层对话：子对话跟着父对话一起进、一起恢复，单独列出来只会让用户分不清
   * （父对话没进回收站、只是单独删了的子对话照常列）。
   * 返回的字段是界面要显示的那几项：标题、删除时间、还剩几天，不在前端再算一遍保留期
   */
  s.routes.get('/trash', async (c) => {
    const now = Date.now()
    const deleted = (await s.store.list()).filter((t) => taskDeleted(t))
    const parents = new Set(deleted.filter((t) => !t.parentTaskId).map((t) => t.id))
    const rows = deleted
      .filter((t) => !t.parentTaskId || !parents.has(t.parentTaskId))
      .map((t) => ({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        parentTaskId: t.parentTaskId ?? '',
        deletedAt: t.deletedAt,
        leftDays: trashLeftDays(t.deletedAt!, now),
        children: deleted.filter((k) => k.parentTaskId === t.id).length,
        worktree: t.worktree?.state ?? '',
      }))
      // 最近删掉的排在前面：要恢复的往往是刚删错的那条
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
    return c.json(rows)
  })

  /**
   * 对话内容搜索：搜消息正文，只回命中片段 + 对话 id + 命中条数，不回整份消息。
   * 按最近活动倒序扫，三个预算任一用完就停：扫多少个对话、回多少条、读进来的字数
   * （口径在 shared/task-search.ts）。进了回收站的对话不参与：删了就不该还能被搜出来
   */
  s.routes.get('/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (!q) return c.json({ hits: [], scanned: 0, more: false })
    const asked = Number(c.req.query('limit'))
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(SEARCH_HIT_LIMIT, asked) : SEARCH_HIT_LIMIT
    // 最近活动过的先扫：用户要找的多半是刚聊过的那几条
    const all = (await s.store.list())
      .filter((t) => !taskDeleted(t))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    const tasks = all.slice(0, SEARCH_TASK_BUDGET)
    const hits: SearchHit[] = []
    let more = all.length > tasks.length
    let searchChars = 0
    for (const tk of tasks) {
      // 结果格子满了就不再读文件：边输边搜，首屏要快
      if (hits.length >= limit) {
        more = true
        break
      }
      const messages = await cachedMessages(tk)
      if (!messages.length) continue
      const chars = messageChars(messages)
      if (searchChars + chars > SEARCH_CHAR_BUDGET) {
        more = true
        break
      }
      searchChars += chars
      let taken = 0
      for (const m of messages) {
        if (taken >= SEARCH_HITS_PER_TASK) {
          more = true
          break
        }
        const hit = messageHit(m.text, q)
        if (!hit) continue
        if (hits.length >= limit) {
          more = true
          break
        }
        hits.push({
          taskId: tk.id,
          title: tk.title,
          messageId: m.id,
          role: m.role,
          at: m.at,
          count: hit.count,
          snippet: hit.snippet,
          index: hit.index,
          length: q.length,
        })
        taken++
      }
    }
    return c.json({ hits, scanned: tasks.length, more })
  })

  /**
   * 搜索用的对话缓存：任务记录没更新过（updatedAt 一样）就直接用上次读到的消息。
   * 边输边搜时每按一个键都要扫最近几十个对话，没有这层缓存每次都得把几十个几 MB 的
   * `.messages.json` 重新读一遍、再校验一遍。只留最近用到的几个，超出按总字数丢掉最久没用的
   */
  const searchCache = new Map<string, { key: string; messages: TaskMessage[]; chars: number }>()
  let searchCacheChars = 0
  function cacheMessages(id: string, key: string, messages: TaskMessage[]) {
    const old = searchCache.get(id)
    if (old) searchCacheChars -= old.chars
    searchCache.delete(id)
    const chars = messageChars(messages)
    searchCache.set(id, { key, messages, chars })
    searchCacheChars += chars
    while (searchCache.size > 1 && (searchCacheChars > SEARCH_CACHE_CHARS || searchCache.size > SEARCH_CACHE_TASKS)) {
      const oldest = searchCache.keys().next().value!
      searchCacheChars -= searchCache.get(oldest)?.chars ?? 0
      searchCache.delete(oldest)
    }
  }
  async function cachedMessages(tk: Task): Promise<TaskMessage[]> {
    // key 用消息文件自己的指纹，不用任务的 updatedAt（消息文件最多晚 400ms 落盘，见 task-store 的 messagesStamp）
    const key = await s.store.messagesStamp(tk.id)
    const hit = searchCache.get(tk.id)
    if (hit && hit.key === key) {
      // 挪到末尾：最近用过的留在缓存里
      searchCache.delete(tk.id)
      searchCache.set(tk.id, hit)
      return hit.messages
    }
    const messages = (await s.store.readMessages(tk.id)) ?? []
    cacheMessages(tk.id, key, messages)
    return messages
  }
}
