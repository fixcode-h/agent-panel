import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  FollowUpInput,
  PresenceInput,
  TaskPatch,
  NewTaskInput,
  Task,
  type Agent,
  type Attachment,
  type Project,
  type ProjectCategory,
  type Workflow,
  RequestAnswer,
} from '../shared/schema.ts'
import { blockedStep, taskFlow, taskWorkflows } from '../shared/flow.ts'
import { DEFAULT_WORKFLOW_ID, taskSnapshot } from '../shared/builtin/default.ts'
import {
  beginRun,
  closeFlow,
  dropEndNotes,
  endRun,
  messageStamp,
  pauseStep,
  trackWait,
  waitDuration,
  newTask,
  taskSummary,
  withAttachments,
  withTaskModel,
} from '../shared/task.ts'
import { agentRun, defaultCli } from '../shared/settings.ts'
import { getCli } from '../shared/clis.ts'
import { expandSlash } from './slash.ts'
import { chatMissingParams } from '../shared/agent-role.ts'
import { getSettings } from './settings.ts'
import { detectClis } from './detect.ts'
import { gitChanges, gitFileDiff, gitHead, gitNumstat, gitRevertFile } from './exec/git.ts'
import {
  answerRequest,
  autoAnswerQuestions,
  cancelWait,
  deliverWait,
  runRealTurn,
  steerTask,
  type RealContext,
} from './exec/runner.ts'
import { forgetPresence, setPresenceIdleHandler, setViewer } from './presence.ts'
import { CHATS_DIR, HANDOFF_DIR } from './store.ts'
import { createTaskStore } from './task-store.ts'
import { createWorktree, mergeWorktree, removeWorktree } from './exec/worktree.ts'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { cleanupUploads, clipTranscript, removeUploads, saveTextUpload, uploadDirOf } from './uploads.ts'
import path from 'node:path'
import { log } from './log.ts'
import { t } from '../shared/i18n.ts'
import { importTask, parseTaskExport } from '../shared/task-export.ts'

/** 任务还在用自己的独立分支（没合并也没丢弃） */
const isolated = (tk: Pick<Task, 'worktree'>) => tk.worktree?.state === 'active'

/** 打开对话页时后台启动 CLI 用的提示：只让它停在等下一句上，不做任何事 */
const PREWARM_PROMPT =
  '（面板预热：用户还没有发新消息。不要回复任何内容，也不要调用其他工具，直接调用 wait_user_message 等用户的下一条消息。）'

type Lister<T> = { list(): Promise<T[]>; get(id: string): Promise<T | null> }

/** 任务接口与执行。执行中的任务放在内存里，按节点落盘，避免流式输出时频繁写文件 */
export function tasksApi(deps: {
  agents: Lister<Agent>
  workflows: Lister<Workflow>
  projects: Lister<Project>
  projectCategories: Lister<ProjectCategory>
}) {
  const store = createTaskStore()
  /** rev：执行中每次有变化加一，实时推送靠它判断要不要比较内容 */
  type Live = {
    task: Task
    stop: boolean
    abort: AbortController
    done?: Promise<void>
    rev: number
    /** 换 CLI/模型/强度时由 PATCH 负责重启，收尾不要重复预热 */
    restart?: boolean
  }
  const live = new Map<string, Live>()
  // 对话页切走一分钟后就别让 CLI 一直等下一句了，结束这一轮
  setPresenceIdleHandler(cancelWait)
  /** 服务正在退出：不再接着处理排队的要求 */
  let shuttingDown = false
  /** 同步占住任务的执行位，避免两次请求在 await 的间隙里各自启动一遍 */
  const reserve = (task: Task): Live => {
    const entry: Live = { task: structuredClone(task), stop: false, abort: new AbortController(), rev: 0 }
    live.set(task.id, entry)
    return entry
  }

  // 服务重启时，之前没跑完的任务标记为已停止；正在跑的节点记为被打断，继续执行时续接它的会话
  void store.list().then(async (all) => {
    for (const meta of all.filter((x) => x.status === 'running')) {
      // 列表里只有用户消息，改之前取完整的
      const task = await store.get(meta.id)
      if (!task) continue
      await store.update(task.id, {
        ...task,
        status: 'stopped',
        requests: [],
        working: false,
        awaitingUser: false,
        prewarming: false,
        // 中断前最后一次落盘的时间当作这一轮的结束
        runMs:
          (task.runMs ?? 0) +
          (task.runStartedAt ? Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.runStartedAt)) : 0),
        runStartedAt: '',
        // 等待和节点耗时也算到最后一次落盘为止
        waitMs: waitDuration(task, Date.parse(task.updatedAt)),
        waitStartedAt: '',
        turns: (task.turns ?? []).map((x) =>
          x.status === 'running' ? { ...x, status: 'stopped' as const, endedAt: task.updatedAt } : x,
        ),
        steps: task.steps.map((s) => {
          const w = { ...s, waitMs: waitDuration(s, Date.parse(task.updatedAt)), waitStartedAt: '' }
          if (s.status !== 'running') return w
          pauseStep(w, Date.parse(task.updatedAt))
          return { ...w, status: 'pending' as const, interrupted: true }
        }),
        messages: [
          ...task.messages,
          {
            id: randomUUID(),
            role: 'system',
            agentId: '',
            step: '',
            text: t(
              '面板关闭或重启时任务还在执行，已中断。点「继续执行」从中断的节点接着做（会续接那个节点的 CLI 会话）。',
            ),
            tools: [],
            transient: true,
            at: new Date().toISOString(),
          },
        ],
      })
    }
  })

  /** Chat 模式的聊天在数据目录里各有一个空的工作目录，不碰任何项目 */
  const chatProject = (dir: string): Project => ({
    id: '',
    name: t('聊天'),
    description: '',
    path: dir,
    categoryId: '',
    workflowId: '',
    createdAt: '',
    updatedAt: '',
  })
  const chatWorkspace = async (id: string) => {
    const dir = path.join(CHATS_DIR, id)
    await mkdir(dir, { recursive: true })
    return chatProject(dir)
  }

  /** 任务引用的附件目录 */
  const uploadDirs = (t: Task) =>
    new Set(t.messages.flatMap((m) => (m.attachments ?? []).map((a) => uploadDirOf(a.path)).filter(Boolean)))
  /** 删除任务后，删掉只有这些任务在用的附件 */
  async function dropUploads(removed: Task[]) {
    const keep = new Set((await store.list()).flatMap((t) => [...uploadDirs(t)]))
    await removeUploads(removed.flatMap((t) => [...uploadDirs(t)]).filter((d) => !keep.has(d)))
  }

  const current = async (id: string) => live.get(id)?.task ?? (await store.get(id))
  const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)
  /** 导入的任务只读：只能看、改名、归档、删除 */
  const READONLY = t('这是导入的任务，只能查看，不能继续执行')

  async function projectWorkflow(p: Project) {
    const cat = p.categoryId ? await deps.projectCategories.get(p.categoryId) : null
    const id = p.workflowId || cat?.workflowId
    // 项目没指定工作流时用自带的「默认」工作流
    return (await deps.workflows.get(id || DEFAULT_WORKFLOW_ID)) ?? undefined
  }

  async function start(
    entry: Live,
    prompt: string,
    first: boolean,
    agents: Agent[],
    op?: RealContext['op'],
    resume = false,
    prewarm = false,
  ) {
    const task = entry.task
    const before = task.status
    const beforeUpdatedAt = task.updatedAt
    const beforeTurnDoneAt = task.turnDoneAt ?? ''
    // 先标成执行中，接口返回时页面就能开始轮询
    entry.task.status = 'running'
    // working 只表示 CLI 真的在处理这一轮；预热和等下一句时页面按空闲显示
    entry.task.working = !prewarm
    entry.task.awaitingUser = false
    entry.task.prewarming = prewarm
    // 对话新的一轮从 0 开始显示速度，接口返回时页面不会还停在上一轮的数字上
    const active = entry.task.mode === 'chat' ? entry.task.usage.agents[entry.task.agentId] : undefined
    if (active) {
      active.tps = 0
      active.lastTps = 0
    }
    beginRun(entry.task)
    const [settings, found] = await Promise.all([
      getSettings(),
      task.projectId ? deps.projects.get(task.projectId) : chatWorkspace(task.id),
    ]).catch((e) => {
      live.delete(task.id)
      throw e
    })
    // 独立分支执行时，Agent 在任务自己的工作目录里改，不碰项目目录
    const project = found && isolated(task) ? { ...found, path: task.worktree!.path } : found
    // 这一轮启动时的选择，用来判断执行中用户有没有换 CLI/模型/强度
    const startAgent = agents.find((a) => a.id === task.agentId)
    const startedRun = startAgent ? agentRun(withTaskModel(startAgent, task), settings) : undefined
    let last = 0
    // 预热退出要恢复列表时间：最后一次写不能把它改成现在
    const flush = (keepUpdatedAt = false) =>
      store
        .update(task.id, entry.task, { keepUpdatedAt })
        .catch((e) => console.error(`保存任务失败：${(e as Error).message}`))
    const changed = (f?: boolean) => {
      entry.task.updatedAt = new Date().toISOString()
      trackWait(entry.task)
      entry.rev++
      // 流式输出时最多每秒落盘一次，关键节点立即落盘
      if (f || Date.now() - last > 1000) {
        last = Date.now()
        void flush()
      }
    }
    log.info('task', first ? '开始执行任务' : '继续执行任务', {
      task: task.id,
      title: task.title,
      project: found?.name,
      workflow: task.workflowId,
    })
    const run = (async () => {
      // 项目被删掉后任务还在，这时没有目录可以执行
      if (!project) throw new Error(t('任务所属的项目已经不存在'))
      if (first) entry.task.baseRef = await gitHead(project.path).catch(() => '')
      const snapshot = await gitNumstat(project.path, entry.task.baseRef).catch(() => null)
      if (first) entry.task.baseline = snapshot ?? {}
      await runRealTurn({
        task: entry.task,
        agents,
        // 用任务创建时存下的工作流：之后改了、删了工作流都不影响这个任务
        ...taskWorkflows(entry.task, await deps.workflows.list()),
        project,
        settings,
        clis: await detectClis(),
        prompt,
        signal: entry.abort.signal,
        changed,
        newId: randomUUID,
        isGit: snapshot !== null,
        op,
        resume,
        prewarm,
        prewarmFrom: before,
        prewarmTurnDoneAt: beforeTurnDoneAt,
      })
    })()
    entry.done = run
      .catch((e) => {
        log.error('task', '任务执行出错', { task: task.id, error: e })
        // 预热失败不打扰对话：恢复原来的状态，等用户发消息时再按正常流程报错
        if (prewarm) {
          entry.task.status = before
          return
        }
        entry.task.status = 'failed'
        entry.task.messages.push({
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: t('执行出错：{error}', { error: (e as Error).message }),
          tools: [],
          error: true,
          at: new Date().toISOString(),
        })
      })
      .finally(async () => {
        log.info('task', `任务结束：${entry.task.status}`, { task: task.id })
        entry.task.working = false
        entry.task.awaitingUser = false
        entry.task.prewarming = false
        // 预热收尾要把原来的列表时间写回去，不能让它变成现在
        let keepTime = false
        // 预热只是把 CLI 启动好，没有处理新消息就退出时不要算完成，也不要把列表时间改成现在
        if (prewarm && (entry.task.turnDoneAt ?? '') === beforeTurnDoneAt) {
          // 引擎这时不会标完成，任务还停在 running；状态和时间都回到打开前
          if (entry.task.status === 'done' || entry.task.status === 'running') entry.task.status = before
          entry.task.updatedAt = beforeUpdatedAt
          // 引擎收尾没有走 changed，这里补一次推送
          entry.rev++
          keepTime = true
        }
        // 工作流跑完一整轮才算完成；对话在 CLI 回复完时已经记了 turnDoneAt
        if (!prewarm && entry.task.mode !== 'chat' && entry.task.status === 'done')
          entry.task.turnDoneAt = new Date().toISOString()
        // 执行中用户换了 CLI/模型/强度：旧进程的命令和上下文不能留给新的选择
        const nowRun =
          !prewarm && entry.task.mode === 'chat' && startAgent
            ? agentRun(withTaskModel(startAgent, entry.task), settings)
            : undefined
        const switchedRun =
          !!startedRun &&
          !!nowRun &&
          (startedRun.cli !== nowRun.cli || startedRun.model !== nowRun.model || startedRun.effort !== nowRun.effort)
        if (switchedRun) {
          entry.task.command = []
          delete entry.task.usage.agents[entry.task.agentId]
        }
        endRun(entry.task)
        await flush(keepTime)
        live.delete(task.id)
        // 这一轮顺利完成：接着处理排队的要求；失败或暂停时留着，等用户决定
        if (entry.task.status === 'done' && entry.task.queue.length && !shuttingDown)
          await followUp(task.id).catch((e) => console.error(`处理排队的要求失败：${(e as Error).message}`))
        // 没有排队时按新的选择直接预热，下一条消息不会再交给旧 CLI；
        // PATCH 自己负责的重启不要在这里重复做
        if (switchedRun && !entry.restart && entry.task.status === 'done' && !entry.task.queue.length && !shuttingDown)
          void prewarmChat(entry.task, true).catch((e) => console.error(`按新的选择预热失败：${(e as Error).message}`))
      })
    return entry.task
  }

  /**
   * 工作流里输入的「/命令」：节点和追加要求都用默认 CLI，按它把命令、Skill 展开成普通的要求。
   * 没有展开（不是命令、找不到）时返回空
   */
  async function expandForWorkflow(tk: Pick<Task, 'mode' | 'worktree' | 'projectId' | 'id'>, text: string) {
    if (tk.mode !== 'workflow' || !text.trim().startsWith('/')) return ''
    const out = await expandSlash(text, defaultCli(await getSettings()), await taskDir(tk), false).catch(() => text)
    return out === text ? '' : out
  }

  /** 发一条追加要求：没给内容时取排队的第一条 */
  async function followUp(id: string, msg?: { text: string; attachments: Attachment[] }) {
    const task = await store.get(id)
    if (!task) throw new Error('任务不存在')
    const entry = reserve(task)
    const next = entry.task
    let m = msg
    if (!m) {
      const q = next.queue.shift()
      if (!q) {
        live.delete(id)
        return next
      }
      m = q
    }
    const expanded = await expandForWorkflow(next, m.text)
    dropEndNotes(next)
    next.messages.push({
      id: randomUUID(),
      role: 'user',
      agentId: '',
      step: '',
      text: m.text,
      ...(expanded ? { prompt: expanded } : {}),
      tools: [],
      ...(m.attachments.length ? { attachments: m.attachments } : {}),
      at: new Date().toISOString(),
    })
    try {
      return await start(entry, withAttachments(expanded || m.text, m.attachments), false, await deps.agents.list())
    } catch (e) {
      live.delete(id)
      throw e
    }
  }

  const stopTask = (id: string) => {
    const e = live.get(id)
    if (!e) return
    e.stop = true
    e.abort.abort()
  }

  const routes = new Hono()

  routes.get('/', async (c) => {
    const pid = c.req.query('projectId')
    // 列表只给摘要：侧栏和项目首页不需要消息内容，任务多了也不会越来越慢
    const all = (await store.list()).map((t) => taskSummary(live.get(t.id)?.task ?? t))
    return c.json(pid ? all.filter((t) => t.projectId === pid) : all)
  })

  /**
   * 任务的实时推送（SSE）：先发一次完整任务，之后只发有变化的部分：任务本身（不含消息）和新增、变化了的消息。
   * 页面不用再反复拉整个任务，长任务也不会越跑越卡。
   */
  routes.get('/:id/events', async (c) => {
    const id = c.req.param('id')
    if (!(await current(id))) return bad(c, t('任务不存在'), 404)
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
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) })
      while (!closed) {
        const t = await current(id)
        if (!t) {
          await send('gone', {})
          break
        }
        // 没有变化时什么都不比较：长任务的消息很多，每次都逐条比较、序列化会拖慢整个服务
        const e = live.get(id)
        const key = e ? `${e.rev}|${t.updatedAt}` : `${t.updatedAt}|${t.messages.length}`
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
        if (!meta || [...stamps.keys()].some((k) => !ids.has(k))) {
          await send('full', t)
          stamps = new Map(messages.map((x) => [x.id, messageStamp(x)]))
          meta = m
          beat = Date.now()
        } else {
          const changed = messages.filter((x) => stamps.get(x.id) !== messageStamp(x))
          if (changed.length || m !== meta) {
            await send('patch', { meta: rest, messages: changed, total: messages.length })
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
        await stream.sleep(live.has(id) ? 200 : 1000)
      }
    })
  })

  routes.get('/:id', async (c) => {
    const task = await current(c.req.param('id'))
    return task ? c.json(task) : bad(c, t('任务不存在'), 404)
  })

  // 引入会话：把这个任务的对话整理成一份 Markdown 附件，在别的会话里当参考资料附上
  routes.post('/:id/transcript', async (c) => {
    const task = await current(c.req.param('id'))
    if (!task) return bad(c, t('任务不存在'), 404)
    const project = task.projectId ? await deps.projects.get(task.projectId) : null
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
      const who =
        m.role === 'user'
          ? '用户'
          : m.role === 'system'
            ? '出错'
            : m.run
              ? `AI（${[m.run.cli, m.run.model].filter(Boolean).join(' · ')}）`
              : 'AI'
      const files = m.attachments?.length ? `\n（附件：${m.attachments.map((a) => a.name).join('、')}）` : ''
      lines.push(`### ${who}\n${m.text.trim()}${files}`)
    }
    const name = `${t('会话')}-${task.title.replace(/\s+/g, ' ').slice(0, 40)}.md`
    return c.json(await saveTextUpload(name, clipTranscript(lines.join('\n\n'))), 201)
  })

  // 导入别人导出的任务：建一个只读的任务，放进指定的项目（为空放进聊天）
  routes.post('/import', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { projectId?: string; bundle?: unknown } | null
    if (!body) return bad(c, t('不是有效的 JSON 文件'))
    const projectId = body.projectId ?? ''
    if (projectId && !(await deps.projects.get(projectId))) return bad(c, t('项目不存在'), 404)
    let task: Task
    try {
      task = importTask(parseTaskExport(body.bundle), projectId, randomUUID())
    } catch (e) {
      return bad(c, (e as Error).message)
    }
    log.info('task', '导入任务', { task: task.id, title: task.title })
    return c.json(await store.create(task), 201)
  })

  routes.post('/', async (c) => {
    const p = NewTaskInput.safeParse(await c.req.json())
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const input = p.data
    // 没有项目的是 Chat 模式的聊天，只能直接对话
    if (!input.projectId && input.mode !== 'chat') return bad(c, t('缺少项目'))
    const project = input.projectId ? await deps.projects.get(input.projectId) : chatProject('')
    if (!project) return bad(c, t('项目不存在'), 404)
    const agents = await deps.agents.list()
    let workflow: Workflow | undefined
    if (input.mode === 'workflow') {
      workflow = input.workflowId
        ? ((await deps.workflows.get(input.workflowId)) ?? undefined)
        : await projectWorkflow(project)
      if (!workflow) return bad(c, t('项目还没有指定工作流，请选择一个工作流或改用直接对话'))
    } else if (!agents.some((a) => a.id === input.agentId)) return bad(c, t('请选择对话的 Agent'))
    const lack = chatMissingParams(input, agents)
    if (lack) return bad(c, lack)
    const snapshot = workflow ? taskSnapshot(workflow, await deps.workflows.list()) : []
    const draft = { ...newTask(input, workflow, new Date().toISOString(), randomUUID(), snapshot), id: randomUUID() }
    if (input.isolate && input.projectId) {
      try {
        draft.worktree = await createWorktree(project.path, draft.id, draft.title)
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    }
    // 工作流的第一条要求也能用「/命令」：展开后交给各节点，对话里仍显示输入的原文
    const expanded = await expandForWorkflow(draft, input.prompt)
    if (expanded && draft.messages[0]) draft.messages[0].prompt = expanded
    const task = await store.create(draft)
    return c.json(
      await start(reserve(task), withAttachments(expanded || input.prompt, input.attachments), true, agents),
      201,
    )
  })

  routes.post('/:id/messages', async (c) => {
    const id = c.req.param('id')
    const p = FollowUpInput.safeParse(await c.req.json())
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const { text, attachments, interrupt } = p.data
    if ((await current(id))?.imported) return bad(c, READONLY, 409)
    let prev = live.get(id)
    if (prev?.task.status === 'running') {
      // 直接接着当前任务处理：CLI 停在等下一句的工具上时交回同一个进程（不用结束再 --resume），
      // 否则按插话交给正在跑的 CLI；都收不下时排队
      if (!interrupt) {
        const expanded = await expandForWorkflow(prev.task, text)
        const msg = {
          id: randomUUID(),
          role: 'user' as const,
          agentId: '',
          step: '',
          text,
          ...(expanded ? { prompt: expanded } : {}),
          tools: [],
          ...(attachments.length ? { attachments } : {}),
          at: new Date().toISOString(),
        }
        const delivered = deliverWait(prev.task, msg)
        if (delivered === 'ok') {
          prev.task.updatedAt = new Date().toISOString()
          await store.update(id, prev.task)
          return c.json(prev.task)
        }
        // 等着的还是旧 CLI：让它退出，按输入框里现在的选择重新开始这一轮
        if (delivered === 'stale') {
          prev.restart = true
          if (prev.done) await prev.done
          const next = live.get(id)
          if (next) {
            // 新进程已经起来了：直接交给它；还没进入等待时排进队列，它启动后会取走
            if (deliverWait(next.task, msg) === 'ok') {
              next.task.updatedAt = new Date().toISOString()
              await store.update(id, next.task)
              return c.json(next.task)
            }
            next.task.queue.push({ id: msg.id, text, attachments, at: msg.at, note: false })
            next.task.updatedAt = new Date().toISOString()
            await store.update(id, next.task)
            return c.json(next.task)
          }
          return c.json(await followUp(id, { text, attachments }))
        }
        if (p.data.steer && (await steerTask(prev.task, withAttachments(expanded || text, attachments), msg))) {
          prev.task.updatedAt = new Date().toISOString()
          await store.update(id, prev.task)
          return c.json(prev.task)
        }
      }
      if (!interrupt) {
        // 执行中：先排队，这一轮完成后自动接着处理
        prev.task.queue.push({ id: randomUUID(), text, attachments, at: new Date().toISOString(), note: false })
        prev.task.updatedAt = new Date().toISOString()
        await store.update(id, prev.task)
        return c.json(prev.task)
      }
      // 打断：停下当前这一轮再发。停下后任务是「已暂停」，排队的要求不会自动跑
      stopTask(id)
    }
    // 刚执行完、还在落盘的任务：等它写完再接着跑
    prev = live.get(id)
    if (prev) await prev.done
    if (live.has(id)) return bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    return c.json(await followUp(id, { text, attachments }))
  })

  /**
   * 在后台用 --resume 启动对话的 CLI，让它停在等下一句的工具上。
   * force：用户刚换了 CLI/模型/强度，即使会话属于旧 CLI 也要按新的选择重开，
   * 把之前的对话带过去，下一条消息直接交给新进程。
   */
  async function prewarmChat(task: Task, force = false): Promise<Task> {
    if (live.has(task.id)) return live.get(task.id)!.task
    if (task.imported || task.mode !== 'chat' || task.status === 'running') return task
    // 没有会话、刚撤回时下一轮本来就要重开，预热没有意义
    if (!task.sessions[task.agentId] || task.rewind) return task
    try {
      const settings = await getSettings()
      const agents = await deps.agents.list()
      const agent = agents.find((a) => a.id === task.agentId)
      if (!agent?.enabled) return task
      const run = agentRun(withTaskModel(agent, task), settings)
      const def = getCli(run.cli)
      if (!def?.notes || !def.mcp) return task
      // Claude Code、Codex 有自己的协议，不走面板的等待工具
      if (def.rpc?.nativeAsk) return task
      if (!force && task.sessionCli && task.sessionCli !== run.cli) return task
      if (live.has(task.id)) return live.get(task.id)!.task
      const entry = reserve(task)
      return await start(entry, PREWARM_PROMPT, false, agents, undefined, false, true)
    } catch (e) {
      live.delete(task.id)
      log.warn('task', '对话预热失败', { task: task.id, error: (e as Error).message })
      return task
    }
  }

  // 打开对话页时调用
  routes.post('/:id/prewarm', async (c) => {
    const id = c.req.param('id')
    if (live.has(id)) return c.json(await current(id))
    const task = await store.get(id)
    if (!task) return bad(c, t('任务不存在'), 404)
    return c.json(await prewarmChat(task))
  })

  // 对话页还开着：CLI 回复完才能停在等下一句的工具上；切走一分钟内切回来还能接着发
  routes.post('/:id/presence', async (c) => {
    const id = c.req.param('id')
    const p = PresenceInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return bad(c, z.prettifyError(p.error))
    if (!(await current(id))) return bad(c, t('任务不存在'), 404)
    setViewer(id, p.data.viewerId, p.data.active)
    return c.body(null, 204)
  })

  // 撤回一条排队的要求
  routes.delete('/:id/queue/:qid', async (c) => {
    const id = c.req.param('id')
    const tk = live.get(id)?.task ?? (await store.get(id))
    if (!tk) return bad(c, t('任务不存在'), 404)
    const qid = c.req.param('qid')
    if (!tk.queue.some((q) => q.id === qid)) return bad(c, t('这条要求已经开始处理了'), 404)
    tk.queue = tk.queue.filter((q) => q.id !== qid)
    tk.updatedAt = new Date().toISOString()
    return c.json(await store.update(id, tk))
  })

  // 改一条排队的要求（还没开始处理的才能改）
  routes.patch('/:id/queue/:qid', async (c) => {
    const id = c.req.param('id')
    const p = z.object({ text: z.string().trim().min(1) }).safeParse(await c.req.json().catch(() => ({})))
    if (!p.success) return bad(c, t('要求不能为空'))
    const tk = live.get(id)?.task ?? (await store.get(id))
    if (!tk) return bad(c, t('任务不存在'), 404)
    const q = tk.queue.find((x) => x.id === c.req.param('qid'))
    if (!q) return bad(c, t('这条要求已经开始处理了'), 404)
    q.text = p.data.text
    tk.updatedAt = new Date().toISOString()
    return c.json(await store.update(id, tk))
  })

  // 结束工作流：没完成的节点不再执行，之后的要求由主 Agent 直接处理
  routes.post('/:id/end-flow', async (c) => {
    const id = c.req.param('id')
    const prev = live.get(id)
    if (prev && prev.task.status !== 'running') await prev.done
    if (live.has(id)) return bad(c, t('任务正在执行，请先停止'), 409)
    const tk = await store.get(id)
    if (!tk) return bad(c, t('任务不存在'), 404)
    if (tk.imported) return bad(c, READONLY, 409)
    if (tk.mode !== 'workflow') return bad(c, t('只有工作流任务可以结束流程'))
    closeFlow(tk, randomUUID())
    return c.json(await store.update(id, tk))
  })

  // 失败或停止后继续：不加新消息，从没完成的节点接着跑；工作流已完成时重做最后一条要求
  routes.post('/:id/resume', async (c) => {
    const id = c.req.param('id')
    const prev = live.get(id)
    if (prev && prev.task.status !== 'running') await prev.done
    if (live.has(id)) return bad(c, t('任务正在执行'), 409)
    const task = await store.get(id)
    if (!task) return bad(c, t('任务不存在'), 404)
    if (task.imported) return bad(c, READONLY, 409)
    // 停在某个节点结论上的工作流（例如前置检查不通过）也能继续：从那个节点重新检查
    const blocked = !!blockedStep(task, taskFlow(task, taskWorkflows(task, await deps.workflows.list()).workflow))
    if (task.status !== 'failed' && task.status !== 'stopped' && !blocked)
      return bad(c, t('只有失败或停止的任务可以继续'))
    // latest：改用现在的工作流（任务创建后工作流改过，想按新的流程接着跑）
    const { latest } = (await c.req.json().catch(() => ({}))) as { latest?: boolean }
    let fresh: Workflow | undefined
    if (latest && task.workflowId) {
      fresh = (await deps.workflows.get(task.workflowId)) ?? undefined
      if (!fresh) return bad(c, t('工作流已经被删除，只能按任务创建时的工作流继续'))
    }
    const entry = reserve(task)
    dropEndNotes(entry.task)
    const users = task.messages.filter((m) => m.role === 'user' && !m.step)
    try {
      if (fresh) {
        entry.task.workflows = taskSnapshot(fresh, await deps.workflows.list())
        entry.task.workflowName = fresh.name
      }
      const last = users.at(-1)
      return c.json(
        await start(
          entry,
          withAttachments(last?.prompt || last?.text || '', last?.attachments),
          false,
          await deps.agents.list(),
          undefined,
          true,
        ),
      )
    } catch (e) {
      live.delete(id)
      throw e
    }
  })

  /** 任务的工作目录：项目目录，聊天是它自己的目录 */
  const taskDir = async (tk: Pick<Task, 'worktree' | 'projectId' | 'id'>) =>
    isolated(tk)
      ? tk.worktree!.path
      : tk.projectId
        ? ((await deps.projects.get(tk.projectId))?.path ?? '')
        : path.join(CHATS_DIR, tk.id)

  /** 合并或丢弃独立分支：只在任务停下时做，免得 Agent 还在往里写 */
  async function finishWorktree(c: Context, merge: boolean) {
    const id = c.req.param('id')!
    if (live.has(id)) return bad(c, t('任务正在执行，等它停下后再处理独立分支'), 409)
    const tk = await store.get(id)
    if (!tk) return bad(c, t('任务不存在'), 404)
    if (!isolated(tk)) return bad(c, t('这个任务没有待处理的独立分支'))
    const project = await deps.projects.get(tk.projectId)
    if (!project) return bad(c, t('任务所属的项目已经不存在'))
    const wt = tk.worktree!
    try {
      if (merge) {
        const target = await mergeWorktree(project.path, wt, `Agent 面板：${tk.title}`)
        return c.json(await store.update(id, { ...tk, worktree: { ...wt, state: 'merged', note: target } }))
      }
      await removeWorktree(project.path, wt, true)
      return c.json(await store.update(id, { ...tk, worktree: { ...wt, state: 'discarded', note: '' } }))
    } catch (e) {
      return bad(c, (e as Error).message, 409)
    }
  }
  routes.post('/:id/worktree/merge', (c) => finishWorktree(c, true))
  routes.post('/:id/worktree/discard', (c) => finishWorktree(c, false))

  /** 删除任务时，没合并的独立分支一起清掉，免得数据目录里越积越多 */
  async function dropWorktree(tk: Task, repo?: string) {
    if (!isolated(tk)) return
    repo ??= (await deps.projects.get(tk.projectId))?.path
    if (repo) await removeWorktree(repo, tk.worktree!, true).catch(() => {})
    else await rm(tk.worktree!.path, { recursive: true, force: true }).catch(() => {})
  }

  // 一个改动文件的差异：git 仓库和任务开始时的提交比；不是仓库时拼出 Agent 改这个文件时给出的改动
  routes.get('/:id/diff', async (c) => {
    const tk = await current(c.req.param('id'))
    if (!tk) return bad(c, t('任务不存在'), 404)
    const file = c.req.query('path') ?? ''
    if (!tk.changes.some((x) => x.path === file)) return bad(c, t('这个文件不在任务的改动里'))
    const dir = await taskDir(tk)
    // 导入的任务改的是别人电脑上的文件，只能拼出 Agent 当时给出的改动
    const isGit = !tk.imported && !!dir && (await gitNumstat(dir, tk.baseRef).catch(() => null)) !== null
    if (isGit) {
      const diff = await gitFileDiff(dir, tk.baseRef, file)
      return c.json({ path: file, dir, diff, git: true, before: file in tk.baseline })
    }
    const patches = tk.messages
      .flatMap((m) => m.tools)
      .filter((x) => x.kind === 'edit' && x.label === file && x.input)
      .map((x) => x.input!)
    return c.json({ path: file, dir, diff: patches.join('\n'), git: false, before: false })
  })

  // Agent 输出里提到的文件：读出内容给任务页显示。只能读任务目录里面的文件
  routes.get('/:id/file', async (c) => {
    const tk = await current(c.req.param('id'))
    if (!tk) return bad(c, t('任务不存在'), 404)
    if (tk.imported) return bad(c, t('导入的任务看不到对方电脑上的文件'))
    const dir = await taskDir(tk)
    const want = (c.req.query('path') ?? '').trim()
    if (!dir || !want) return bad(c, t('缺少文件路径'))
    const full = path.resolve(dir, want)
    const rel = path.relative(dir, full)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return bad(c, t('只能查看项目目录里的文件'))
    const info = await stat(full).catch(() => null)
    if (!info?.isFile()) return c.json({ path: rel, dir, exists: false, content: '', truncated: false })
    const LIMIT = 400_000
    const buf = await readFile(full)
    const head = buf.subarray(0, LIMIT)
    // 有 0 字节的多半是二进制文件，不显示内容
    if (head.includes(0)) return c.json({ path: rel, dir, exists: true, binary: true, content: '', truncated: false })
    return c.json({ path: rel, dir, exists: true, content: head.toString('utf8'), truncated: buf.length > LIMIT })
  })

  // 撤销一个文件的改动：恢复成任务开始时的样子
  routes.post('/:id/revert', async (c) => {
    const id = c.req.param('id')
    if (live.has(id)) return bad(c, t('任务正在执行，等它停下后再撤销'), 409)
    const tk = await store.get(id)
    if (!tk) return bad(c, t('任务不存在'), 404)
    if (tk.imported) return bad(c, READONLY, 409)
    const { path: file } = (await c.req.json().catch(() => ({}))) as { path?: string }
    if (!file || !tk.changes.some((x) => x.path === file)) return bad(c, t('这个文件不在任务的改动里'))
    const dir = await taskDir(tk)
    if (!dir || (await gitNumstat(dir, tk.baseRef).catch(() => null)) === null)
      return bad(c, t('项目不是 git 仓库，没法知道改动前的内容，不能自动撤销'))
    if (file in tk.baseline)
      return bad(c, t('这个文件在任务开始前就有没提交的改动，撤销会一起丢掉，请在编辑器里手动处理'))
    try {
      await gitRevertFile(dir, tk.baseRef, file)
    } catch (e) {
      return bad(c, t('撤销失败：{error}', { error: (e as Error).message }))
    }
    const changes = (await gitChanges(dir, tk.baseline, tk.baseRef).catch(() => null)) ?? tk.changes
    return c.json(await store.update(id, { ...tk, changes }))
  })

  // 回答 Agent 的请求：允许 / 拒绝一个操作，或者回答问题
  routes.post('/:id/requests/:rid', async (c) => {
    const e = live.get(c.req.param('id'))
    const body = RequestAnswer.safeParse(await c.req.json())
    if (!body.success) return bad(c, z.prettifyError(body.error))
    if (!e || !answerRequest(e.task, c.req.param('rid'), body.data, randomUUID))
      return bad(c, t('这个请求已经结束了'), 404)
    e.task.updatedAt = new Date().toISOString()
    trackWait(e.task)
    await store.update(e.task.id, e.task)
    return c.json(e.task)
  })

  routes.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const p = TaskPatch.safeParse(await c.req.json())
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const e = live.get(id)
    const cur = e?.task ?? (await store.get(id))
    if (!cur) return bad(c, t('任务不存在'), 404)
    if (cur.imported && Object.keys(p.data).some((k) => k !== 'title' && k !== 'archived')) return bad(c, READONLY, 409)
    const touchesRun = p.data.cli !== undefined || p.data.model !== undefined || p.data.effort !== undefined
    if (touchesRun && cur.mode !== 'chat') return bad(c, t('只有对话任务可以这样做'))
    const settings = touchesRun ? await getSettings() : undefined
    const agents = touchesRun ? await deps.agents.list() : undefined
    const runOf = (t: Task) => {
      const agent = agents?.find((a) => a.id === t.agentId)
      return agent && settings ? agentRun(withTaskModel(agent, t), settings) : undefined
    }
    const beforeRun = runOf(cur)
    // 换 CLI 前记下会话是哪个 CLI 的（以前的任务没记），下一轮才知道要开新会话
    if (p.data.cli !== undefined && !cur.sessionCli && cur.sessions[cur.agentId]) {
      const agent = agents?.find((a) => a.id === cur.agentId)
      if (agent && settings) cur.sessionCli = agentRun(withTaskModel(agent, cur), settings).cli
    }
    const task = cur
    Object.assign(task, p.data)
    if (p.data.askUser === false) autoAnswerQuestions(task)
    // 执行中的任务平时按节点落盘，改名这类操作要马上写下去，否则重启后会丢
    await store.update(id, task)
    if (!touchesRun) return c.json(task)
    const afterRun = runOf(task)
    const runChanged =
      !!beforeRun &&
      !!afterRun &&
      (beforeRun.cli !== afterRun.cli || beforeRun.model !== afterRun.model || beforeRun.effort !== afterRun.effort)
    if (!runChanged) return c.json(task)
    // 正在回复这一轮：不能现在换进程；这一轮结束时 start 的收尾会按新的选择重开
    if (e?.task.working) return c.json(task)
    // 空闲的常驻 CLI：让它结束，按新的选择重新预热，命令和上下文不再显示旧 CLI
    if (e) {
      e.restart = true
      const canceled = cancelWait(id)
      if (!canceled) {
        e.stop = true
        e.abort.abort()
      }
      if (!e.done) return c.json(task)
      await e.done
      // 排队的要求由收尾的 followUp 用新的选择接着跑，不要在这里和它抢执行位
      if (live.has(id)) return c.json(live.get(id)!.task)
      if (!canceled) task.status = 'done'
    }
    task.command = []
    delete task.usage.agents[task.agentId]
    task.working = false
    task.awaitingUser = false
    task.prewarming = false
    await store.update(id, task)
    return c.json(await prewarmChat(task, true))
  })

  /** 停着的对话任务（没在执行）：分叉、撤回、压缩、审查都要先停下 */
  async function idleTask(c: Context, chatOnly = true) {
    const id = c.req.param('id')!
    const prev = live.get(id)
    if (prev && prev.task.status !== 'running') await prev.done
    if (live.has(id)) return bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    const task = await store.get(id)
    if (!task) return bad(c, t('任务不存在'), 404)
    if (task.imported) return bad(c, READONLY, 409)
    if (chatOnly && task.mode !== 'chat') return bad(c, t('只有对话任务可以这样做'))
    return task
  }

  /** 第 i 条用户消息之前（不含）最近一条用户消息的那一轮，没有时为 null；latest：那一轮是会话的最后一轮 */
  function turnBefore(task: Task, i: number) {
    const prev = [...task.messages.slice(0, i)].reverse().find((m) => m.role === 'user' && !m.step)
    if (!prev?.turn) return { through: null, session: '', latest: false }
    const th = prev.turn
    const at = task.messages.indexOf(prev)
    const latest = !task.messages.slice(at + 1).some((m) => m.turn?.session === th.session)
    return { through: th, session: th.session, latest }
  }

  // 撤回到某条消息：这条和之后的对话都去掉，下一轮从它之前接着聊（文件改动不会撤销）；返回被撤回的那条，方便改了再发
  routes.post('/:id/rewind', async (c) => {
    const task = await idleTask(c)
    if (task instanceof Response) return task
    const { messageId } = (await c.req.json().catch(() => ({}))) as { messageId?: string }
    const i = task.messages.findIndex((m) => m.id === messageId && m.role === 'user' && !m.step)
    if (i < 0) return bad(c, t('找不到这条消息'))
    if (!task.messages.slice(0, i).some((m) => m.role === 'user'))
      return bad(c, t('第一条消息不能撤回，可以新建一个对话'))
    const removed = task.messages[i]
    const updated = await store.update(task.id, {
      ...task,
      messages: task.messages.slice(0, i),
      rewind: turnBefore(task, i),
      status: 'done',
      queue: [],
      todos: [],
    })
    return c.json({ task: updated, text: removed.text, attachments: removed.attachments ?? [] })
  })

  // 从某条消息分叉：新建一个对话，带着到这条消息为止的对话（含它的回复），原对话不动
  routes.post('/:id/fork', async (c) => {
    const task = await idleTask(c)
    if (task instanceof Response) return task
    const { messageId } = (await c.req.json().catch(() => ({}))) as { messageId?: string }
    const i = task.messages.findIndex((m) => m.id === messageId && m.role === 'user' && !m.step)
    if (i < 0) return bad(c, t('找不到这条消息'))
    // 留到下一条用户消息之前：这条消息和它的回复都带上
    const next = task.messages.findIndex((m, k) => k > i && m.role === 'user' && !m.step)
    const kept = task.messages.slice(0, next < 0 ? task.messages.length : next)
    const { through, session, latest } = turnBefore(task, next < 0 ? task.messages.length : next)
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = task
    const agents = Object.fromEntries(
      Object.entries(task.usage.agents).map(([k, v]) => [k, { ...v, tps: 0, lastTps: 0, outputTokens: 0, genMs: 0 }]),
    )
    const forked = await store.create({
      ...rest,
      title: t('{title}（分叉）', { title: task.title }).slice(0, 80),
      // 消息 id 换新的，免得两个任务里的消息 id 相同
      messages: kept.map((m) => ({ ...m, id: randomUUID() })),
      rewind: { through, session, latest },
      status: 'done',
      runMs: 0,
      runStartedAt: '',
      queue: [],
      requests: [],
      todos: [],
      worktree: null,
      archived: undefined,
      usage: { agents, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    })
    return c.json(forked, 201)
  })

  // 压缩上下文：让 CLI 把这个对话的会话压缩（不能压缩的 CLI 写一份摘要，下一轮开新会话带上）
  routes.post('/:id/compact', async (c) => {
    const task = await idleTask(c)
    if (task instanceof Response) return task
    if (!task.sessions[task.agentId] && !task.rewind) return bad(c, t('还没有会话，不需要压缩'))
    const entry = reserve(task)
    entry.task.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: t('压缩上下文'),
      tools: [],
      at: new Date().toISOString(),
    })
    try {
      return c.json(await start(entry, '', false, await deps.agents.list(), { kind: 'compact' }))
    } catch (e) {
      live.delete(task.id)
      throw e
    }
  })

  // 审查改动：Codex 用自己的审查模式，其他 CLI 按审查的要求跑一轮；只审查，不改文件
  routes.post('/:id/review', async (c) => {
    const task = await idleTask(c, false)
    if (task instanceof Response) return task
    const body = (await c.req.json().catch(() => ({}))) as { base?: string }
    const target = body.base ? { type: 'base' as const, branch: body.base } : { type: 'uncommitted' as const }
    if (!(await taskDir(task)) || (await gitNumstat(await taskDir(task), '').catch(() => null)) === null)
      return bad(c, t('项目不是 git 仓库，没法审查改动'))
    const entry = reserve(task)
    const text = body.base ? t('审查相对 {branch} 的改动', { branch: body.base }) : t('审查还没提交的改动')
    entry.task.messages.push({
      id: randomUUID(),
      role: 'user',
      agentId: '',
      step: '',
      text,
      tools: [],
      at: new Date().toISOString(),
    })
    try {
      return c.json(await start(entry, text, false, await deps.agents.list(), { kind: 'review', target }))
    } catch (e) {
      live.delete(task.id)
      throw e
    }
  })

  routes.post('/:id/stop', async (c) => {
    const id = c.req.param('id')
    stopTask(id)
    return c.json(await current(id))
  })

  routes.delete('/:id', async (c) => {
    const id = c.req.param('id')
    stopTask(id)
    const task = await store.get(id)
    if (!task || !(await store.remove(id))) return bad(c, t('任务不存在'), 404)
    forgetPresence(id)
    await dropUploads([task])
    await dropWorktree(task)
    // 聊天的工作目录、节点交接的文件跟着删掉
    await rm(path.join(CHATS_DIR, id), { recursive: true, force: true }).catch(() => {})
    await rm(path.join(HANDOFF_DIR, id), { recursive: true, force: true }).catch(() => {})
    return c.body(null, 204)
  })

  return {
    routes,
    /**
     * 正在执行的任务数；更新、备份前要等它们结束。
     * 对话停在等下一句、预热时进程还活着但不改任何东西，不算执行中，否则更新会一直等下去
     */
    running: () => [...live.values()].filter((e) => e.task.working).length,
    /** 服务退出前停掉所有正在跑的 CLI，免得它们在后台继续改项目 */
    stopAll() {
      shuttingDown = true
      for (const id of live.keys()) stopTask(id)
      return Promise.allSettled([...live.values()].map((e) => e.done))
    },
    /** repo：项目目录。项目已经删掉了，要靠它清理任务的独立分支 */
    async removeByProject(projectId: string, repo?: string) {
      const removed = (await store.list()).filter((t) => t.projectId === projectId)
      for (const t of removed) {
        stopTask(t.id)
        await store.remove(t.id)
        forgetPresence(t.id)
        await dropWorktree(t, repo)
        await rm(path.join(HANDOFF_DIR, t.id), { recursive: true, force: true }).catch(() => {})
      }
      await dropUploads(removed)
    },
    /** 启动时清理没有任务在用的附件 */
    async cleanupUploads() {
      await cleanupUploads(new Set((await store.list()).flatMap((t) => [...uploadDirs(t)])))
    },
  }
}
