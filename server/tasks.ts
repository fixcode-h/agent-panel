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
  type TaskMessage,
  type Workflow,
  RequestAnswer,
  defaultAgent,
} from '../shared/schema.ts'
import { blockedStep, entryFlow, taskFlow, taskWorkflows, topoOrder } from '../shared/flow.ts'
import { taskSnapshot } from '../shared/builtin/default.ts'
import { projectDefaultWorkflow } from '../shared/project-workflow.ts'
import { exposeSlots } from '../shared/expose.ts'
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
import { dropHeld, hasHeld, holdForNextTurn, takeHeld } from './exec/delivery.ts'
import {
  forgetPresence,
  rescheduleIfUnwatched,
  setPresenceIdleHandler,
  setPresenceUnreadKeeper,
  setViewer,
} from './presence.ts'
import { placeAttachments } from './attachments.ts'
import { CHATS_DIR, HANDOFF_DIR } from './store.ts'
import { createTaskStore } from './task-store.ts'
import { createWorktree, mergeWorktree, removeWorktree } from './exec/worktree.ts'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { cleanupUploads, clipTranscript, removeUploads, saveTextUpload, uploadDirOf } from './uploads.ts'
import { listDir, listLevel, rawInDir, readInDir, revealInDir, searchInDir, searchNameInDir } from './files.ts'
import path from 'node:path'
import { log } from './log.ts'
import { t } from '../shared/i18n.ts'
import { importTask, parseTaskExport } from '../shared/task-export.ts'
import { collisions, createClaims } from './claims.ts'

/** 发布全局规则的命令：/rule 或 /rules */
const RULE_CMD = /^\/rules?(?=\s|$)/i

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
  /** 子对话共用父对话的目录：改文件前的认领，按父对话分组 */
  const claims = createClaims()
  /**
   * 每个项目对话同时执行的子对话数：父对话分派的子对话超过上限（设置里的 childConcurrency）就排队，
   * 前面的做完一轮再开始。用户自己在子对话里发消息不排队
   */
  const slots = new Map<string, { running: number; queue: (() => void)[] }>()
  async function takeSlot(parentId: string) {
    const limit = (await getSettings()).childConcurrency
    const s = slots.get(parentId) ?? slots.set(parentId, { running: 0, queue: [] }).get(parentId)!
    if (s.running >= limit) await new Promise<void>((r) => s.queue.push(r))
    s.running++
    let done = false
    return () => {
      if (done) return
      done = true
      s.running--
      const next = s.queue.shift()
      if (next) next()
      else if (!s.running) slots.delete(parentId)
    }
  }
  const queued = (parentId: string) => slots.get(parentId)?.queue.length ?? 0
  // 对话页切走后宽限期到了就别让 CLI 一直等下一句了，结束这一轮（宽限时长在设置里改）；
  // 父对话的 CLI 结束时它名下子对话的进程一起结束，不留孤儿
  setPresenceIdleHandler((id) => {
    cancelWait(id)
    void closeChildren(id)
  })
  // 这一轮完成但用户还没打开看过（侧栏橙点）的对话不回收：用户回来时还能直接接着说
  setPresenceUnreadKeeper((id) => {
    const tk = live.get(id)?.task
    if (!tk) return false
    return !!tk.turnDoneAt && tk.turnDoneAt !== tk.turnSeenAt
  })
  /** 服务正在退出：不再接着处理这一轮结束后要处理的消息 */
  let shuttingDown = false
  /** 同步占住任务的执行位，避免两次请求在 await 的间隙里各自启动一遍 */
  const reserve = (task: Task): Live => {
    const entry: Live = { task: structuredClone(task), stop: false, abort: new AbortController(), rev: 0 }
    live.set(task.id, entry)
    return entry
  }

  // 服务重启时，之前没跑完的任务标记为已停止；正在跑的节点记为被打断，继续执行时续接它的会话
  // 对外暴露成 ready：读取「被更新打断的任务」时要等这一步做完，否则还会读到 running
  const ready = store.list().then(async (all) => {
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
    workflowIds: [],
    defaultAgentId: '',
    agentSet: true,
    workflowParams: {},
    testSteps: [],
    wslDistro: '',
    gitPolicy: 'ask',
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

  /**
   * 附件拷进任务自己的执行目录，路径换成相对 Agent 的那一份。
   * Chat 的执行目录要先建出来（它本来只在第一次执行时才建）。
   */
  async function placeInTask(tk: Pick<Task, 'worktree' | 'projectId' | 'id'>, attachments: Attachment[]) {
    if (!attachments.length) return attachments
    const dir = await taskDir(tk)
    if (!dir) return attachments
    if (!tk.projectId && !isolated(tk)) await mkdir(dir, { recursive: true })
    return placeAttachments(dir, attachments)
  }

  /**
   * 落盘里还写着「执行中」、内存里却没有这个任务：进程早就不在了（面板重启过、崩溃过）。
   * 按已停止返回，否则页面会一直显示执行中，也不会把 CLI 重新启动回来。
   */
  const idle = (task: Task): Task =>
    task.status === 'running' && !live.has(task.id)
      ? { ...task, status: 'stopped' as const, working: false, awaitingUser: false, prewarming: false }
      : task

  const current = async (id: string) => {
    const entry = live.get(id)
    if (entry) return entry.task
    const task = await store.get(id)
    return task ? idle(task) : task
  }
  const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)
  /** 导入的任务只读：只能看、改名、归档、删除 */
  const READONLY = t('这是导入的任务，只能查看，不能继续执行')

  /** 项目默认的工作流：项目自己指定 → 分类默认 → 内置的「通用项目」 */
  async function projectWorkflow(p: Project) {
    const cat = p.categoryId ? await deps.projectCategories.get(p.categoryId) : null
    return projectDefaultWorkflow(p, cat ? [cat] : [], await deps.workflows.list())
  }

  /** 项目设置里这个工作流的暴露项取值（每个工作流一份） */
  const paramsOf = (p: Project, workflowId: string) => p.workflowParams[workflowId] ?? {}

  /** 子对话 Agent 能选的工作流：项目默认 + 可选列表，按名称、说明和节点概览交给它挑 */
  function workflowCatalog(project: Project, all: Workflow[], fallback?: Workflow) {
    const picked = [fallback, ...project.workflowIds.map((id) => all.find((w) => w.id === id))]
      .filter((w): w is Workflow => !!w)
      .filter((w, i, list) => list.findIndex((x) => x.id === w.id) === i)
    return picked.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      steps: topoOrder(entryFlow(w))
        .map((n) => n.title.trim())
        .filter(Boolean)
        .slice(0, 8),
    }))
  }

  /** 对话 Agent 启动计划时按 id 取工作流；id 为空用项目默认工作流 */
  function planWorkflow(project: Project, all: Workflow[], fallback: Workflow | undefined, id: string) {
    const target = id ? (all.find((w) => w.id === id) ?? fallback) : fallback
    if (!target) return undefined
    const params = paramsOf(project, target.id)
    const snapshot = taskSnapshot(target, all, params, testOpts(project))
    return {
      workflow: snapshot.find((w) => w.id === target.id) ?? target,
      workflows: snapshot,
      skillSlots: exposeSlots(target, params),
    }
  }

  /**
   * 项目级测试步骤和平台：新建对话时快照进任务，测试 Agent 按它执行，之后改项目设置不影响已开始的对话。
   * agents 用来判断某个工作流里有没有测试 Agent（见 withTestSteps）。
   */
  const testOpts = (project: Project) => ({
    agents: liveAgents,
    testSteps: project.testSteps,
    platform: process.platform,
    wslDistro: project.wslDistro,
  })
  /** 最近一次读到的 Agent 列表：测试步骤注入要判断哪些工作流用到了测试 Agent；新建任务前会刷新 */
  let liveAgents: Agent[] = []
  const refreshAgents = async () => (liveAgents = await deps.agents.list())

  /** 子对话的摘要：最近一条 Agent 回复的开头 */
  function lastReply(task: Task) {
    const last = [...task.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())
    return last ? last.text.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  }

  /** 最近一条消息的时间：子对话列表按它排序（updatedAt 会被改名、看过之类的操作改动） */
  function lastMessageAt(task: Task) {
    return task.messages.at(-1)?.at ?? task.updatedAt
  }

  /**
   * 父对话的 CLI 结束了（宽限期到、用户停止、切换 CLI/模型、页面离开后被回收）：
   * 它名下子对话的进程一起结束，不留孤儿。子对话已产出的内容和状态都在，下次发消息会重新启动。
   * 统一在这里做，各个路由只管调用它。
   */
  async function closeChildren(parentId: string) {
    const kids = (await store.list()).filter((x) => x.parentTaskId === parentId)
    for (const k of kids) {
      if (!live.has(k.id)) continue
      const entry = live.get(k.id)!
      // 正在等下一句的直接结束这一轮；正在执行的按停止处理（输出和状态都保留）
      if (!cancelWait(k.id)) stopTask(k.id)
      if (entry.done) await entry.done.catch(() => {})
      if (live.has(k.id)) stopTask(k.id)
    }
  }

  /** 子对话跑完一轮后，把结果摘要回报给父对话（父对话还开着就实时推送） */
  async function reportToParent(task: Task) {
    if (!task.parentTaskId) return
    const parent = live.get(task.parentTaskId)?.task ?? (await store.get(task.parentTaskId))
    if (!parent) return
    const status = task.status === 'done' ? t('已完成') : task.status === 'failed' ? t('失败') : t('已停止')
    const summary = task.summary || lastReply(task)
    const text = `子对话「${task.title}」${status}${summary ? `：\n${summary}` : ''}`
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      at: new Date().toISOString(),
    }
    // 父对话正在执行：实时交给它；交不了的记进收件箱，父对话下一轮开始时一起处理
    const entry = live.get(parent.id)
    const how = entry?.task.working ? await steerTask(entry.task, text, msg).catch(() => false) : false
    if (!how) {
      parent.messages.push(msg)
      parent.inbox.push({
        from: task.id,
        title: task.title,
        text: `${status}${summary ? `：${summary}` : ''}`,
        at: msg.at,
      })
    }
    parent.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    // 父对话空闲时也要马上落盘，否则页面刷新后看不到子对话的回报
    await store
      .update(parent.id, parent)
      .catch((e) => log.warn('task', '回报父对话失败', { error: (e as Error).message }))
  }

  /**
   * 「/rule 内容」发布一条全局规则；「/rule」不带内容列出现有规则；「/rule clear」清空，「/rule -2」删掉第 2 条。
   * 只有项目里的顶层对话能用：规则存在这个对话上，名下所有子对话（连同它们的工作流节点）每次调用都带上，
   * 正在执行的子对话马上收到。不写进项目的 AGENTS.md
   */
  async function ruleCommand(id: string, text: string): Promise<{ task: Task } | { error: string }> {
    const entry = live.get(id)
    const tk = entry?.task ?? (await store.get(id))
    if (!tk) return { error: t('任务不存在') }
    if (!tk.projectId || tk.parentTaskId)
      return { error: t('全局规则只能在项目对话里发布，子对话会自动遵守父对话的规则') }
    const arg = text.replace(RULE_CMD, '').trim()
    const at = new Date().toISOString()
    let note: string
    let fresh = ''
    if (!arg) {
      note = tk.rules.length
        ? t('这个对话的全局规则：\n{list}', { list: tk.rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n') })
        : t('这个对话还没有全局规则。输入「/rule 内容」发布一条，所有子对话都会遵守。')
    } else if (/^(clear|清空)$/i.test(arg)) {
      tk.rules = []
      note = t('已清空全局规则')
    } else if (/^-\d+$/.test(arg)) {
      const n = Number(arg.slice(1))
      const gone = tk.rules[n - 1]
      if (!gone) return { error: t('没有第 {n} 条规则', { n }) }
      tk.rules = tk.rules.filter((_, i) => i !== n - 1)
      note = t('已删除全局规则：{text}', { text: gone.text })
    } else {
      tk.rules = [...tk.rules, { id: randomUUID(), text: arg.slice(0, 2000), at }]
      fresh = arg
      note = t('已发布全局规则：{text}。这个对话下的所有子对话都会遵守，不写进项目的 AGENTS.md。', { text: arg })
    }
    tk.messages.push({ id: randomUUID(), role: 'system', agentId: '', step: '', text: note, tools: [], at })
    tk.updatedAt = at
    if (entry) entry.rev++
    await store.update(tk.id, tk)
    // 正在执行的子对话马上收到新规则；没在执行的下一轮开始时从父对话读
    if (fresh)
      for (const k of [...live.values()].filter((e) => e.task.parentTaskId === tk.id && e.task.working)) {
        const body = `父对话发布了新的全局规则，接下来必须遵守：${fresh}`
        const msg: TaskMessage = { id: randomUUID(), role: 'system', agentId: '', step: '', text: body, tools: [], at }
        const how = await steerTask(k.task, body, msg).catch(() => false)
        if (!how) k.task.messages.push(msg)
        k.rev++
      }
    return { task: tk }
  }

  /** 父对话分派的子对话：占一个执行位再开始，这一轮结束（含它跑的工作流）才让出来 */
  async function startChild(parentId: string, sub: Task, message: string, agents: Agent[]) {
    const free = await takeSlot(parentId)
    try {
      const entry = reserve(sub)
      await start(entry, withAttachments(message, []), true, agents)
      await entry.done
    } catch (e) {
      log.error('task', '子对话执行出错', { task: sub.id, error: (e as Error).message })
    } finally {
      free()
    }
  }

  /** 子对话给父对话发消息：父对话正在执行就实时交给它，否则记进父对话，下一轮一起处理 */
  async function messageParent(child: Task, text: string, question: boolean) {
    const parent = live.get(child.parentTaskId)?.task ?? (await store.get(child.parentTaskId))
    if (!parent) return { ok: false, info: '找不到父对话' }
    const head = question ? `子对话「${child.title}」提问` : `子对话「${child.title}」汇报`
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: `${head}：\n${text}`,
      tools: [],
      at: new Date().toISOString(),
    }
    const entry = live.get(parent.id)
    const how = entry?.task.working ? await steerTask(entry.task, msg.text, msg).catch(() => false) : false
    if (!how) {
      parent.messages.push(msg)
      parent.inbox.push({ from: child.id, title: child.title, text: question ? `（提问）${text}` : text, at: msg.at })
    }
    parent.updatedAt = msg.at
    if (entry) entry.rev++
    else await store.update(parent.id, parent).catch(() => {})
    if (how) return { ok: true, info: '已实时交给父对话' }
    return {
      ok: true,
      info: question
        ? '父对话现在没在执行，问题已经记在父对话里，它下一轮会处理。不要停下来等：先按最稳妥的做法继续，或者结束这一轮并写清需要决定的事。'
        : '已记在父对话里，它下一轮会看到',
    }
  }

  /**
   * 子对话一轮结束后：这一轮改过的文件和其他还在执行的兄弟子对话改过的撞了，
   * 在子对话里留一条提醒，并告诉父对话由它协调（两边共用一个目录，后写的会覆盖先写的）
   */
  async function checkCollisions(child: Task) {
    const mine = child.changes.map((c) => c.path)
    if (!mine.length) return
    const others = [...live.values()]
      .map((e) => e.task)
      .filter((x) => x.id !== child.id && x.parentTaskId === child.parentTaskId && x.working)
      .map((x) => ({ title: x.title, files: x.changes.map((c) => c.path) }))
    const hit = collisions(mine, others)
    if (!hit.length) return
    const list = hit.map((h) => `${h.path}（「${h.with}」也在改）`).join('、')
    child.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: t('这些文件同时被别的子对话改过：{list}。已经告诉父对话协调，合并前请检查一遍内容。', { list }),
      tools: [],
      at: new Date().toISOString(),
    })
    await messageParent(
      child,
      `我这一轮改的文件和正在执行的其他子对话撞了：${list}。共用一个目录，后写的可能覆盖先写的，请安排先后或让一方检查。`,
      true,
    )
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
    // 独立分支执行时，Agent 在任务自己的工作目录里改，不碰项目目录；
    // 子对话不建独立分支，和父对话用同一个目录（父对话在独立分支里时就是父的那个目录）
    const dir = found ? await taskDir(task).catch(() => found.path) : ''
    const project = found && dir && dir !== found.path ? { ...found, path: dir } : found
    const parentTask = task.parentTaskId
      ? (live.get(task.parentTaskId)?.task ?? (await store.get(task.parentTaskId)) ?? undefined)
      : undefined
    const rootId = task.parentTaskId || task.id
    // 这一轮启动时的选择，用来判断执行中用户有没有换 CLI/模型/强度。
    // 不用 Agent 角色的对话（agentId 为空）按默认 Agent 的配置算，CLI、模型取任务里选的那一套
    const startAgent = task.agentId ? agents.find((a) => a.id === task.agentId) : { ...defaultAgent(), id: '' }
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
    const allWorkflows = await deps.workflows.list()
    // 项目对话的子对话默认用项目的工作流；独立聊天没有项目工作流
    const defaultWf = project?.id ? ((await projectWorkflow(project)) ?? undefined) : undefined
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
        ...taskWorkflows(entry.task, allWorkflows),
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
        workflowCatalog: () => (defaultWf ? workflowCatalog(project, allWorkflows, defaultWf) : []),
        resolveWorkflow: (id) => (project?.id ? planWorkflow(project, allWorkflows, defaultWf, id) : undefined),
        // 全局规则：父对话自己的，子对话用父对话的（这一轮开始时读一次，执行中新发的靠实时推送）
        rules: (task.parentTaskId ? (parentTask?.rules ?? []) : entry.task.rules).map((r) => r.text),
        takeInbox: task.parentTaskId
          ? undefined
          : () => {
              const got = entry.task.inbox
              entry.task.inbox = []
              return got
            },
        messageParent: task.parentTaskId ? (text, question) => messageParent(entry.task, text, question) : undefined,
        claimFiles: task.parentTaskId
          ? (paths) => claims.claim(rootId, { taskId: task.id, title: entry.task.title }, paths)
          : undefined,
        releaseFiles: task.parentTaskId
          ? (paths) => claims.release(rootId, task.id, paths.length ? paths : undefined)
          : undefined,
        listConversations: async () => {
          const kids = (await store.list()).filter((x) => x.parentTaskId === entry.task.id)
          // 正在跑的对话用内存里的最新状态（标题只在创建时定，摘要随每一轮更新）
          return kids.map((k) => {
            const cur = live.get(k.id)?.task ?? k
            return {
              id: cur.id,
              title: cur.title,
              status: cur.status,
              summary: cur.summary || lastReply(cur),
              at: cur.updatedAt,
            }
          })
        },
        createConversation: async ({ title, message, files }) => {
          if (!project?.id) return { ok: false, info: '独立聊天没有项目，不能创建子对话' }
          const worker = agents.find((a) => a.origin === 'builtin:worker')
          const subId = randomUUID()
          const at = new Date().toISOString()
          const input = NewTaskInput.parse({
            projectId: entry.task.projectId,
            mode: 'chat',
            parentTaskId: entry.task.id,
            rootTaskId: entry.task.rootTaskId || entry.task.id,
            agentId: worker?.id ?? project.defaultAgentId,
            prompt: message,
          })
          const draft = { ...newTask(input, undefined, at, subId, [], {}), id: subId }
          // 标题只在创建时由父对话的 Agent 分析后给一次，后续追加消息不再改标题；
          // 只有直接调接口没给时才退回用户消息开头
          if (title.trim()) draft.title = title.trim().slice(0, 80)
          // 父对话划好的范围先替它认领：别的子对话改这些文件要等它做完
          const got = files?.length
            ? claims.claim(entry.task.id, { taskId: subId, title: draft.title }, files)
            : { granted: [], held: [] }
          const sub = await store.create({ ...draft, id: subId })
          const wait =
            queued(entry.task.id) > 0 || (slots.get(entry.task.id)?.running ?? 0) >= settings.childConcurrency
          void startChild(entry.task.id, sub, message, agents)
          return {
            ok: true,
            id: sub.id,
            title: sub.title,
            info: [
              wait
                ? `已新建子对话「${sub.title}」。同时执行的子对话已经到上限（${settings.childConcurrency} 个），它在排队，前面的做完一个就开始`
                : `已新建子对话「${sub.title}」，它在后台执行，完成后会回报到这里`,
              got.granted.length ? `已替它认领：${got.granted.join('、')}` : '',
              got.held.length
                ? `这些已经归别的子对话，没有认领：${got.held.map((h) => `${h.path}（「${h.by}」）`).join('、')}。让它等那边做完再改，或者把这部分交给那个子对话`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
          }
        },
        sendToConversation: async (id, message) => {
          const child = live.get(id)?.task ?? (await store.get(id))
          if (!child || child.parentTaskId !== entry.task.id) return { ok: false, info: '找不到这个子对话' }
          if (child.imported) return { ok: false, info: READONLY }
          const running = live.get(id)
          if (running?.task.status === 'running') {
            // 和人工输入走同一套投递：能交给 CLI 就马上实时送达，交不出去就等这一轮结束后接着处理
            const msg: TaskMessage = {
              id: randomUUID(),
              role: 'user',
              agentId: '',
              step: '',
              text: message,
              tools: [],
              at: new Date().toISOString(),
            }
            const r = await deliver(running, msg, message, [])
            const how =
              r.how === 'wait'
                ? '已直接交给子对话，它正在处理'
                : r.how === 'steer'
                  ? '子对话正在执行，已实时送达'
                  : r.how === 'notes'
                    ? '子对话正在执行，已实时送达，它执行中会读到'
                    : r.how === 'next-node'
                      ? '子对话正在执行，已实时送达，它接下来的步骤会带上'
                      : '子对话正在执行，这一轮结束后会自动处理这条'
            return { ok: true, info: `「${child.title}」${how}` }
          }
          void (async () => {
            const free = await takeSlot(entry.task.id)
            try {
              await followUp(id, { text: message, attachments: [] })
              await live.get(id)?.done
            } finally {
              free()
            }
          })().catch((e) => log.error('task', '子对话执行出错', { task: id, error: (e as Error).message }))
          return { ok: true, info: `已交给子对话「${child.title}」，它在后台执行` }
        },
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
        // 子对话这一轮结束了：释放认领的文件，查一下和同时在改的兄弟子对话有没有改到同一个文件
        if (entry.task.parentTaskId) {
          claims.release(entry.task.parentTaskId, task.id)
          if (!prewarm) await checkCollisions(entry.task).catch(() => {})
        }
        // 更新摘要并回报父对话（父对话卡片和消息流据此显示进度）
        if (!prewarm && entry.task.parentTaskId) {
          entry.task.summary = lastReply(entry.task)
          await flush(keepTime)
          await reportToParent(entry.task)
        } else await flush(keepTime)
        live.delete(task.id)
        // 这一轮顺利完成：执行中收不下的消息，马上开始新一轮接着处理；失败或暂停时消息留在对话里等用户决定
        if (entry.task.status === 'done' && hasHeld(task.id) && !shuttingDown)
          await followUp(task.id).catch((e) => console.error(`接着处理执行中收到的消息失败：${(e as Error).message}`))
        else if (entry.task.status !== 'done') dropHeld(task.id)
        // 没在等下一轮时按新的选择直接预热，下一条消息不会再交给旧 CLI；
        // PATCH 自己负责的重启不要在这里重复做
        if (switchedRun && !entry.restart && entry.task.status === 'done' && !hasHeld(task.id) && !shuttingDown)
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

  /**
   * 发一条追加要求。msg 为空时取这一轮结束后要接着处理的那条（CLI 执行中收不下的消息）。
   * recorded：这条消息已经在对话里了（执行中收到时就记下了），不要再加一条。
   */
  async function followUp(id: string, msg?: { text: string; attachments: Attachment[]; recorded?: boolean }) {
    const task = await store.get(id)
    if (!task) throw new Error('任务不存在')
    const entry = reserve(task)
    const next = entry.task
    let m = msg
    if (!m) {
      const q = takeHeld(id)
      if (!q) {
        live.delete(id)
        return next
      }
      m = { text: q.text, attachments: q.attachments, recorded: true }
    }
    const expanded = await expandForWorkflow(next, m.text)
    dropEndNotes(next)
    // 附件拷进这个任务的执行目录，交给 Agent 的是这一份（对话里显示、导出仍用原来的那份）
    const placed = await placeInTask(next, m.attachments)
    if (!m.recorded) {
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
    }
    try {
      return await start(entry, withAttachments(expanded || m.text, placed), false, await deps.agents.list())
    } catch (e) {
      live.delete(id)
      throw e
    }
  }

  /**
   * 一条消息交给正在跑的任务，先试能实时送到 CLI 的办法：
   * CLI 正停在等下一句 → 直接交回同一个进程；支持插话 → 插话；
   * 能用面板工具取补充 → 登记给它取；都收不下就记下来，这一轮结束后马上开始新一轮。
   */
  async function deliver(
    entry: Live,
    msg: TaskMessage,
    text: string,
    attachments: Attachment[],
    placed: Attachment[] = attachments,
  ) {
    const task = entry.task
    // 交给 CLI 的是拷进任务目录的那一份（placed）；记进对话的 msg 仍是用户原来的附件，缩略图从附件目录读
    const forCli = { ...msg, attachments: placed }
    const wait = deliverWait(task, forCli)
    if (wait === 'ok') {
      task.updatedAt = new Date().toISOString()
      await store.update(task.id, task)
      return { task, how: 'wait' as const }
    }
    // 等着的还是旧 CLI：让它退出，按输入框里现在的选择重新开始这一轮
    if (wait === 'stale') {
      entry.restart = true
      if (entry.done) await entry.done
      const next = live.get(task.id)
      if (next) {
        if (deliverWait(next.task, forCli) === 'ok') {
          next.task.updatedAt = new Date().toISOString()
          await store.update(task.id, next.task)
          return { task: next.task, how: 'wait' as const }
        }
        return intoTurn(next, msg, text, placed)
      }
      return { task: await followUp(task.id, { text, attachments: placed }), how: 'next' as const }
    }
    return intoTurn(entry, msg, text, placed)
  }

  /** CLI 没在等下一句：插话 → 登记给 read_user_notes → 记下来这一轮结束后接着处理 */
  async function intoTurn(entry: Live, msg: TaskMessage, text: string, attachments: Attachment[]) {
    const task = entry.task
    const how = await steerTask(task, withAttachments(text, attachments), msg)
    if (!how) {
      task.messages.push(msg)
      holdForNextTurn(task.id, msg)
    }
    task.updatedAt = new Date().toISOString()
    await store.update(task.id, task)
    return { task, how: how || ('held' as const) }
  }

  const stopTask = (id: string) => {
    const e = live.get(id)
    if (!e) return
    e.stop = true
    e.abort.abort()
    // 用户主动停止父对话：它名下子对话的进程一起结束，不留孤儿
    void closeChildren(id)
  }

  const routes = new Hono()

  routes.get('/', async (c) => {
    const pid = c.req.query('projectId')
    // 列表只给摘要：侧栏和项目首页不需要消息内容，任务多了也不会越来越慢
    const all = (await store.list()).map((t) => idle(live.get(t.id)?.task ?? t))
    // 子对话在跑时父对话也算执行中：一次算好所有父对话名下的数量，前端不用再为每个任务发请求
    const kids = new Map<string, number>()
    for (const k of all) {
      if (!k.parentTaskId) continue
      const cur = live.get(k.id)?.task ?? k
      if (!cur.working) continue
      kids.set(k.parentTaskId, (kids.get(k.parentTaskId) ?? 0) + 1)
    }
    let list = all.map((t) => {
      const n = kids.get(t.id) ?? 0
      return taskSummary(n ? { ...t, childrenWorking: n } : t)
    })
    // 子对话不进入项目列表：按 parentId 查询时才返回它们
    const parent = c.req.query('parentId')
    list = parent ? list.filter((t) => t.parentTaskId === parent) : list.filter((t) => !t.parentTaskId)
    return c.json(pid ? list.filter((t) => t.projectId === pid) : list)
  })

  // 父对话的子对话卡片：标题、状态、摘要和最近更新时间
  routes.get('/:id/children', async (c) => {
    const parent = await current(c.req.param('id'))
    if (!parent) return bad(c, t('任务不存在'), 404)
    const kids = (await store.list())
      .filter((t) => t.parentTaskId === parent.id)
      .map((t) => {
        const liveTask = live.get(t.id)?.task ?? t
        return {
          id: liveTask.id,
          title: liveTask.title,
          status: liveTask.status,
          summary: liveTask.summary || lastReply(liveTask),
          working: liveTask.working,
          updatedAt: liveTask.updatedAt,
          // 进程还活着（预热、等下一句、正在执行）：列表默认只列这些，不用 status === 'running' 猜
          cliAlive: live.has(liveTask.id),
          // 排序按真正的最近消息时间：updatedAt 也会被改名、看过的标记改动
          lastMessageAt: lastMessageAt(liveTask),
        }
      })
    return c.json(kids)
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
    const body = await c.req.json().catch(() => null)
    const p = NewTaskInput.safeParse(body)
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const input = p.data
    // 没有项目的是 Chat 模式的聊天，只能直接对话
    if (!input.projectId && input.mode !== 'chat') return bad(c, t('缺少项目'))
    const project = input.projectId ? await deps.projects.get(input.projectId) : chatProject('')
    if (!project) return bad(c, t('项目不存在'), 404)
    const agents = await deps.agents.list()
    // 子对话：挂在父对话下，固定用任务 Agent，不能再建下一层
    let parent: Task | undefined
    if (input.parentTaskId) {
      parent = (await store.get(input.parentTaskId)) ?? undefined
      if (!parent) return bad(c, t('父对话不存在'), 404)
      if (parent.parentTaskId) return bad(c, t('子对话不能再创建子对话'))
      if (parent.projectId !== input.projectId) return bad(c, t('子对话必须和父对话在同一个项目'))
      input.mode = 'chat'
      input.rootTaskId = parent.rootTaskId || parent.id
    }
    let workflow: Workflow | undefined
    if (input.mode === 'workflow') {
      workflow = input.workflowId
        ? ((await deps.workflows.get(input.workflowId)) ?? undefined)
        : await projectWorkflow(project)
      if (!workflow) return bad(c, t('项目还没有指定工作流，请选择一个工作流或改用直接对话'))
    } else {
      // 旧界面不传 agentId 时跟着项目的默认对话 Agent；传了空字符串表示不用 Agent 角色
      if (!(body && typeof body === 'object' && 'agentId' in body) && project.defaultAgentId)
        input.agentId = project.defaultAgentId
      if (input.agentId && !agents.some((a) => a.id === input.agentId)) return bad(c, t('请选择对话的 Agent'))
    }
    const lack = chatMissingParams(input, agents)
    if (lack) return bad(c, lack)
    const params = workflow ? paramsOf(project, workflow.id) : {}
    await refreshAgents()
    const snapshot = workflow ? taskSnapshot(workflow, await deps.workflows.list(), params, testOpts(project)) : []
    const draft = {
      ...newTask(
        input,
        workflow,
        new Date().toISOString(),
        randomUUID(),
        snapshot,
        workflow ? exposeSlots(workflow, params) : {},
      ),
      id: randomUUID(),
      testSteps: workflow ? project.testSteps : [],
      platform: workflow ? process.platform : '',
    }
    // 只有顶层对话能选独立分支：子对话一律和父对话用同一个目录，同时改文件靠认领协调
    if (input.isolate && !parent && input.projectId) {
      try {
        draft.worktree = await createWorktree(project.path, draft.id, draft.title)
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    }
    // 工作流的第一条要求也能用「/命令」：展开后交给各节点，对话里仍显示输入的原文
    const expanded = await expandForWorkflow(draft, input.prompt)
    if (expanded && draft.messages[0]) draft.messages[0].prompt = expanded
    // 附件拷进这个任务自己的目录：Agent 用得着相对路径，也不用为工作目录外的文件单独放行。
    // 对话里显示的仍是原来那份（缩略图从附件目录读）
    const placed = await placeInTask(draft, input.attachments ?? [])
    const task = await store.create(draft)
    return c.json(await start(reserve(task), withAttachments(expanded || input.prompt, placed), true, agents), 201)
  })

  routes.post('/:id/messages', async (c) => {
    const id = c.req.param('id')
    const p = FollowUpInput.safeParse(await c.req.json())
    if (!p.success) return bad(c, z.prettifyError(p.error))
    const { text, attachments, interrupt } = p.data
    if ((await current(id))?.imported) return bad(c, READONLY, 409)
    // 「/rule」：父对话发布全局规则，面板自己处理，不发给 CLI
    if (RULE_CMD.test(text.trim())) {
      const r = await ruleCommand(id, text.trim())
      return 'error' in r ? bad(c, r.error) : c.json(r.task)
    }
    let prev = live.get(id)
    if (prev?.task.status === 'running') {
      // 执行中：先试能实时送到 CLI 的办法（等下一句、插话、read_user_notes），
      // 都收不下就把消息记进对话，这一轮结束后马上开始新一轮接着处理
      if (!interrupt) {
        const expanded = await expandForWorkflow(prev.task, text)
        // 附件先拷进任务的执行目录，交给 CLI 的是那一份
        const placed = await placeInTask(prev.task, attachments)
        const msg: TaskMessage = {
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
        return c.json((await deliver(prev, msg, expanded || text, placed)).task)
      }
      // 打断：停下当前这一轮再发
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
    if (task.imported || task.mode !== 'chat') return task
    // 没有会话、刚撤回时下一轮本来就要重开，预热没有意义
    if (!task.sessions[task.agentId] || task.rewind) return task
    // 落盘里还写着「执行中」但内存里没有这个任务：进程早就不在了（面板重启、崩溃），
    // 当成空闲处理，否则重新打开对话时永远不会把 CLI 启动回来
    if (task.status === 'running') {
      task.status = 'stopped'
      task.working = false
      task.awaitingUser = false
      task.prewarming = false
    }
    try {
      const settings = await getSettings()
      const agents = await deps.agents.list()
      // 没选 Agent 的对话（agentId 为空）直接跟默认 CLI 对话，用默认 Agent 的配置预热；
      // CLI、模型按对话里选的那一套，和真正发消息时一致
      const noAgent = !task.agentId
      const found = noAgent ? defaultAgent() : agents.find((a) => a.id === task.agentId)
      if (!found) return task
      if (!noAgent && !found.enabled) return task
      const agent = withTaskModel(noAgent ? { ...found, id: '' } : found, task)
      const run = agentRun(agent, settings)
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

  // 用户打开了这个对话：侧栏的橙点消失，CLI 也可以按宽限期回收了
  routes.post('/:id/seen', async (c) => {
    const id = c.req.param('id')
    const entry = live.get(id)
    const tk = entry?.task ?? (await store.get(id))
    if (!tk) return bad(c, t('任务不存在'), 404)
    if (tk.turnDoneAt && tk.turnSeenAt !== tk.turnDoneAt) {
      tk.turnSeenAt = tk.turnDoneAt
      // 只是记「看过了」，不算任务有更新：列表顺序和更新时间都不动
      if (!entry) await store.update(id, tk, { keepUpdatedAt: true })
      else entry.rev++
      // 看过之后不再因为未读一直留着 CLI：如果已经没人在看，现在就开始算宽限期
      rescheduleIfUnwatched(id)
    }
    return c.json(tk)
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
        const project = task.projectId ? await deps.projects.get(task.projectId) : null
        const params = project ? paramsOf(project, fresh.id) : {}
        await refreshAgents()
        entry.task.workflows = taskSnapshot(
          fresh,
          await deps.workflows.list(),
          params,
          project ? testOpts(project) : { agents: liveAgents },
        )
        entry.task.skillSlots = exposeSlots(fresh, params)
        entry.task.workflowName = fresh.name
        // 测试步骤跟着一起换成项目现在的配置：这里明确是「按最新的工作流继续」
        if (project) {
          entry.task.testSteps = project.testSteps
          entry.task.platform = process.platform
        }
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

  /**
   * 任务的工作目录：项目目录，聊天是它自己的目录。
   * 子对话不建独立分支：父对话在独立分支里时用父的那个目录（旧版本建过独立分支的子对话仍用自己的）
   */
  const taskDir = async (
    tk: Pick<Task, 'worktree' | 'projectId' | 'id'> & { parentTaskId?: string },
  ): Promise<string> => {
    if (isolated(tk)) return tk.worktree!.path
    if (tk.parentTaskId) {
      const parent = live.get(tk.parentTaskId)?.task ?? (await store.get(tk.parentTaskId))
      if (parent && isolated(parent) && existsSync(parent.worktree!.path)) return parent.worktree!.path
    }
    return tk.projectId ? ((await deps.projects.get(tk.projectId))?.path ?? '') : path.join(CHATS_DIR, tk.id)
  }

  /**
   * 合并或丢弃独立分支：只在任务停下时做，免得 Agent 还在往里写。
   * 子对话合并进父对话的分支（父也在独立分支时），否则合并进项目当前的分支。
   */
  async function finishWorktree(c: Context, merge: boolean) {
    const id = c.req.param('id')!
    if (live.has(id)) return bad(c, t('任务正在执行，等它停下后再处理独立分支'), 409)
    const tk = await store.get(id)
    if (!tk) return bad(c, t('任务不存在'), 404)
    if (!isolated(tk)) return bad(c, t('这个任务没有待处理的独立分支'))
    const project = await deps.projects.get(tk.projectId)
    if (!project) return bad(c, t('任务所属的项目已经不存在'))
    const wt = tk.worktree!
    // 父对话也在独立分支、而且目录还在：先并回父的分支，父再并回项目
    const parent = tk.parentTaskId ? await store.get(tk.parentTaskId) : null
    const target =
      parent && isolated(parent) && existsSync(parent.worktree!.path) ? parent.worktree!.path : project.path
    try {
      if (merge) {
        const into = await mergeWorktree(project.path, wt, `Agent 面板：${tk.title}`, target)
        return c.json(await store.update(id, { ...tk, worktree: { ...wt, state: 'merged', note: into } }))
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

  /** 任务的工作目录；导入的任务没有本机目录，读文件时直接拒绝 */
  const readableDir = async (id: string | undefined) => {
    const tk = id ? await current(id) : null
    if (!tk) throw Object.assign(new Error(t('任务不存在')), { status: 404 })
    if (tk.imported) throw Object.assign(new Error(t('导入的任务看不到对方电脑上的文件')), { status: 400 })
    const dir = await taskDir(tk)
    if (!dir) throw Object.assign(new Error(t('任务没有工作目录')), { status: 404 })
    return dir
  }

  /** 拿到任务目录跑一段；读不了时按原因返回错误 */
  const inTaskDir = async (c: Context, run: (dir: string) => Promise<Response>) => {
    try {
      return await run(await readableDir(c.req.param('id')))
    } catch (e) {
      // 路径越界、不是图片这类参数问题按 400；任务或目录找不到的情况自己带上 404
      const status = (e as { status?: 400 | 404 }).status ?? 400
      return bad(c, (e as Error).message, status)
    }
  }

  // 任务目录的根信息：右栏的文件系统，独立分支时是 worktree 目录
  routes.get('/:id/files', (c) => inTaskDir(c, async (dir) => c.json(await listDir(dir))))

  // 任务目录里列一层：展开目录时读它的直接子项
  routes.get('/:id/files/list', (c) =>
    inTaskDir(c, async (dir) =>
      c.json(await listLevel(dir, c.req.query('path') ?? '', { refresh: c.req.query('refresh') === '1' })),
    ),
  )

  // 任务目录里搜索：默认按文件名，content 按内容
  routes.get('/:id/files/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (!q) return c.json({ files: [], truncated: false })
    const name = (c.req.query('mode') ?? 'content') === 'name'
    return inTaskDir(c, async (dir) => c.json(name ? await searchNameInDir(dir, q) : await searchInDir(dir, q)))
  })

  // Agent 输出里提到的文件：读出内容给任务页显示。只能读任务目录里面的文件
  routes.get('/:id/file', async (c) => {
    const want = (c.req.query('path') ?? '').trim()
    if (!want) return bad(c, t('缺少文件路径'))
    return inTaskDir(c, async (dir) => c.json({ ...(await readInDir(dir, want)), dir }))
  })

  // 读到的文件是图片时给页面看图：返回原始内容，只能读任务目录里面的文件
  routes.get('/:id/file/raw', async (c) => {
    const want = (c.req.query('path') ?? '').trim()
    if (!want) return bad(c, t('缺少文件路径'))
    return inTaskDir(c, async (dir) => {
      const { type, buf } = await rawInDir(dir, want)
      return c.body(new Uint8Array(buf), 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=60' })
    })
  })

  // 在系统的文件管理器里打开这个文件所在的文件夹并选中它；传空路径时打开任务目录
  // （只能打开任务目录里面的文件）
  routes.post('/:id/reveal', async (c) => {
    const { path: file } = (await c.req.json().catch(() => ({}))) as { path?: string }
    const want = String(file ?? '').trim()
    return inTaskDir(c, async (dir) => {
      await revealInDir(dir, want)
      return c.json({ ok: true, dir })
    })
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
    // 归档：只拦正在执行这一轮的；CLI 只是活着（等下一句、预热）时照样归档，顺手结束这个进程和它名下的子对话
    if (p.data.archived === true && e) {
      if (e.task.working) return bad(c, t('对话正在执行，等这一轮结束或停止后再归档'), 409)
      if (!cancelWait(id)) stopTask(id)
      else void closeChildren(id)
    }
    const beforeAgentId = cur.agentId
    const agentChanged = p.data.agentId !== undefined && p.data.agentId !== beforeAgentId
    const touchesRun =
      p.data.cli !== undefined || p.data.model !== undefined || p.data.effort !== undefined || agentChanged
    if (touchesRun && cur.mode !== 'chat') return bad(c, t('只有对话任务可以这样做'))
    const settings = touchesRun ? await getSettings() : undefined
    const agents = touchesRun ? await deps.agents.list() : undefined
    if (p.data.agentId && !agents?.some((a) => a.id === p.data.agentId)) return bad(c, t('找不到这个 Agent'))
    const runOf = (t: Task) => {
      const agent = t.agentId ? agents?.find((a) => a.id === t.agentId) : { ...defaultAgent(), id: '' }
      return agent && settings ? agentRun(withTaskModel(agent, t), settings) : undefined
    }
    const beforeRun = runOf(cur)
    // 换 CLI 前记下会话是哪个 CLI 的（以前的任务没记），下一轮才知道要开新会话
    if (p.data.cli !== undefined && !cur.sessionCli && cur.sessions[cur.agentId]) {
      const agent = cur.agentId ? agents?.find((a) => a.id === cur.agentId) : { ...defaultAgent(), id: '' }
      if (agent && settings) cur.sessionCli = agentRun(withTaskModel(agent, cur), settings).cli
    }
    const task = cur
    Object.assign(task, p.data)
    if (agentChanged) {
      // 换了角色后旧会话里是另一个 Agent 的设定：清掉会话，下一轮新开会话并带上之前的对话摘要
      delete task.sessions[task.agentId]
      delete task.sessions[beforeAgentId]
      task.sessionCli = undefined
      const history = task.messages
        .filter((m) => !m.transient && m.text.trim())
        .slice(-20)
        .map((m) => `${m.role === 'user' ? '用户' : 'Agent'}：${m.text.trim().slice(0, 300)}`)
        .join('\n')
      task.rewind = history
        ? { session: '', through: null, latest: false, summary: history }
        : { session: '', through: null, latest: false }
    }
    if (p.data.askUser === false) autoAnswerQuestions(task)
    // 执行中改「提问」：直接把新设置插话给正在跑的 CLI，后续的问题按新设置处理；
    // 关掉时还没回答的问题已经由 autoAnswerQuestions 交给 AI 自己选
    if (p.data.askUser !== undefined && e?.task.working) {
      const on = p.data.askUser
      const msg: TaskMessage = {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text: on ? t('「提问」已打开，后续问题会交给你回答') : t('「提问」已关闭，后续问题由 AI 自己决定'),
        tools: [],
        at: new Date().toISOString(),
      }
      void steerTask(
        task,
        on
          ? '用户打开了「提问」：接下来有问题时用提问工具交给用户回答，不要自己替用户决定。'
          : '用户关闭了「提问」：接下来有问题时自己选最合适的做法，不要再等用户回答。',
        msg,
      ).catch(() => {})
    }
    // 执行中的任务平时按节点落盘，改名这类操作要马上写下去，否则重启后会丢
    await store.update(id, task)
    if (!touchesRun) return c.json(task)
    const afterRun = runOf(task)
    const runChanged =
      agentChanged ||
      (!!beforeRun &&
        !!afterRun &&
        (beforeRun.cli !== afterRun.cli || beforeRun.model !== afterRun.model || beforeRun.effort !== afterRun.effort))
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
      // 换了 CLI/模型后旧进程的上下文不能留：名下子对话的进程一起结束，下次发消息再按新的启动
      await closeChildren(id)
      // 这一轮结束后要处理的消息由收尾的 followUp 用新的选择接着跑，不要在这里和它抢执行位
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
    // 删父对话时把它的子对话一起删掉，不留孤儿
    const kids = (await store.list()).filter((x) => x.parentTaskId === id)
    stopTask(id)
    const task = await store.get(id)
    if (!task || !(await store.remove(id))) return bad(c, t('任务不存在'), 404)
    forgetPresence(id)
    const dropped = [task]
    for (const k of kids) {
      stopTask(k.id)
      await store.remove(k.id)
      forgetPresence(k.id)
      dropped.push(k)
      await dropWorktree(k)
      await rm(path.join(HANDOFF_DIR, k.id), { recursive: true, force: true }).catch(() => {})
    }
    await dropUploads(dropped)
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
    /**
     * 正在执行的任务，以及它正在做的节点（没有节点时是最后一条要求）。
     * 强制更新打断任务前记下来，新版本启动后据此问用户要不要继续
     */
    workingTasks: () =>
      [...live.values()]
        .filter((e) => e.task.working)
        .map((e) => ({
          id: e.task.id,
          doing:
            e.task.steps.find((s) => s.status === 'running')?.title ||
            ([...e.task.messages].reverse().find((m) => m.role === 'user')?.text ?? '')
              .trim()
              .split('\n')[0]
              .slice(0, 60),
        })),
    /** 启动时的迁移做完没有：读「被更新打断的任务」前等它，免得看到还没改过来的 running */
    ready: () => ready,
    /** 按 id 取任务（内存里有的用内存里的）；被更新打断的任务列表用它 */
    get: (id: string) => current(id),
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
