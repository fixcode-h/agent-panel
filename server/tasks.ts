import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import {
  NewTaskInput,
  Task,
  type Agent,
  type AskKind,
  type Attachment,
  type Project,
  type ProjectCategory,
  type PeerFrom,
  type PeerKind,
  type Workflow,
} from '../shared/schema.ts'
import { type LessonDraft } from './lessons.ts'
import { restartDoing } from './interrupted.ts'
import { entryFlow, topoOrder } from '../shared/flow.ts'
import { taskSnapshot } from '../shared/builtin/default.ts'
import { projectDefaultWorkflow } from '../shared/project-workflow.ts'
import { exposeSlots } from '../shared/expose.ts'
import {
  interruptedTaskIds,
  taskDeleted,
  taskSettled,
  trashLeftDays,
  taskSummary,
  autoArchivePicks,
} from '../shared/task.ts'
import { getSettings } from './settings.ts'
import { cancelWait } from './exec/runner.ts'
import { makeAlert } from '../shared/alerts.ts'
import { forgetPresence, setPresenceBusy, setPresenceIdleHandler, setPresenceUnreadKeeper } from './presence.ts'
import { settleReclaimed } from './exec/reclaim.ts'
import { migrateOnStart } from './tasks/startup.ts'
import { createStateSweep, STATE_SWEEP_MS } from './tasks/state-sweep.ts'
import { lazyScope, type Lister, type Live } from './tasks/types.ts'
import type { TasksScope } from './tasks/scope.ts'
import { placeAttachments, relativeAttachName } from './attachments.ts'
import { CHATS_DIR, HANDOFF_DIR } from './store.ts'
import { createTaskStore } from './task-store.ts'
import { worktreeStatus } from './exec/worktree.ts'
import { mkdir, rm } from 'node:fs/promises'
import { cleanupUploads, removeUploads, uploadDirOf } from './uploads.ts'
import path from 'node:path'
import { log } from './log.ts'
import { suggestTitle, titleInput } from './task-title.ts'
import { t } from '../shared/i18n.ts'
import { subjectLine } from '../shared/peer-message.ts'
import type { AlertKind } from '../shared/schema.ts'
import { createClaims } from './claims.ts'
import { releaseIfSame, reserveOnce } from './slots.ts'
import { killTree } from './exec/process.ts'
import { reapSettledTaskClis } from './exec/orphans.ts'
import { registerFileRoutes } from './tasks/files-routes.ts'
import { createTrash } from './tasks/trash.ts'
import { registerActionRoutes } from './tasks/actions-routes.ts'
import { registerConversationRoutes } from './tasks/conversation-routes.ts'
import { isolated, REAP_GRACE_MS } from './tasks/helpers.ts'
import { registerWorktreeRoutes } from './tasks/worktree-routes.ts'
import { registerReadRoutes } from './tasks/read-routes.ts'
import { registerChildrenRoutes } from './tasks/children-routes.ts'
import { registerProcessRoutes } from './tasks/process-routes.ts'
import { registerListRoutes } from './tasks/list-routes.ts'
import { createIdleAsk } from './tasks/idle-ask.ts'
import { createKeepAlive } from './tasks/keepalive.ts'
import { createRun } from './tasks/run.ts'
import { createAsks } from './tasks/asks.ts'
import { createPeer } from './tasks/peer.ts'
import { createChildren } from './tasks/children.ts'
import { createMerge } from './tasks/merge.ts'
import { createTestRuns } from './tasks/test-runs.ts'
import { createJobs } from './tasks/jobs.ts'
import { createEditWorktree } from './tasks/edit-worktree.ts'
import { createChildMessages } from './tasks/child-messages.ts'

/** 任务接口与执行。执行中的任务放在内存里，按节点落盘，避免流式输出时频繁写文件 */
export function tasksApi(deps: {
  agents: Lister<Agent>
  workflows: Lister<Workflow>
  projects: Lister<Project>
  projectCategories: Lister<ProjectCategory>
  /** 记项目教训（和界面上的「记成教训」共用一个队列） */
  recordLesson?: (projectId: string, draft: LessonDraft) => Promise<{ ok: boolean; info: string }>
  /**
   * 子对话独立分支的 git 查询：测试里换成假的，用来验证「git 很慢时 /children 也不阻塞」；
   * 不传就用真的 worktreeStatus
   */
  worktreeStatus?: typeof worktreeStatus
}) {
  // 搬到 server/tasks/ 的模块经它取闭包里的名字（取值时才读，所以声明顺序不影响；见 server/tasks/scope.ts）
  const scope = lazyScope<TasksScope>({
    PLAN_NUDGE_MS: () => PLAN_NUDGE_MS,
    READONLY: () => READONLY,
    activeChildren: () => activeChildren,
    advanceChildTo: () => advanceChildTo,
    alertOn: () => alertOn,
    allowedPids: () => allowedPids,
    answerChildAsk: () => answerChildAsk,
    applyAskUser: () => applyAskUser,
    applyChildAskUser: () => applyChildAskUser,
    attachOrchestra: () => attachOrchestra,
    background: () => background,
    bad: () => bad,
    beginEdit: () => beginEdit,
    beginInlineEdit: () => beginInlineEdit,
    buildFor: () => buildFor,
    chatProject: () => chatProject,
    chatWorkspace: () => chatWorkspace,
    childActive: () => childActive,
    childMerged: () => childMerged,
    childRequestBuild: () => childRequestBuild,
    childUnmerged: () => childUnmerged,
    childrenRunning: () => childrenRunning,
    claims: () => claims,
    closeWaiting: () => closeWaiting,
    cliChildren: () => cliChildren,
    closeChildren: () => closeChildren,
    completing: () => completing,
    current: () => current,
    deliver: () => deliver,
    deps: () => deps,
    dropUploads: () => dropUploads,
    dropWorktree: () => dropWorktree,
    endBackground: () => endBackground,
    endInlineEdit: () => endInlineEdit,
    enforceKeepAlive: () => enforceKeepAlive,
    ensureChildWorktree: () => ensureChildWorktree,
    expandForWorkflow: () => expandForWorkflow,
    finishChild: () => finishChild,
    followUp: () => followUp,
    forwardSpawn: () => forwardSpawn,
    getMeta: () => getMeta,
    gitGate: () => gitGate,
    idle: () => idle,
    integrate: () => integrate,
    lastReply: () => lastReply,
    live: () => live,
    liveAgents: [() => liveAgents, (v: TasksScope['liveAgents']) => (liveAgents = v)],
    mergeLock: () => mergeLock,
    mergeNudged: () => mergeNudged,
    merging: () => merging,
    messageParent: () => messageParent,
    nameOnce: () => nameOnce,
    noteParent: () => noteParent,
    notePlanInput: () => notePlanInput,
    nudgePlan: () => nudgePlan,
    panelAlert: () => panelAlert,
    paramsOf: () => paramsOf,
    parentRequestBuild: () => parentRequestBuild,
    parentTestStepsOf: () => parentTestStepsOf,
    parentTesting: () => parentTesting,
    parentTests: () => parentTests,
    peerList: () => peerList,
    peerOf: () => peerOf,
    pendingJobs: () => pendingJobs,
    placeInTask: () => placeInTask,
    planKids: () => planKids,
    planNudged: () => planNudged,
    planWorkflow: () => planWorkflow,
    prewarmChat: () => prewarmChat,
    processPanel: () => processPanel,
    projectWorkflow: () => projectWorkflow,
    readableDir: () => readableDir,
    ready: () => ready,
    recordSelfTestRun: () => recordSelfTestRun,
    recordWorktreeError: () => recordWorktreeError,
    recoverParentTests: () => recoverParentTests,
    refreshAgents: () => refreshAgents,
    release: () => release,
    reportKey: () => reportKey,
    reportToParent: () => reportToParent,
    reportedDone: () => reportedDone,
    reportedState: () => reportedState,
    reserve: () => reserve,
    restoreWorktree: () => restoreWorktree,
    routes: () => routes,
    ruleCommand: () => ruleCommand,
    runningConv: () => runningConv,
    scopes: () => scopes,
    sendToChild: () => sendToChild,
    settleAskFromChild: () => settleAskFromChild,
    settleAsks: () => settleAsks,
    settleChildTurn: () => settleChildTurn,
    settleChildWorktree: () => settleChildWorktree,
    shuttingDown: [() => shuttingDown, (v: TasksScope['shuttingDown']) => (shuttingDown = v)],
    start: () => start,
    startChild: () => startChild,
    startParentTests: () => startParentTests,
    startQueue: () => startQueue,
    stopTask: () => stopTask,
    store: () => store,
    stuckAfterNudge: () => stuckAfterNudge,
    submitMerge: () => submitMerge,
    subtreeIdsOf: () => subtreeIdsOf,
    taskAlive: () => taskAlive,
    taskDir: () => taskDir,
    testOpts: () => testOpts,
    trackUserToChild: () => trackUserToChild,
    wakeConv: () => wakeConv,
    wakeTask: () => wakeTask,
    withJobs: () => withJobs,
    withLive: () => withLive,
    workflowCatalog: () => workflowCatalog,
    worktreeHome: () => worktreeHome,
    worktreeStatusOf: () => worktreeStatusOf,
  })

  const store = createTaskStore()
  const worktreeStatusOf = deps.worktreeStatus ?? worktreeStatus
  const live = new Map<string, Live>()

  /**
   * 面板自己处理对话时出的错（消息没送到、上报失败、分支删不掉、预热失败）：除了写日志，
   * 也在这个对话里写一行警告，点开看原因和原始报错。错误不能只留在日志里，用户看不到就以为卡住了
   */
  async function panelAlert(
    taskId: string,
    kind: AlertKind,
    text: string,
    error: unknown,
    level: 'warn' | 'error' = 'warn',
  ) {
    const detail = error instanceof Error ? error.message : String(error ?? '')
    const entry = live.get(taskId)
    const tk = entry?.task ?? (await store.get(taskId).catch(() => null))
    if (!tk || tk.archived) return
    const at = new Date().toISOString()
    tk.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      alert: makeAlert(level, detail, kind),
      at,
    })
    tk.updatedAt = at
    if (entry) entry.rev++
    else await store.update(tk.id, tk).catch(() => {})
  }
  /** 写日志之外也写进对话：catch 里用，自己出错不再往外抛 */
  const alertOn =
    (taskId: string, kind: AlertKind, text: string, level: 'warn' | 'error' = 'warn') =>
    (e: unknown) =>
      void panelAlert(taskId, kind, text, e, level).catch(() => {})
  /** 子对话共用父对话的目录：改文件前的认领，按父对话分组 */
  const claims = createClaims()
  /**
   * 独立分支模式下父对话划给子对话的改文件范围（create_conversation 的 files）。
   * 共用目录下的 files 由 claims 认领；独立分支里不认领，两个子对话可以同时改同一个文件，
   * 各在自己的 worktree 里改、互不影响。这份范围只用来在创建时提示「两边都改了这些文件」，
   * 合并回父对话分支时按 git merge 处理，真冲突会撤回并交回子对话，所以它只是信息、不是限制。
   */
  const scopes = new Map<string, Map<string, { title: string; files: string[] }>>()
  /**
   * 正在启动、还没取到执行位的子对话：childActive 按任务记录判「在不在跑」时要算它（见 childCountsOf）。
   * add 到 reserve 之间没有 await，外部观察不到这一段，所以「父对话名下几个子对话在跑」（childrenRunning）不单独数它
   */
  const startQueue = new Set<string>()
  // 对话页切走后宽限期到了就别让 CLI 一直等下一句了，结束这一轮（宽限时长在设置里改）。
  // 还在运行的对话 presence 先问 keepAliveBusy，不会走到这里；
  // 子对话不跟着父对话失活：它们有自己的进程和状态，做完会自己收尾、结果推回父对话（ADR 0012）
  setPresenceIdleHandler((id) => {
    // 回收：先结束还在等下一句的 CLI，再把「界面还会画成在跑」的任务收口成已停止（见 settleReclaimed）。
    // 只结束进程不落状态的话，任务会一直写着 running / 或做完但计划没做完，列表一直转圈，
    // 而「继续执行」只在 stopped 时出现——用户看到「继续会重新拉起」却没有入口（用户报的现象）。
    // 引擎收尾可能把状态改回 done（这一轮做完了），所以有执行位时要等它收完再看一眼
    cancelWait(id)
    const entry = live.get(id)
    // 有执行位的一律等它收尾完再看：刚 reserve、还在启动（done 还没赋值）的窗口里拿旧快照写回，
    // 会把正在启动的一轮覆盖成已停止；收尾完再判一次，计划没做完的才落静止
    if (entry) {
      if (entry.done) void entry.done.then(() => settleReclaimed(store, id, 'presence')).catch(() => {})
      return
    }
    void settleReclaimed(store, id, 'presence')
  })
  // 这一轮完成但用户还没打开看过（侧栏橙点）的对话不回收：用户回来时还能直接接着说
  setPresenceUnreadKeeper((id) => {
    const tk = live.get(id)?.task
    if (!tk) return false
    return !!tk.turnDoneAt && tk.turnDoneAt !== tk.turnSeenAt
  })
  // 两个时长到达时先问这一句：还在跑的对话不按「离开多久」回收（见 keepAliveBusy）
  setPresenceBusy((id) => keepAliveBusy(id))
  /** 服务正在退出：不再接着处理这一轮结束后要处理的消息 */
  let shuttingDown = false
  /**
   * 同步占住任务的执行位：检查和占住是同一步，避免两次请求在 await 的间隙里各自启动一遍。
   * 已经在执行时返回已有的那一份（fresh 为 false），由调用方决定复用还是返回 409，不能覆盖
   */
  const reserve = (task: Task) =>
    reserveOnce(
      live,
      task.id,
      (): Live => ({ task: structuredClone(task), stop: false, abort: new AbortController(), rev: 0 }),
    )
  /** 只释放自己的执行位：旧的一轮收尾时不能把新的一轮删掉 */
  const release = (entry: Live) => releaseIfSame(live, entry.task.id, entry)

  // 服务重启时，之前没跑完的任务标记为已停止（见 server/tasks/startup.ts）。
  // 对外暴露成 ready：读取「被更新打断的任务」时要等这一步做完，否则还会读到 running
  const ready = migrateOnStart(store)

  /**
   * 自动归档（设置里的 autoArchiveDays，默认关）：启动一分钟后看一次，之后每小时一次。
   * 只改 archived，不动列表时间；归档的对话随时可以取消归档
   */
  async function autoArchive() {
    const { autoArchiveDays } = await getSettings()
    if (!autoArchiveDays) return
    // 回收站里的不算：它们已经不在列表里了，到期会被物理删除
    const all = (await store.list()).filter((x) => !taskDeleted(x))
    const ids = autoArchivePicks(all, autoArchiveDays, Date.now(), (id) => live.has(id) || startQueue.has(id))
    for (const id of ids) {
      if (live.has(id)) continue
      // 和手动归档一样：归档的对话不再接收结果，后台命令一起停掉。只改任务本身，不读写对话文件
      await endBackground(id)
      await store.updateMeta(id, { archived: true }, { keepUpdatedAt: true })
    }
    if (ids.length) log.info('task', '自动归档很久没动的对话', { 天数: autoArchiveDays, 对话: ids.length })
  }
  const archiveTimer = setTimeout(() => {
    void autoArchive().catch((e) => log.warn('task', '自动归档失败', { error: (e as Error).message }))
    setInterval(
      () => void autoArchive().catch((e) => log.warn('task', '自动归档失败', { error: (e as Error).message })),
      3_600_000,
    ).unref()
  }, 60_000)
  archiveTimer.unref()

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
    agentParams: {},
    childIsolation: 'claim',
    isolateDefault: false,
    testSteps: [],
    scaledVerify: true,
    lessons: [],
    wslDistro: '',
    gitPolicy: 'ask',
    initializedAt: '',
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
  /** 旧消息里只存了 `attachments/名字`：清理时按文件名保住上传目录里的那份，不然这些旧消息的图会被删掉 */
  const uploadNames = (t: Task) =>
    new Set(t.messages.flatMap((m) => (m.attachments ?? []).map((a) => relativeAttachName(a.path)).filter(Boolean)))
  /** 删除任务后，删掉只有这些任务在用的附件 */
  async function dropUploads(removed: Task[]) {
    const keep = new Set((await store.list()).flatMap((t) => [...uploadDirs(t)]))
    await removeUploads(removed.flatMap((t) => [...uploadDirs(t)]).filter((d) => !keep.has(d)))
  }

  /**
   * 图片附件拷进任务自己的执行目录，路径换成相对 Agent 的那一份。
   * Chat 的执行目录要先建出来（它本来只在第一次执行时才建）。
   * 拷进来的文件名记在任务上（placedAttachments）：统计 git 改动时排除它们，再次执行时复用同一份。
   */
  async function placeInTask(
    tk: Pick<Task, 'worktree' | 'projectId' | 'id' | 'placedAttachments'>,
    attachments: Attachment[],
  ) {
    if (!attachments.length) return attachments
    const dir = await taskDir(tk)
    if (!dir) return attachments
    if (!tk.projectId && !isolated(tk)) await mkdir(dir, { recursive: true })
    const r = await placeAttachments(dir, attachments, tk.placedAttachments)
    Object.assign(tk.placedAttachments, r.placed)
    return r.attachments
  }

  /**
   * 落盘里还写着「执行中」、内存里却没有这个任务：进程早就不在了（面板重启过、崩溃过）。
   * 按已停止返回，否则页面会一直显示执行中，也不会把 CLI 重新启动回来。
   */
  const idle = (task: Task): Task =>
    task.status === 'running' && !live.has(task.id)
      ? {
          ...task,
          status: 'stopped' as const,
          stopReason: 'restart' as const,
          working: false,
          awaitingUser: false,
          prewarming: false,
        }
      : task

  const current = async (id: string) => {
    const entry = live.get(id)
    if (entry) return entry.task
    const task = await store.get(id)
    return task ? idle(task) : task
  }
  /**
   * 按 id 取任务本身（用量、节点、状态），不读完整对话：执行中的取内存里那份，其余读任务文件。
   * 每秒刷一次的用量统计用它：`current` 会把 `.messages.json` 读进 full 缓存，
   * 一个奔跑中的任务带几个子对话，每秒就把整棵树的消息全读一遍，还会把用户刚看过的任务挤出缓存。
   */
  const getMeta = async (id: string) => {
    const entry = live.get(id)
    if (entry) return entry.task
    const task = await store.getMeta(id)
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
   * 项目级测试步骤和平台：工作流任务把它们写进节点说明的快照；对话执行时按项目当前设置现取
   * （见 shared/test-steps.ts 的 currentTestSteps），这里快照只是任务上的备份。
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

  /**
   * 对话之间收发的消息带上「谁发来的」（见 TaskMessage.peer）：收件方界面画成一行「接收消息」，不当成用户说的话。
   * 名字用发件对话的角色名（统筹、程序），找不到角色时用对话标题
   */
  async function peerOf(
    from: Task,
    rel: PeerFrom['rel'],
    kind: PeerKind,
    subject: string,
    failed = false,
  ): Promise<PeerFrom> {
    const agent = (await deps.agents.list().catch(() => liveAgents)).find((a) => a.id === from.agentId)
    return {
      id: from.id,
      title: from.title,
      name: agent?.name || from.title,
      rel,
      kind,
      subject: subjectLine(subject),
      ...(failed && { failed: true }),
    }
  }

  /** 子对话的摘要：最近一条 Agent 回复的开头 */
  function lastReply(task: Task) {
    const last = [...task.messages].reverse().find((m) => m.role === 'agent' && m.text.trim())
    return last ? last.text.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  }

  /**
   * 顶层对话的 AI 第一次回复后，按对话内容起一个标题换掉从消息里截的那段。只做一次（失败也不再试），
   * 在后台跑，不耽误对话；起好时用户已经改过名就不动
   */
  function nameOnce(task: Task, cli: string) {
    if (!task.autoTitle || task.parentTaskId || task.imported || !titleInput(task)) return
    task.autoTitle = false
    const before = task.title
    const snapshot = { ...task, messages: [...task.messages] }
    void (async () => {
      const title = await suggestTitle(snapshot, cli)
      if (!title) return
      const e = live.get(task.id)
      const cur = e?.task ?? (await store.get(task.id))
      if (!cur || cur.title !== before) return
      cur.title = title.slice(0, 80)
      if (e) e.rev++
      await store.update(task.id, cur)
      log.info('task', '自动起了标题', { task: task.id, title: cur.title })
    })().catch((e) => log.warn('task', '自动起标题失败', (e as Error).message))
  }
  const { beginEdit, ensureChildWorktree, mergeLock, recordWorktreeError, restoreWorktree } = createEditWorktree(scope)
  const { noteParent, notePlanInput, sendToChild, trackUserToChild } = createChildMessages(scope)
  const { background, endBackground, withJobs, settling } = createJobs(scope)
  const {
    buildFor,
    parentTestStepsOf,
    parentTesting,
    parentTests,
    startParentTests,
    recordSelfTestRun,
    recoverParentTests,
  } = createTestRuns(scope)
  const {
    PLAN_NUDGE_MS,
    beginInlineEdit,
    childRequestBuild,
    endInlineEdit,
    finishChild,
    mergeNudged,
    merging,
    parentRequestBuild,
    peerList,
    planNudged,
    stuckAfterNudge,
    submitMerge,
    wakeTask,
    planKids,
    childMerged,
  } = createMerge(scope)

  /** 后台命令还在跑 / 排队：结果推回来还要接着做，不算彻底结束 */
  const pendingJobs = (id: string) =>
    background.list(id).filter((j) => j.state === 'queued' || j.state === 'running').length

  // 定时核对：记录说在做、面板里却没人在做的对话兜底收口，并在对话里说明（见 server/tasks/state-sweep.ts、ADR 0033）
  const stateSweep = createStateSweep({
    store,
    live: (id) => ({
      live: live.has(id),
      queued: startQueue.has(id),
      jobs: pendingJobs(id),
      merging: merging.has(id),
    }),
  })
  let sweepTimer: ReturnType<typeof setInterval> | undefined
  void ready.then(() => {
    if (shuttingDown) return
    sweepTimer = setInterval(() => {
      if (shuttingDown) return
      void stateSweep.sweep().catch((e) => log.warn('task', '定时核对失败', { error: (e as Error).message }))
    }, STATE_SWEEP_MS)
    sweepTimer.unref()
  })
  const {
    activeChildren,
    advanceChildTo,
    childActive,
    childrenRunning,
    cliChildren,
    closeChildren,
    completing,
    nudgePlan,
    reportToParent,
    reportedDone,
    reportedState,
    ruleCommand,
    settleChildTurn,
    startChild,
    withLive,
    settleChildWorktree,
    reportKey,
    integrate,
  } = createChildren(scope)
  const { attachOrchestra, forwardSpawn, messageParent } = createPeer(scope)
  const { answerChildAsk, applyAskUser, applyChildAskUser, runningConv, settleAskFromChild, settleAsks, wakeConv } =
    createAsks(scope)
  const { deliver, expandForWorkflow, followUp, start } = createRun(scope)
  const { armIdleAsk, disarmIdleAsk } = createIdleAsk(scope)
  const {
    allowedPids,
    processPanel,
    stopTask,
    subtreeIdsOf,
    taskAlive,
    keepAliveBusy,
    enforceKeepAlive,
    closeWaiting,
  } = createKeepAlive(scope)

  const routes = new Hono()

  /**
   * 带 ?summary=1 时回的任务换成摘要（和列表一样）：侧栏改名、归档、暂停这些地方只用标题和状态，
   * 原样回完整任务的话改个名也要把整段对话（长对话几 MB 到十几 MB）序列化、传给浏览器。
   * 任务页自己要完整任务，不带这个参数，行为不变
   */
  routes.use('*', async (c, next) => {
    if (c.req.query('summary')) {
      const json = c.json.bind(c)
      const isTask = (x: unknown): x is Task =>
        !!x && typeof x === 'object' && Array.isArray((x as Task).messages) && Array.isArray((x as Task).steps)
      c.json = ((body: unknown, ...rest: unknown[]) =>
        (json as (...a: unknown[]) => Response)(isTask(body) ? taskSummary(body) : body, ...rest)) as typeof c.json
    }
    await next()
  })
  registerListRoutes(scope)
  const { childUnmerged, gitGate } = registerChildrenRoutes(scope)
  registerProcessRoutes(scope)
  registerReadRoutes(scope)
  const { prewarmChat, createTask } = registerConversationRoutes(scope)
  const { dropWorktree, taskDir, worktreeHome } = registerWorktreeRoutes(scope)
  const { readableDir } = registerFileRoutes(scope)
  registerActionRoutes(scope)
  const { purgeTasks } = createTrash(scope)

  // 子对话静默自动询问的扫描：数据准备好之后开始，退出时在 stopAll 里清掉
  void ready.then(() => armIdleAsk()).catch(() => {})

  return {
    routes,
    /**
     * 面板自己新建一个顶层对话（定时计划用）：和 POST /tasks 完全同一条链路，
     * 失败时抛出原因，由调用方记到计划里。
     */
    async startChat(input: NewTaskInput) {
      const res = await createTask(NewTaskInput.parse(input), input)
      if ('error' in res) throw new Error(res.error)
      return res.task
    },
    /**
     * 子对话给父对话发提问 / 收尾建议：引擎里的 message_parent、suggest_next_step 都走它；
     * 「提问」关着时在这里自动交给父对话决定
     */
    async askParent(childId: string, text: string, options: string[] = [], kind: AskKind = 'question') {
      const child = live.get(childId)?.task ?? (await store.get(childId))
      if (!child) throw new Error(t('任务不存在'))
      return messageParent(child, text, true, options, kind)
    },
    /** 所有任务（列表用，只带用户消息）；用量统计按任务里的 turns 聚合 */
    list: () => store.list(),
    /**
     * 这个会话的进程面板（两路占用 + 每行归属）。
     * 会话内存的 AI 分析（server/task-memory.ts）用同一份数据，保证报告和界面上的数字一致
     */
    processPanel: async (id: string) => {
      const tk = await current(id)
      return tk ? processPanel(tk) : null
    },
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
    /**
     * 强制更新要记下哪些任务：正在执行的，以及被打断后还有活要自己干的（`restartUnfinished`：
     * 这一轮被打断、计划没做完），再加上名下还有子对话在跑的父对话——子对话的结果要交回它，
     * 它不在名单里就没人接。只按 working 记会把停在等下一句、计划 12/17 的父对话漏掉：
     * 子对话进了恢复名单被继续，父对话却停在「已中断」等用户手动点（用户报的现象）。
     * 清扫独立目录（`sweepStaleWorktrees`）仍然只看真正在跑的，用 `workingTasks`。
     */
    interruptedTasks: async () => {
      const liveTasks = new Map([...live.values()].map((e) => [e.task.id, e.task]))
      const working = [...liveTasks.values()]
        .filter((tk) => tk.working)
        .map((tk) => ({ id: tk.id, parentTaskId: tk.parentTaskId }))
      // 列表不带完整对话（`store.list()` 只保留用户消息），但 `plans` / `steps` / `stopReason` 都在，
      // 判「计划没做完」不用再 `store.get` 逐个读完整对话文件（长对话几 MB，强制更新时会卡在磁盘上）。
      // 在跑的任务用 live 那份，它比落盘的新
      const all = (await store.list()).map((tk) => liveTasks.get(tk.id) ?? tk)
      // 进了回收站的对话不能再进恢复名单：用户已经把它删了，重启后不能自己跑起来
      const want = new Set(interruptedTaskIds(all, working))
      return all
        .filter((tk) => want.has(tk.id) && !taskDeleted(tk))
        .map((tk) => ({ id: tk.id, doing: restartDoing(tk) }))
    },
    /** 立刻核对一次对话状态（见 createStateSweep）：测试用它，不用等定时器 */
    sweepState: () => stateSweep.sweep(),
    /** 启动时的迁移做完没有：读「被更新打断的任务」前等它，免得看到还没改过来的 running */
    ready: () => ready,
    /** 按 id 取任务（内存里有的用内存里的）；被更新打断的任务列表用它 */
    get: (id: string) => current(id),
    /** 同上，但不读完整对话：用量统计、只用到任务元数据的地方用它 */
    getMeta: (id: string) => getMeta(id),
    /**
     * 只要任务本身、不要对话（用量、状态这类）：执行中的用内存里那份，其余用任务文件里的摘要（只带用户消息）。
     * 不会为了几个数字去读几 MB 的对话文件
     */
    peek: async (id: string) => {
      const e = live.get(id)
      if (e) return e.task
      const head = await store.peek(id)
      return head ? idle(head) : null
    },
    /** 服务退出前停掉所有正在跑的 CLI，免得它们在后台继续改项目 */
    async stopAll() {
      shuttingDown = true
      disarmIdleAsk()
      clearInterval(sweepTimer)
      for (const id of live.keys()) stopTask(id, 'restart')
      // 后台命令的记录只在内存里：退出前停掉，并把发起它们的那一行收口成「被停止」，
      // 不然重启后那一行永远停在「已放到后台」，对话和用户都不知道它没跑完
      const owners = new Set(background.active().map((j) => j.taskId))
      const jobsDone = Promise.all(
        [...owners].map((id) => background.stop(id, '（面板退出时它还没跑完，已停止：需要它的结果就重跑一次）')),
      ).then(() => Promise.allSettled([...settling.values()]))
      return Promise.allSettled([...[...live.values()].map((e) => e.done), jobsDone])
    },
    /** repo：项目目录。项目已经删掉了，要靠它清理任务的独立分支 */
    async removeByProject(projectId: string, repo?: string) {
      const removed = (await store.list()).filter((t) => t.projectId === projectId)
      for (const t of removed) {
        stopTask(t.id, 'archive')
        await background.stop(t.id)
        background.forget(t.id)
        await store.remove(t.id)
        forgetPresence(t.id)
        await dropWorktree(t, repo)
        await rm(path.join(HANDOFF_DIR, t.id), { recursive: true, force: true }).catch(() => {})
      }
      await dropUploads(removed)
    },
    /**
     * 兜底回收：任务已经收口（resolved / 这一轮做完 / 已停下），它登记的 CLI 进程却还活着。
     * 挂在启动后和每小时那一次清理上（见 server/index.ts 的 runCleanup），不另起定时器。
     * 「算不算收口」只用 shared/task.ts 的 taskSettled，进程侧由 orphans.ts 核命令行，不误杀用户自己的 CLI。
     * 返回回收掉的进程（日志里带任务、标题和活了多久），测试用它断言
     */
    async reapSettledClis() {
      const metas = new Map((await store.list()).map((tk) => [tk.id, tk]))
      const settled = async (id: string) => {
        // 在跑的用 live 那份，它比落盘的新（刚置 resolved / 刚停下）
        const tk = live.get(id)?.task ?? metas.get(id)
        // 读不到（刚建、刚删）：这一轮不动，下一轮再看
        return !!tk && taskSettled(tk)
      }
      return reapSettledTaskClis({ settled, kill: killTree, graceMs: REAP_GRACE_MS })
    },
    /** 启动时清理没有任务在用的附件 */
    async cleanupUploads() {
      const all = await store.list()
      await cleanupUploads(new Set(all.flatMap((t) => [...uploadDirs(t)])), {
        keepNames: new Set(all.flatMap((t) => [...uploadNames(t)])),
      })
    },
    /**
     * 回收站过期清理：超过保留期的对话物理删除。挂在启动后和每小时那一次清理上
     * （见 server/index.ts 的 sweepStaleWorktrees），不另起定时器。
     * now 可注入，测试用它造「7 天前删的」。返回真的删掉了几条（日志和测试用）
     */
    async cleanupTrash(now = Date.now()) {
      const all = await store.list()
      const expired = all.filter((t) => !!t.deletedAt && trashLeftDays(t.deletedAt, now) === 0)
      if (!expired.length) return 0
      // 父对话过期的，名下子对话一起删：父对话没了，它们就成了打不开的孤儿
      const ids = new Set(expired.map((t) => t.id))
      const parents = new Set(expired.filter((t) => !t.parentTaskId).map((t) => t.id))
      for (const t of all) if (t.parentTaskId && parents.has(t.parentTaskId)) ids.add(t.id)
      // 要完整对话：附件目录从消息的附件列表里收
      const full = (await Promise.all([...ids].map((id) => store.get(id)))).filter((t): t is Task => !!t)
      // 已删的对话不该还有进程或后台命令；还在收尾的先停掉，不然 Windows 上目录删不掉
      await Promise.all(full.map((tk) => endBackground(tk.id).catch(() => {})))
      await purgeTasks(full)
      log.info('tasks', '回收站过期清理', { removed: full.map((t) => t.id) })
      return full.length
    },
  }
}
