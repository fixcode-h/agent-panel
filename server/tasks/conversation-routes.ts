import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  FollowUpInput,
  PresenceInput,
  NewTaskInput,
  Task,
  type StopReason,
  type TaskMessage,
  type Workflow,
  type TaskSeenResult,
  defaultAgent,
} from '../../shared/schema.ts'
import { blockedStep, taskFlow, taskWorkflows } from '../../shared/flow.ts'
import { taskSnapshot } from '../../shared/builtin/default.ts'
import { exposeSlots } from '../../shared/expose.ts'
import {
  closeFlow,
  dropEndNotes,
  resumeNote,
  newTask,
  taskDeleted,
  withAttachments,
  withTaskModel,
} from '../../shared/task.ts'
import { agentRun } from '../../shared/settings.ts'
import { getCli } from '../../shared/clis.ts'
import { chatMissingParams } from '../../shared/agent-role.ts'
import { childAskDefaultOf, childAskInitial } from '../../shared/child-ask.ts'
import { getSettings } from '../settings.ts'
import { taskLog } from '../task-log.ts'
import { rescheduleIfUnwatched, setViewer, touchPresence } from '../presence.ts'
import type { Live } from './types.ts'
import { createWorktree } from '../exec/worktree.ts'
import { existsSync } from 'node:fs'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { killTree } from '../exec/process.ts'
import { killTaskClis } from '../exec/orphans.ts'
import type { TasksScope } from './scope.ts'
import { PREWARM_PROMPT, RULE_CMD, TaskBusyError } from './helpers.ts'

/**
 * 新建对话、发消息、预热、激活与关闭 Agent、在看 / 已读、结束流程、继续执行（连带拉起一起被打断的子对话）。
 */
export function registerConversationRoutes(s: TasksScope) {
  /**
   * 建一个顶层对话并开始执行。界面上的 POST /tasks 和面板自己发起的（定时计划）共用这一条链路：
   * 校验项目和角色、按项目建独立分支、拷附件、启动执行。
   * 失败时返回原因和状态码，不抛错：定时器要把原因记到计划里给用户看。
   */
  async function createTask(
    input: NewTaskInput,
    raw: unknown,
  ): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
    // 没有项目的是 Chat 模式的聊天，只能直接对话
    if (!input.projectId && input.mode !== 'chat') return { error: t('缺少项目'), status: 400 }
    const project = input.projectId ? await s.deps.projects.get(input.projectId) : s.chatProject('')
    if (!project) return { error: t('项目不存在'), status: 404 }
    const agents = await s.deps.agents.list()
    // 子对话：挂在父对话下，固定用任务 Agent，不能再建下一层
    let parent: Task | undefined
    if (input.parentTaskId) {
      parent = (await s.store.get(input.parentTaskId)) ?? undefined
      if (!parent) return { error: t('父对话不存在'), status: 404 }
      if (parent.parentTaskId) return { error: t('子对话不能再创建子对话'), status: 400 }
      if (parent.projectId !== input.projectId) return { error: t('子对话必须和父对话在同一个项目'), status: 400 }
      input.mode = 'chat'
      input.rootTaskId = parent.rootTaskId || parent.id
      // 新建子对话的「提问」初始值跟着父对话的「子对话也提问」走（父对话关掉提问只管已经建好的，不管之后的）
      input.askUser = childAskInitial(parent)
    }
    // 顶层对话（父对话、普通会话）：之后新建的子对话默认问不问，取设置里的全局默认（界面传了就用界面的）
    if (!parent) input.childAskUser = input.childAskUser ?? childAskDefaultOf(await getSettings())
    let workflow: Workflow | undefined
    if (input.mode === 'workflow') {
      workflow = input.workflowId
        ? ((await s.deps.workflows.get(input.workflowId)) ?? undefined)
        : await s.projectWorkflow(project)
      if (!workflow) return { error: t('项目还没有指定工作流，请选择一个工作流或改用直接对话'), status: 400 }
    } else {
      // 旧界面不传 agentId 时跟着项目的默认对话 Agent；传了空字符串表示不用 Agent 角色
      if (!(raw && typeof raw === 'object' && 'agentId' in raw) && project.defaultAgentId)
        input.agentId = project.defaultAgentId
      if (input.agentId && !agents.some((a) => a.id === input.agentId))
        return { error: t('请选择对话的角色'), status: 400 }
    }
    const lack = chatMissingParams(input, agents)
    if (lack) return { error: lack, status: 400 }
    const params = workflow ? s.paramsOf(project, workflow.id) : {}
    await s.refreshAgents()
    const snapshot = workflow ? taskSnapshot(workflow, await s.deps.workflows.list(), params, s.testOpts(project)) : []
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
    // 这里是顶层对话选的独立分支（子对话由项目设置决定）：只看输入框的「独立分支」按钮，不看角色。
    // 勾了就在创建时建好（用户要求），父对话也一样，它的子对话从这个分支开出、合回这里
    if (input.isolate && !parent && input.projectId) {
      try {
        draft.worktree = await createWorktree(project.path, draft.id, draft.title)
      } catch (e) {
        return { error: (e as Error).message, status: 400 }
      }
    }
    // 工作流的第一条要求也能用「/命令」：展开后交给各节点，对话里仍显示输入的原文
    const expanded = await s.expandForWorkflow(draft, input.prompt)
    if (expanded && draft.messages[0]) draft.messages[0].prompt = expanded
    // 附件：图片拷进这个任务自己的目录（Agent 用得着相对路径），其它文件原样用绝对路径；
    // 对话里显示的仍是原来那份（缩略图从附件目录读）
    const placed = await s.placeInTask(draft, input.attachments ?? [])
    const task = await s.store.create(draft)
    return {
      task: await s.start(s.reserve(task).value, withAttachments(expanded || input.prompt, placed), true, agents),
    }
  }

  s.routes.post('/', async (c) => {
    const body = await c.req.json().catch(() => null)
    const p = NewTaskInput.safeParse(body)
    if (!p.success) return s.bad(c, z.prettifyError(p.error))
    const res = await createTask(p.data, body)
    if ('error' in res) return s.bad(c, res.error, res.status)
    return c.json(res.task, 201)
  })

  s.routes.post('/:id/messages', async (c) => {
    const id = c.req.param('id')
    const p = FollowUpInput.safeParse(await c.req.json())
    if (!p.success) return s.bad(c, z.prettifyError(p.error))
    const { text, attachments, interrupt, messageId } = p.data
    const cur = await s.current(id)
    const liveNow = s.live.get(id)
    taskLog(id, '收到消息', {
      messageId,
      interrupt: interrupt || undefined,
      attachments: attachments.length || undefined,
      text: text.trim().slice(0, 80),
      live: !!liveNow,
      status: liveNow?.task.status ?? cur?.status,
      working: liveNow?.task.working,
      awaitingUser: liveNow?.task.awaitingUser,
      prewarming: liveNow?.task.prewarming || undefined,
    })
    // 页面上发的消息最后有没有记进对话：没记进去时页面会撤掉本地那条，日志里要能看出是在哪一步丢的
    const replied = (how: string, task: Task) => {
      const recorded = !messageId || task.messages.some((m) => m.id === messageId)
      taskLog(id, recorded ? '消息已记下' : '消息没有记进对话', { messageId, how, status: task.status })
      return task
    }
    // 进了回收站的对话和 GET /tasks/:id 一样当不存在：不能再往它里面发消息（否则会被重新拉起来跑一轮）
    if (cur?.deletedAt) return s.bad(c, t('任务不存在'), 404)
    if (cur?.imported) return s.bad(c, s.READONLY, 409)
    // 「/rule」：父对话发布全局规则，面板自己处理，不发给 CLI
    if (RULE_CMD.test(text.trim())) {
      const r = await s.ruleCommand(id, text.trim())
      taskLog(id, '面板命令', { cmd: '/rule', error: 'error' in r ? r.error : undefined })
      return 'error' in r ? s.bad(c, r.error) : c.json(r.task)
    }
    // 用户直接进子对话回复，就当作回答了它挂在父对话里的提问（不打断这次发送）
    await s
      .settleAskFromChild(id, text)
      .catch((e) => log.warn('task', '回答子对话时没能收起父对话的提问卡片', { task: id, error: (e as Error).message }))
    // 用户直接给子对话发消息：父对话计划里挂上等它，做完的状态才会报到父对话并叫起它（不打断这次发送）
    if (cur?.parentTaskId)
      await s.trackUserToChild(cur, text).catch((e) => {
        log.warn('task', '用户直接发给子对话的要求没能登记到父对话', { task: id, error: (e as Error).message })
        s.alertOn(id, 'delivery', t('这条消息没能登记到父对话的计划里，做完后父对话可能收不到状态'))(e)
      })
    let prev = s.runningConv(id)
    if (prev?.task.status === 'running') {
      // 执行中：先试能实时送到 CLI 的办法（等下一句、插话、read_user_notes），
      // 都收不下就把消息记进对话，这一轮结束后马上开始新一轮接着处理
      if (!interrupt) {
        const expanded = await s.expandForWorkflow(prev.task, text)
        // 附件先拷进任务的执行目录，交给 CLI 的是那一份
        const placed = await s.placeInTask(prev.task, attachments)
        const msg: TaskMessage = {
          // 页面先在本地插了一条「待认领」的：沿用它的 id，推送到达时按 id 换成这一份，不会出现两条
          id: messageId ?? randomUUID(),
          role: 'user' as const,
          agentId: '',
          step: '',
          text,
          ...(expanded ? { prompt: expanded } : {}),
          tools: [],
          ...(attachments.length ? { attachments } : {}),
          at: new Date().toISOString(),
        }
        const r = await s.deliver(prev, msg, expanded || text, placed).catch((e: Error) => {
          taskLog(id, '发消息失败', { messageId, error: e })
          throw e
        })
        return c.json(replied(r.how, r.task))
      }
      // 打断：停下当前这一轮再发
      s.stopTask(id, 'supersede')
    }
    // 刚执行完、还在落盘的任务：等它写完再接着跑
    prev = s.live.get(id)
    if (prev) {
      taskLog(id, '等上一轮收尾', { messageId, status: prev.task.status })
      await prev.done
    }
    if (s.live.has(id)) {
      taskLog(id, '拒收：正在执行', { messageId })
      return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    }
    try {
      return c.json(replied('new-turn', await s.followUp(id, { text, attachments, messageId })))
    } catch (e) {
      taskLog(id, '发消息失败', { messageId, error: e as Error })
      // 检查执行位和真正占到之间另一条请求先占了：按「正在执行」返回，不能冒成 500
      if (e instanceof TaskBusyError) return s.bad(c, t('任务正在执行，请等它完成或先停止'), 409)
      throw e
    }
  })

  /**
   * 执行位还占着、但这一轮已经结束（status 已标完 done、收尾还在落盘）时，预热不能直接把它原样返回：
   * 那样拿到的是 done，CLI 根本没启动。还在真跑（执行中 / 停在等下一句 / 正在预热）的才复用，
   * 收尾中的等它释放；等完之后又被新的一轮占住就返回那一份，没有就返回 undefined 走正常启动流程
   */
  async function reusedPrewarmEntry(id: string): Promise<Task | undefined> {
    const entry = s.live.get(id)
    if (!entry) return undefined
    const now = entry.task
    if (now.status === 'running' || now.awaitingUser || now.prewarming) return now
    await entry.done?.catch(() => {})
    return s.live.get(id)?.task
  }

  /**
   * 在后台用 --resume 启动对话的 CLI，让它停在等下一句的工具上。
   * force：用户刚换了 CLI/模型/强度，即使会话属于旧 CLI 也要按新的选择重开，
   * 把之前的对话带过去，下一条消息直接交给新进程。
   */
  async function prewarmChat(task: Task, force = false): Promise<Task> {
    // 执行位收尾中（已经 done）时等它释放，别把没启动的 done 原样交回去
    const reused = await reusedPrewarmEntry(task.id)
    if (reused) return reused
    if (task.imported || task.mode !== 'chat') return task
    // 独立分支的工作区已经被回收（合并完、标记完成）：预热不了，也不自动去建分支，
    // 等用户真发消息时再重建（后台打开对话页面不应该多出一个分支）
    const wt = task.worktree
    if (wt && (wt.state === 'active' || wt.state === 'merged') && !existsSync(wt.path)) return task
    // 没有会话、刚撤回时下一轮本来就要重开，预热没有意义
    if (!task.sessions[task.agentId] || task.rewind) return task
    // 落盘里还写着「执行中」但内存里没有这个任务：进程早就不在了（面板重启、崩溃），
    // 当成空闲处理，否则重新打开对话时永远不会把 CLI 启动回来
    if (task.status === 'running') {
      task.status = 'stopped'
      task.stopReason = 'restart'
      task.working = false
      task.awaitingUser = false
      task.prewarming = false
    }
    let entry: Live | undefined
    try {
      const settings = await getSettings()
      const agents = await s.deps.agents.list()
      // 没选 Agent 的对话（agentId 为空）直接跟默认 CLI 对话，用默认 Agent 的配置预热；
      // CLI、模型按对话里选的那一套，和真正发消息时一致
      const noAgent = !task.agentId
      const found = noAgent ? defaultAgent() : agents.find((a) => a.id === task.agentId)
      if (!found) return task
      if (!noAgent && !found.enabled) return task
      const agent = withTaskModel(noAgent ? { ...found, id: '' } : found, task)
      const run = agentRun(agent, settings)
      const def = getCli(run.cli)
      // 能保活（keepAlive）的对话才值得先启动进程等着：不然预热了也用不上，每轮还是重启
      if (!def?.keepAlive) return task
      // Claude Code、Codex 有自己的协议，不走面板的等待工具
      if (def.rpc?.nativeAsk) return task
      if (!force && task.sessionCli && task.sessionCli !== run.cli) return task
      // 走到这里之前可能又有别的请求占住执行位：真在跑就复用，收尾中就先等它释放
      const again = await reusedPrewarmEntry(task.id)
      if (again) return again
      const got = s.reserve(task)
      entry = got.value
      // 另一个请求已经先占住（真正发消息或另一次预热）：复用它的执行位，不再开第二个 CLI
      if (!got.fresh) return entry.task
      taskLog(task.id, '预热', { cli: run.cli, force: force || undefined })
      return await s.start(entry, PREWARM_PROMPT, false, agents, undefined, false, true)
    } catch (e) {
      taskLog(task.id, '预热失败', { error: e as Error })
      if (entry) s.release(entry)
      log.warn('task', '对话预热失败', { task: task.id, error: (e as Error).message })
      s.alertOn(task.id, 'cli_exit', t('提前启动 Agent 失败：发消息时会再启动一次，仍然失败会在这里报错'))(e)
      return task
    }
  }

  // 打开对话页时调用
  s.routes.post('/:id/prewarm', async (c) => {
    const id = c.req.param('id')
    // 看到 done 就立刻预热的请求会撞在「状态标完、执行位还没释放」的那几毫秒上：
    // 先等它收尾，再按正常流程启动，不要返回一份没启动的 done
    const reused = await reusedPrewarmEntry(id)
    if (reused) return c.json(reused)
    const task = await s.store.get(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    return c.json(await prewarmChat(task))
  })

  /**
   * 对话菜单「激活 Agent」：不发消息，先把这个对话的 CLI 用 --resume 拉起来停在等下一句上（和打开对话页的预热同一条路）。
   * 从侧栏点的时候页面可能没开着、早过了宽限：先当成刚有人看过，不然 CLI 一停到等待就退出了。
   * 不能提前启动的（没有会话、CLI 不支持停在等待上）原样返回，界面按返回的状态告诉用户
   */
  s.routes.post('/:id/agent/activate', async (c) => {
    const id = c.req.param('id')
    const reused = await reusedPrewarmEntry(id)
    if (reused) return c.json(s.withJobs(reused))
    const task = await s.store.get(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    if (task.archived) return s.bad(c, t('归档的对话不能激活，先取消归档'), 409)
    touchPresence(id)
    taskLog(id, '激活 Agent')
    return c.json(s.withJobs(await prewarmChat(task)))
  })

  /**
   * 对话菜单「关闭 Agent」：结束这个对话的 CLI 进程、释放资源，对话和会话都留着，下一条消息按 --resume 续接。
   * 正在执行这一轮的不关（和归档一样）：那是「暂停」的事，关进程会把这一轮掐断。
   * 名下子对话不跟着关：它们有自己的进程，只是父对话这边不再占着 CLI
   */
  s.routes.post('/:id/agent/close', async (c) => {
    const id = c.req.param('id')
    const e = s.live.get(id)
    if (!e && !(await s.getMeta(id))) return s.bad(c, t('任务不存在'), 404)
    if (e?.task.working) return s.bad(c, t('对话正在执行，先暂停这一轮再关闭 Agent'), 409)
    if (e) await s.closeWaiting(id, e)
    // 执行位已经没了、进程登记还在（某条路径漏停、重启前留下的）：按登记结束，界面说关了就真的关了
    if (!s.live.has(id))
      await killTaskClis(id, killTree).catch((err) =>
        log.warn('task', '关闭 Agent 时结束残留进程失败', { task: id, error: (err as Error).message }),
      )
    log.info('task', '用户关闭了对话的 Agent', { task: id })
    taskLog(id, '关闭 Agent')
    const now = await s.current(id)
    if (!now) return s.bad(c, t('任务不存在'), 404)
    return c.json(s.withJobs(now))
  })

  // 对话页还开着：CLI 回复完才能停在等下一句的工具上；切走一分钟内切回来还能接着发
  s.routes.post('/:id/presence', async (c) => {
    const id = c.req.param('id')
    const p = PresenceInput.safeParse(await c.req.json().catch(() => null))
    if (!p.success) return s.bad(c, z.prettifyError(p.error))
    // 只判在不在（下面只动内存里的 viewer）：用 current() 会为一次心跳把几 MB 的对话读一遍再校验
    if (!(await s.getMeta(id))) return s.bad(c, t('任务不存在'), 404)
    setViewer(id, p.data.viewerId, p.data.active)
    return c.body(null, 204)
  })

  // 用户打开了这个对话：侧栏的橙点消失，CLI 也可以按宽限期回收了
  s.routes.post('/:id/seen', async (c) => {
    const id = c.req.param('id')
    const entry = s.live.get(id)
    // 只要「这一轮看到哪」，不读整份对话：以前这里读 2MB、再把 2.4MB 的完整任务回给前端，
    // 前端拿它只做一件事——把本地那份的 turnSeenAt 换成新的
    const tk = entry?.task ?? (await s.getMeta(id))
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (tk.turnDoneAt && tk.turnSeenAt !== tk.turnDoneAt) {
      const turnSeenAt = tk.turnDoneAt
      // 只是记「看过了」，不算任务有更新：列表顺序和更新时间都不动
      if (entry) {
        entry.task.turnSeenAt = turnSeenAt
        entry.rev++
      } else await s.store.updateMeta(id, { turnSeenAt }, { keepUpdatedAt: true })
      // 看过之后不再因为未读一直留着 CLI：如果已经没人在看，现在就开始算宽限期
      rescheduleIfUnwatched(id)
      return c.json({ turnSeenAt } satisfies TaskSeenResult)
    }
    return c.json({ turnSeenAt: tk.turnSeenAt } satisfies TaskSeenResult)
  })

  // 结束工作流：没完成的节点不再执行，之后的要求由主 Agent 直接处理
  s.routes.post('/:id/end-flow', async (c) => {
    const id = c.req.param('id')
    const prev = s.live.get(id)
    if (prev && prev.task.status !== 'running') await prev.done
    if (s.live.has(id)) return s.bad(c, t('任务正在执行，请先停止'), 409)
    const tk = await s.store.get(id)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (tk.imported) return s.bad(c, s.READONLY, 409)
    if (tk.mode !== 'workflow') return s.bad(c, t('只有工作流任务可以结束流程'))
    closeFlow(tk, randomUUID())
    return c.json(await s.store.update(id, tk))
  })

  // 失败或停止后继续：不加新消息，从没完成的节点接着跑；工作流已完成时重做最后一条要求
  s.routes.post('/:id/resume', async (c) => {
    const id = c.req.param('id')
    const prev = s.live.get(id)
    if (prev && prev.task.status !== 'running') await prev.done
    if (s.live.has(id)) return s.bad(c, t('任务正在执行'), 409)
    const task = await s.store.get(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    if (task.imported) return s.bad(c, s.READONLY, 409)
    // 占执行位要在后面的 await 之前：否则两条「继续」请求会各自检查通过、各启动一遍
    const got = s.reserve(task)
    if (!got.fresh) return s.bad(c, t('任务正在执行'), 409)
    const entry = got.value
    const users = task.messages.filter((m) => m.role === 'user' && !m.step)
    try {
      // 停在某个节点结论上的工作流（例如前置检查不通过）也能继续：从那个节点重新检查
      const blocked = !!blockedStep(task, taskFlow(task, taskWorkflows(task, await s.deps.workflows.list()).workflow))
      if (task.status !== 'failed' && task.status !== 'stopped' && !blocked) {
        s.release(entry)
        return s.bad(c, t('只有失败或停止的任务可以继续'), 409)
      }
      // latest：改用现在的工作流（任务创建后工作流改过，想按新的流程接着跑）
      const { latest } = (await c.req.json().catch(() => ({}))) as { latest?: boolean }
      let fresh: Workflow | undefined
      if (latest && task.workflowId) {
        fresh = (await s.deps.workflows.get(task.workflowId)) ?? undefined
        if (!fresh) {
          s.release(entry)
          return s.bad(c, t('工作流已经被删除，只能按任务创建时的工作流继续'))
        }
      }
      dropEndNotes(entry.task)
      if (fresh) {
        const project = task.projectId ? await s.deps.projects.get(task.projectId) : null
        const params = project ? s.paramsOf(project, fresh.id) : {}
        await s.refreshAgents()
        entry.task.workflows = taskSnapshot(
          fresh,
          await s.deps.workflows.list(),
          params,
          project ? s.testOpts(project) : { agents: s.liveAgents },
        )
        entry.task.skillSlots = exposeSlots(fresh, params)
        entry.task.workflowName = fresh.name
        // 测试步骤跟着一起换成项目现在的配置：这里明确是「按最新的工作流继续」
        if (project) {
          entry.task.testSteps = project.testSteps
          entry.task.platform = process.platform
        }
      }
      // 对话：一起被中断的子对话由面板连带拉起来（先拉，父对话的续接提示里才写得清哪些已经在接着做）
      const resumed = task.mode === 'chat' && !task.parentTaskId ? await resumeKids(task.id) : []
      const prompt = resumePrompt(task, users, resumed)
      const agents = await s.deps.agents.list()
      return c.json(await withoutStoppedJobs(entry.task, () => s.start(entry, prompt, false, agents, undefined, true)))
    } catch (e) {
      s.release(entry)
      throw e
    }
  })

  /**
   * 继续执行时交给 CLI 的话：最后一条要求原样再交一遍；对话模式前面写清这是续接、中断时还有什么没跑完（见 resumeNote）。
   * 工作流模式由引擎按节点续接，不加
   */
  function resumePrompt(task: Task, users: TaskMessage[], resumed: string[] = []) {
    const last = users.at(-1)
    const text = withAttachments(last?.prompt || last?.text || '', last?.attachments)
    if (task.mode !== 'chat') return text
    return `${resumeNote(task, resumed)}\n\n原来的要求：\n${text}`
  }

  /**
   * 父对话继续执行时，把和它一起被打断的子对话也拉起来接着做，返回拉起来的标题。
   * 只拉被连带打断的（父对话结束时一起停的、面板重启、卡住重开时停的），用户亲手停的、已经收尾的、在回收站的不拉。
   * 以前继续父对话不管子对话：父对话看子对话没动静，就另建一个子对话重做（用户报过，要求尽量用原来的子对话）
   */
  async function resumeKids(parentId: string): Promise<string[]> {
    const again: StopReason[] = ['parent', 'restart', 'stalled', 'lost']
    const kids = (await s.store.list()).filter(
      (k) =>
        k.parentTaskId === parentId &&
        !taskDeleted(k) &&
        !k.archived &&
        !k.resolved &&
        !k.imported &&
        k.status === 'stopped' &&
        !!k.stopReason &&
        again.includes(k.stopReason) &&
        !s.live.has(k.id),
    )
    const agents = await s.deps.agents.list()
    const titles: string[] = []
    for (const meta of kids) {
      const kid = await s.store.get(meta.id)
      if (!kid) continue
      const got = s.reserve(kid)
      if (!got.fresh) continue
      try {
        dropEndNotes(got.value.task)
        const users = kid.messages.filter((m) => m.role === 'user' && !m.step)
        const prompt = resumePrompt(kid, users)
        await withoutStoppedJobs(got.value.task, () => s.start(got.value, prompt, false, agents, undefined, true))
        titles.push(kid.title)
        log.info('task', '父对话继续执行，连带拉起被打断的子对话', { parent: parentId, task: kid.id })
      } catch (e) {
        s.release(got.value)
        // 起不来要报出来：父对话据此决定另建子对话接手（见 resumeNote 和分派规则）
        log.error('task', '父对话继续执行时子对话没能拉起来', {
          parent: parentId,
          task: kid.id,
          error: (e as Error).message,
        })
        s.alertOn(kid.id, 'panel', t('这个子对话没能开始执行'), 'error')(e)
      }
    }
    return titles
  }

  return { prewarmChat, createTask }
}

/**
 * 被停掉的后台命令已经写进续接说明：交出去就清掉，下次中断只列那时候停的。
 * 没能启动（CLI 没装、目录不在）时放回去，下次继续还要再说一遍
 */
async function withoutStoppedJobs<T>(task: Task, start: () => Promise<T>): Promise<T> {
  const kept = task.stoppedJobs
  task.stoppedJobs = undefined
  try {
    return await start()
  } catch (e) {
    if (kept && !task.stoppedJobs) task.stoppedJobs = kept
    throw e
  }
}
