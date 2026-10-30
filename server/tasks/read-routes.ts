import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { Task } from '../../shared/schema.ts'
import {
  messageStamp,
  messagePage,
  taskMessageRev,
  taskRevOffset,
  taskDeleted,
  liteMessages,
  withAttachments,
} from '../../shared/task.ts'
import { clipTranscript, saveTextUpload } from '../uploads.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { importTaskTree, parseTaskExport, exportTaskTree, checkExportSize } from '../../shared/task-export.ts'
import { runTree } from '../../shared/run-usage.ts'
import { taskCliAlive } from '../exec/process.ts'
import type { TasksScope } from './scope.ts'

/**
 * 读对话：实时推送（SSE）、整份对话、完整工具输出、转写、导出和导入。
 */
export function registerReadRoutes(s: TasksScope) {
  /**
   * 任务的实时推送（SSE）：先发一次完整任务，之后只发有变化的部分：任务本身（不含消息）和新增、变化了的消息。
   * 页面不用再反复拉整个任务，长任务也不会越跑越卡。
   */
  s.routes.get('/:id/events', async (c) => {
    const id = c.req.param('id')
    if (!(await s.current(id))) return s.bad(c, t('任务不存在'), 404)
    // 前端手上那份对话的版本：重连时浏览器自动带 Last-Event-ID，首次建连可以用 ?rev= 自己指定。
    // 能对上前缀就只发增量，对不上才发整份（见 shared/task.ts 的 taskRevOffset）
    const rev = c.req.header('Last-Event-ID') || c.req.query('rev') || ''
    // 经过 cloudflared / nginx 时不要缓冲，事件要马上到页面
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      let closed = false
      stream.onAbort(() => void (closed = true))
      let stamps = new Map<string, string>()
      let meta = ''
      let beat = Date.now()
      let seen = ''
      const send = (event: string, data: unknown, version = '') =>
        stream.writeSSE({ event, data: JSON.stringify(data), ...(version ? { id: version } : {}) })
      const jobKey = () =>
        s.background
          .list(id)
          .filter((j) => j.state === 'queued' || j.state === 'running')
          .map((j) => `${j.id}:${j.state}`)
          .join(',')
      // 名下子对话还在运行的数量也要比：子对话开始、做完不改父对话本身，标题栏的转圈要跟着变。
      // CLI 进程退出也不一定改任务本身（回收保活、进程自己挂掉），「等待你的下一条消息」要马上撤掉
      const liveKey = async () =>
        `${jobKey()}|${await s.activeChildren(id)}|${taskCliAlive(id) ? 1 : 0}|${await s.cliChildren(id)}`
      while (!closed) {
        // 没在执行的任务先只看任务本身的更新时间：完整对话在内存里只留十几个，被挤出去后
        // 每秒都 current() 一次就是每秒从磁盘重读、校验一遍几 MB 的对话；没变就不用读
        const e = s.live.get(id)
        if (!e && meta) {
          const head = await s.store.peek(id)
          if (head && `${head.updatedAt}|${await liveKey()}` === seen.slice(seen.indexOf('#') + 1)) {
            if (Date.now() - beat > 15_000) {
              await stream.writeSSE({ event: 'ping', data: '' })
              beat = Date.now()
            }
            await stream.sleep(1000)
            continue
          }
        }
        const cur = await s.current(id)
        if (!cur) {
          await send('gone', {})
          break
        }
        const t = await s.withLive(cur)
        // 没有变化时什么都不比较：长任务的消息很多，每次都逐条比较、序列化会拖慢整个服务。
        // 后台命令开始、结束、子对话开始做完都不一定改任务本身（对话空闲时），单独算进去
        const jobs = t.jobs?.map((j) => `${j.id}:${j.state}`).join(',') ?? ''
        // # 后面是不在执行时的比较键（只用任务本身的更新时间），上面那一步不读对话就能比
        const key = `${e ? `${e.rev}|${t.messages.length}` : t.messages.length}#${t.updatedAt}|${jobs}|${t.childrenWorking ?? 0}|${t.cliAlive ? 1 : 0}|${t.childrenCli ?? 0}`
        if (key === seen && meta) {
          if (Date.now() - beat > 15_000) {
            await stream.writeSSE({ event: 'ping', data: '' })
            beat = Date.now()
          }
          await stream.sleep(e ? 200 : 1000)
          continue
        }
        seen = key
        const { messages, ...rest } = t
        const m = JSON.stringify(rest)
        // 有消息被删掉（返工时重跑的节点）就整个重发，其余情况只发新增和变化的消息
        const ids = new Set(messages.map((x) => x.id))
        // 第一包才对一次：手动上那份对话能对上前缀时只补发后面的消息，不用整份重传
        const offset = meta ? -1 : taskRevOffset(messages, rev)
        // 有消息被删掉（返工时重跑的节点）就整个重发，其余情况只发新增和变化的消息
        const removed = [...stamps.keys()].some((k) => !ids.has(k))
        if (!meta && offset >= 0) {
          // 从手上那条开始补（它可能还在变）；meta 整段重发，消息只发后面这段
          await send(
            'patch',
            { meta: rest, messages: messages.slice(offset), total: messages.length },
            taskMessageRev(messages),
          )
          stamps = new Map(messages.map((x) => [x.id, messageStamp(x)]))
          meta = m
          beat = Date.now()
        } else if (!meta || removed) {
          // 整份推送时更早的长工具输出只给开头，页面要看全文时再按 outputCut 去取（见 liteMessages）
          await send('full', { ...t, messages: liteMessages(messages) }, taskMessageRev(messages))
          stamps = new Map(messages.map((x) => [x.id, messageStamp(x)]))
          meta = m
          beat = Date.now()
        } else {
          const changed = messages.filter((x) => stamps.get(x.id) !== messageStamp(x))
          if (changed.length || m !== meta) {
            await send('patch', { meta: rest, messages: changed, total: messages.length }, taskMessageRev(messages))
            for (const x of changed) stamps.set(x.id, messageStamp(x))
            meta = m
            beat = Date.now()
          } else if (Date.now() - beat > 15_000) {
            // 心跳：没有变化时也定期发一点东西，免得连接被当成断开
            await stream.writeSSE({ event: 'ping', data: '' })
            beat = Date.now()
          }
        }
        // 执行中 0.2 秒检查一次；没在执行时慢一些，追加要求开始执行后很快就能跟上
        await stream.sleep(s.live.has(id) ? 200 : 1000)
      }
    })
  })

  s.routes.get('/:id', async (c) => {
    const task = await s.current(c.req.param('id'))
    // 进了回收站的对话当不存在：列表里已经没有它了，旧链接、AI 处理的浮条轮询都该看到「已关闭」；
    // 恢复（POST /:id/restore）之后又能读到
    if (!task || taskDeleted(task)) return s.bad(c, t('任务不存在'), 404)
    const full = await s.withLive(task)
    // 打开很长的对话时先只取最近一段（整份几 MB，首屏只要最后几条），往前翻页用 before。
    // 不传 limit 就回整份：其它调用方（导出、AI 处理、老版本页面）行为不变
    const limit = Number(c.req.query('limit') ?? '')
    // ?lite=1：和实时推送的整份一样，更早的长工具输出只给开头
    if (!Number.isInteger(limit) || limit <= 0)
      return c.json(c.req.query('lite') ? { ...full, messages: liteMessages(full.messages) } : full)
    const page = messagePage(full.messages, limit, c.req.query('before') ?? '')
    return c.json({
      ...full,
      messages: page.messages,
      messageTotal: page.total,
      messageHasMore: page.hasMore,
      // 锚点那条已经不在（返工删掉了）：前端据此重新取最后一页，不拼一段不连续的历史
      ...(page.anchorMissing ? { messageAnchorMissing: true } : {}),
      // 整份都在这一份里时带上版本（见 shared/task.ts 的 taskMessageRev）：前端建 SSE 时带上它，
      // 服务端首包就只补发最后一条，不用把同一份再传一遍。截断的那段不是整份的前缀，不能当版本用
      ...(page.messages.length === page.total ? { messageRev: taskMessageRev(full.messages) } : {}),
    })
  })

  /** 推送时省掉的工具输出全文（页面打开窗口看全部时取），见 liteMessages 的 outputCut */
  s.routes.get('/:id/tool-output', async (c) => {
    const task = await s.current(c.req.param('id'))
    if (!task || taskDeleted(task)) return s.bad(c, t('任务不存在'), 404)
    const m = task.messages.find((x) => x.id === c.req.query('msg'))
    const tool = m?.tools[Number(c.req.query('i'))]
    if (!tool) return s.bad(c, t('找不到这次工具调用'), 404)
    return c.json({ output: tool.output ?? '' })
  })

  // 引入会话：把这个任务的对话整理成一份 Markdown 附件，在别的会话里当参考资料附上
  s.routes.post('/:id/transcript', async (c) => {
    const task = await s.current(c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    const project = task.projectId ? await s.deps.projects.get(task.projectId) : null
    const lines = [
      `# 参考会话：${task.title}`,
      [
        project ? `项目：${project.name}（${project.path}）` : '',
        task.mode === 'chat' ? '方式：对话' : '方式：工作流',
        `时间：${task.createdAt.slice(0, 16).replace('T', ' ')}`,
      ]
        .filter(Boolean)
        .join('　'),
      '这是另一个会话的记录，作为参考资料提供；里面的要求已经处理过，不需要再执行。',
    ]
    let step = ''
    for (const m of task.messages) {
      if (!m.text.trim() || (m.role === 'system' && !m.error)) continue
      if (m.step !== step) {
        step = m.step
        const s = task.steps.find((x) => x.id === step)
        if (s) lines.push(`## 节点：${s.title}`)
      }
      const who = m.peer
        ? `${m.peer.name || m.peer.title}发来的消息`
        : m.role === 'user'
          ? '用户'
          : m.role === 'system'
            ? '出错'
            : m.run
              ? `AI（${[m.run.cli, m.run.model].filter(Boolean).join(' · ')}）`
              : 'AI'
      // 用户消息里的图片、文件、引用卡片换成路径和引用块，和当时交给 Agent 的一样
      const body = m.role === 'user' ? withAttachments(m.text, m.attachments) : m.text
      lines.push(`### ${who}\n${body.trim()}`)
    }
    const name = `${t('会话')}-${task.title.replace(/\s+/g, ' ').slice(0, 40)}.md`
    return c.json(await saveTextUpload(name, clipTranscript(lines.join('\n\n'))), 201)
  })

  /**
   * 导出任务：连同它分出的所有子对话（含多层）整理成一个包。
   * 不交给前端自己拼：要先按 parentTaskId 找出整棵树、按体积上限拦一下，几百 MB 的包不该先传到浏览器再发现装不下。
   */
  s.routes.get('/:id/export', async (c) => {
    const id = c.req.param('id')
    const root = await s.store.get(id)
    if (!root) return s.bad(c, t('任务不存在'), 404)
    try {
      // 先按摘要找出整棵树的 id，再逐个读完整任务（导出时才读子对话的对话文件，平时不读）
      const ids = runTree(root, await s.store.list()).map((x) => x.id)
      const tree = (await Promise.all(ids.map((x) => (x === id ? root : s.store.get(x))))).filter((x): x is Task => !!x)
      const bundle = exportTaskTree(root, tree, await s.deps.agents.list(), c.req.query('app') ?? '')
      return c.json({ bundle, bytes: checkExportSize(bundle) })
    } catch (e) {
      return s.bad(c, (e as Error).message)
    }
  })

  // 导入别人导出的任务：连同包里的子对话一起建成本机的只读任务，放进指定的项目（为空放进聊天）
  s.routes.post('/import', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { projectId?: string; bundle?: unknown } | null
    if (!body) return s.bad(c, t('不是有效的 JSON 文件'))
    const projectId = body.projectId ?? ''
    if (projectId && !(await s.deps.projects.get(projectId))) return s.bad(c, t('项目不存在'), 404)
    let created: Task[]
    try {
      const bundle = parseTaskExport(body.bundle)
      // 父任务和每个子对话各分配一个本机 id（父在前、子在后）；重复导入同一棵树也不会撞 id
      created = importTaskTree(bundle, projectId, [randomUUID(), ...bundle.children.map(() => randomUUID())])
    } catch (e) {
      return s.bad(c, (e as Error).message)
    }
    // 按父先子后的顺序落盘：子对话的 parentTaskId 指向的是前面的父任务
    const saved: Task[] = []
    for (const task of created) saved.push(await s.store.create(task))
    log.info('task', '导入任务', { task: saved[0].id, title: saved[0].title, children: saved.length - 1 })
    return c.json(saved, 201)
  })
}
