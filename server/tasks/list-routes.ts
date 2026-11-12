import { createHash } from 'node:crypto'
import { Task, type TaskMessage } from '../../shared/schema.ts'
import { taskDeleted, taskSummary } from '../../shared/task.ts'
import { bugBriefs } from '../../shared/bug/overview.ts'
import { agentFlowBriefs } from '../../shared/agent-flow-briefs.ts'
import { messageChars, searchTasks } from '../../shared/task-search.ts'
import { trashRows } from '../../shared/trash/rows.ts'
import { childCountsScan } from '../../shared/children/row.ts'
import { taskCliAlive } from '../exec/process.ts'
import { log } from '../log.ts'
import { SEARCH_CACHE_TASKS, SEARCH_CACHE_CHARS } from './helpers.ts'
import type { TasksScope } from './scope.ts'
import { createIdleRelease } from './idle-release.ts'

/**
 * 对话列表类接口：列表（带 ETag）、磁盘占用、保活列表与释放、回收站列表、对话内容搜索（带消息缓存）。
 */
export function registerListRoutes(s: TasksScope) {
  // 保活列表、手动释放、内存紧张时自动释放（见 idle-release.ts）
  const idle = createIdleRelease(s)
  const { keepAliveList } = idle
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

  /**
   * 总览页的 Bug 视图：所有用户报的 Bug（多半是子对话，列表接口不返回子对话，也不该带整份报告），
   * 只给视图和流程统计要的精简字段（shared/bug/overview.ts）。状态按内存里正在跑的那份算，和列表同一个口径
   */
  s.routes.get('/bugs', async (c) => {
    const all = (await s.store.list()).map((t) => s.idle(s.live.get(t.id)?.task ?? t))
    return c.json(bugBriefs(await Promise.all(all.map(async (t) => ({ ...t, live: await s.liveOf(t) })))))
  })

  /**
   * 总览页的「流程」视图（扩展 4）：所有 Agent 模式对话（含子对话）被推了几次、评审退回、合回失败、等你多久，
   * 只给精简行（shared/agent-flow-briefs.ts），汇总由页面按搜索词筛过再算。状态按内存里正在跑的那份算
   */
  s.routes.get('/flow', async (c) => {
    const all = (await s.store.list()).map((t) => s.live.get(t.id)?.task ?? t)
    return c.json(agentFlowBriefs(all))
  })

  s.routes.get('/keepalive', async (c) => c.json(await keepAliveList()))
  /** 释放保活的会话：给了 ids 就只放这几个，否则放掉所有没开着页面的；下次发消息时冷启动续接原会话 */
  s.routes.post('/keepalive/release', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
    const only = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null
    const released = (await idle.releaseIdle(only)).map((x) => x.id)
    if (released.length) log.info('task', '手动释放保活的会话', { tasks: released })
    return c.json({ released })
  })

  s.routes.get('/', async (c) => {
    const pid = c.req.query('projectId')
    // 列表只给摘要：侧栏和项目首页不需要消息内容，任务多了也不会越来越慢。
    // 进了回收站的对话不在任何列表里出现（回收站自己有一个入口，见 GET /trash）
    const all = (await s.store.list()).filter((t) => !taskDeleted(t)).map((t) => s.idle(s.live.get(t.id)?.task ?? t))
    // 运行时状态（还在跑的子对话数、后台命令、CLI 存活、后代在等你的数）只在 liveOf 一处算（server/tasks/live.ts）：
    // 子对话的计数在这里现扫一遍再传进去，不读 1 秒缓存：子对话刚开始一轮、很快又做完时，
    // 缓存里可能还是开始前那份，列表就看不到父对话在跑（e2e 04-subagents 在 CI 上撞到过）
    const kids = childCountsScan(all, { active: s.childActive, cliAlive: (k) => taskCliAlive(k.id) })
    let list = await Promise.all(all.map(async (t) => taskSummary({ ...t, live: await s.liveOf(t, kids) })))
    // 子对话不进入项目列表：按 parentId 查询时才返回它们。
    // 父对话名下的工作流运行（不是对话，见 shared/flow-run.ts）也不进：按 owner 查询时返回某个父对话名下的运行（父对话的工作流栏用）；
    // 直接经接口建的独立运行没有父对话，照常列
    const parent = c.req.query('parentId')
    const owner = c.req.query('owner')
    list = owner
      ? list.filter((t) => t.flowRun?.owner === owner)
      : parent
        ? list.filter((t) => t.parentTaskId === parent)
        : list.filter((t) => !t.parentTaskId && !t.flowRun?.owner)
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
    // 字段和过滤在 shared/trash/rows.ts（演示后端调同一份）
    return c.json(trashRows(await s.store.list()))
  })

  /**
   * 对话内容搜索：搜消息正文，只回命中片段 + 对话 id + 命中条数，不回整份消息。
   * 按最近活动倒序扫，三个预算任一用完就停：扫多少个对话、回多少条、读进来的字数
   * （口径在 shared/task-search.ts）。进了回收站的对话不参与：删了就不该还能被搜出来
   */
  s.routes.get('/search', async (c) => {
    // 预算和扫描顺序在 shared/task-search.ts 的 searchTasks（演示后端调同一份）；这里只管从文件读消息（带缓存）
    const report = await searchTasks(
      await s.store.list(),
      c.req.query('q') ?? '',
      (tk) => cachedMessages(tk),
      Number(c.req.query('limit')),
    )
    return c.json(report)
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
  return { startMemoryGuard: idle.startMemoryGuard }
}
