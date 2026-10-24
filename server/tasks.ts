import { coreDefinition, withProjectParams } from '../shared/builtin/core.ts'
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
  type AskKind,
  type Attachment,
  type DeliveryHow,
  type Project,
  type ProjectCategory,
  type PeerFrom,
  type PeerKind,
  type StopReason,
  type TaskMessage,
  type Workflow,
  RequestAnswer,
  defaultAgent,
} from '../shared/schema.ts'
import { readGlobalLessons, type LessonDraft } from './lessons.ts'
import { blockedStep, entryFlow, taskFlow, taskWorkflows, topoOrder } from '../shared/flow.ts'
import { taskSnapshot } from '../shared/builtin/default.ts'
import { projectDefaultWorkflow } from '../shared/project-workflow.ts'
import { exposeSlots } from '../shared/expose.ts'
import {
  advanceChild,
  askOptions,
  beginRun,
  childActivity,
  childActivityText,
  childLastActivity,
  childStartedAt,
  childWait,
  childWaitText,
  childFlowOf,
  childHoldsOf,
  childHoldText,
  childFacts,
  childReport,
  convActive,
  convState,
  convStateText,
  type ConvState,
  helpersWorking,
  closeFlow,
  delegatePrompt,
  dropEndNotes,
  endRun,
  keepAliveBusy as keepAliveBusyOf,
  keepAliveVictims,
  messageStamp,
  pauseStep,
  runRunning,
  trackWait,
  waitDuration,
  idleWaitDuration,
  newTask,
  taskSummary,
  withAttachments,
  withTaskModel,
  type ChildFlowStop,
  type ChildHold,
} from '../shared/task.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { getCli } from '../shared/clis.ts'
import { expandSlash } from './slash.ts'
import { chatMissingParams } from '../shared/agent-role.ts'
import { getSettings } from './settings.ts'
import { detectClis } from './detect.ts'
import { branchCommits, gitChanges, gitFileDiff, gitHead, gitNumstat, gitRevertFile } from './exec/git.ts'
import { type HandoffInput, handoffMissing, handoffTemplate, handoffText, wantsHandoff } from '../shared/handoff.ts'
import { reviewGate, triageText, type TriageItem } from '../shared/review-gate.ts'
import {
  answerRequest,
  autoAnswerQuestions,
  dropRequests,
  cancelWait,
  deliverWait,
  forgetNotes,
  noPushEnv,
  runRealTurn,
  stalledTurn,
  steerTask,
  type RealContext,
} from './exec/runner.ts'
import { stopHelper } from '../shared/engine.ts'
import { makeAlert } from '../shared/alerts.ts'
import { dropHeld, hasHeld, holdForNextTurn, takeHeld } from './exec/delivery.ts'
import {
  forgetPresence,
  isViewing,
  rescheduleIfUnwatched,
  resetIdleCountdown,
  setPresenceBusy,
  setPresenceIdleHandler,
  setPresenceUnreadKeeper,
  setViewer,
} from './presence.ts'
import { placeAttachments, relativeAttachName } from './attachments.ts'
import { CHATS_DIR, HANDOFF_DIR } from './store.ts'
import { createTaskStore } from './task-store.ts'
import {
  abortMerge,
  commitMerge,
  commitWorktree,
  createWorktree,
  ensureWorktree,
  mergeBlocker,
  currentBranch,
  mergeSides,
  mergeSidesText,
  mergeWorktree,
  removeWorktree,
  releaseWorktree,
  worktreeStatus,
  trialMerge,
  checkRepo,
  isBigProject,
} from './exec/worktree.ts'
import { buildSteps, isUeBuildCommand, stepCommand } from '../shared/test-steps.ts'
import { createBackground, jobMs, jobOutput, uiJobs, type BgJob } from './background.ts'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { cleanupUploads, clipTranscript, removeUploads, saveTextUpload, uploadDirOf } from './uploads.ts'
import { listDir, listLevel, rawInDir, readInDir, revealInDir, searchInDir, searchNameInDir } from './files.ts'
import path from 'node:path'
import { log } from './log.ts'
import { suggestTitle, titleInput } from './task-title.ts'
import { t } from '../shared/i18n.ts'
import { subjectLine } from '../shared/peer-message.ts'
import {
  activePlan,
  holdWait,
  markWrapUp,
  openPlan,
  openWork,
  refreshChildWait,
  settleWait,
  waitNote,
  type WrapUpKind,
} from '../shared/plan.ts'
import type { AlertKind, PlanWait, TaskProcess } from '../shared/schema.ts'
import { importTaskTree, parseTaskExport, exportTaskTree, checkExportSize } from '../shared/task-export.ts'
import { runTree } from '../shared/run-usage.ts'
import { childFilesInfo, collisionNotice, createClaims, normClaimPath, scopeOverlaps } from './claims.ts'
import { detectVcs } from './projects-analyze.ts'
import { createGate, createSlotPool, releaseIfSame, reserveOnce } from './slots.ts'
import { childEnv, isProcessAlive, killTree } from './exec/process.ts'
import { trackedClis, untrackCliProcess } from './exec/orphans.ts'
import {
  HISTORY_CAPACITY,
  SAMPLE_INTERVAL_MS,
  buildSuggestPrompt,
  cleanableClis,
  commandSummary,
  loadHistory,
  processSnapshot,
  subtree,
  sumRss,
  summarize,
  trackedStatus,
} from './exec/proc-stats.ts'
import { extractJson } from '../shared/assist.ts'
import { HARD_STOP, invokeCli } from './exec/invoke.ts'
import { tmpdir } from 'node:os'
import { p4Runner, splitChangelists } from './p4-split.ts'

/** 发布全局规则的命令：/rule 或 /rules */
const RULE_CMD = /^\/rules?(?=\s|$)/i

/** 同一个任务已经有执行位时又要发消息：路由按 409 处理，不能当成 500 */
class TaskBusyError extends Error {}

/** 任务还在用自己的独立分支（没合并也没丢弃） */
const isolated = (tk: Pick<Task, 'worktree'>) => tk.worktree?.state === 'active'

/** 项目目录是不是 P4 工作区：每轮都要判断，结果按目录记住（工作区类型不会在运行中变） */
const p4Dirs = new Map<string, Promise<boolean>>()
const isP4 = (dir: string) => {
  let got = p4Dirs.get(dir)
  if (!got) {
    got = detectVcs(dir)
      .then((v) => v.vcs === 'p4')
      .catch(() => false)
    p4Dirs.set(dir, got)
  }
  return got
}

/**
 * 子对话计划最后一步的收尾（见 plan.ts 的 ensureWrapUp）：独立分支（或要改时才开）的合回父对话所在的分支，
 * P4 工作区按文件类型分 changelist；共用父对话目录的 Git 子对话改完就在父对话的分支上，不用收尾
 */
async function childWrapUp(tk: Task, projectPath: string | undefined): Promise<WrapUpKind | undefined> {
  if (!tk.parentTaskId || tk.mode !== 'chat') return undefined
  if (isolated(tk) || tk.wantsWorktree) return 'merge'
  return projectPath && (await isP4(projectPath)) ? 'p4' : undefined
}

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
  /** 记项目教训（和界面上的「记成教训」共用一个队列） */
  recordLesson?: (projectId: string, draft: LessonDraft) => Promise<{ ok: boolean; info: string }>
}) {
  const store = createTaskStore()
  /** rev：执行中每次有变化加一，实时推送靠它判断要不要比较内容 */
  type Live = {
    task: Task
    stop: boolean
    /** 为什么停：只有 'user' 是用户按的暂停，其余是顺带结束的动作（见 shared/schema.ts 的 StopReason） */
    stopReason?: StopReason
    abort: AbortController
    done?: Promise<void>
    rev: number
    /** 换 CLI/模型/强度时由 PATCH 负责重启，收尾不要重复预热 */
    restart?: boolean
    /** 子对话占着的父对话并发名额：停在等下一句（保活）时就让出来，见 releaseSlot */
    freeSlot?: () => void
  }
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
   * 每个项目对话同时执行的子对话数：父对话分派的子对话超过上限（设置里的 childConcurrency）就排队，
   * 前面的做完一轮再开始。用户自己在子对话里发消息不排队。
   * 上限在对话设置里定了就用它，否则跟随全局设置
   */
  async function childLimit(parentId: string) {
    const parent = live.get(parentId)?.task ?? (await store.get(parentId))
    return parent?.childLimit || (await getSettings()).childConcurrency
  }
  const slots = createSlotPool(childLimit)
  const takeSlot = (parentId: string) => slots.take(parentId)
  const queued = (parentId: string) => slots.queued(parentId)
  /**
   * 子对话让出名额。名额管的是「同时在干活的子对话」，回复完停在等下一句的进程不干活：
   * 以前要等进程结束（页面宽限期默认一小时）才让，用户点开看过几个子对话后名额就被占满，
   * 父对话后面派的子对话一直排队，看起来就是卡死了。幂等，多调几次没关系
   */
  const releaseSlot = (entry: Live) => {
    const free = entry.freeSlot
    entry.freeSlot = undefined
    free?.()
  }
  /**
   * 保活中的子对话被交了新消息、又开始干活：补占一个名额，名额满时它照样先做（消息已经交给进程了），
   * 只是后面排队的要等它这一轮做完。拿到名额时这一轮已经结束（又停在等待上或进程退出）就马上还回去
   */
  function holdSlot(entry: Live) {
    const parentId = entry.task.parentTaskId
    if (!parentId || entry.freeSlot) return
    void takeSlot(parentId)
      .then((free) => {
        if (live.get(entry.task.id) !== entry || !entry.task.working || entry.freeSlot) return free()
        entry.freeSlot = free
        void entry.done?.finally(() => releaseSlot(entry))
      })
      .catch(() => {})
  }
  /** 排队等名额、还没开始执行的子对话：父对话判断「有没有子对话在跑」时也算上 */
  const startQueue = new Set<string>()
  // 对话页切走后宽限期到了就别让 CLI 一直等下一句了，结束这一轮（宽限时长在设置里改）。
  // 还在运行的对话 presence 先问 keepAliveBusy，不会走到这里；
  // 子对话不跟着父对话失活：它们有自己的进程和状态，做完会自己收尾、结果推回父对话（ADR 0010）
  setPresenceIdleHandler((id) => cancelWait(id))
  // 这一轮完成但用户还没打开看过（侧栏橙点）的对话不回收：用户回来时还能直接接着说
  setPresenceUnreadKeeper((id) => {
    const tk = live.get(id)?.task
    if (!tk) return false
    return !!tk.turnDoneAt && tk.turnDoneAt !== tk.turnSeenAt
  })
  // 两个时长到达时先问这一句：还在跑的对话不按「离开多久」回收（见 keepAliveBusy）
  setPresenceBusy(keepAliveBusy)
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
        // 面板重启、服务退出打断的，不是用户按的暂停：界面要说清原因
        stopReason: 'restart',
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
        // 「等下一句」和等你处理一样结到最后一次落盘：留着 idleWaitAt，继续执行时会从很久以前接着算
        idleWaitMs: idleWaitDuration(task, Date.parse(task.updatedAt)),
        idleWaitAt: '',
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
              '面板关闭或重启时任务还在执行，已中断。点「继续执行」从中断的节点接着做（会续接那个节点的 Agent 会话）。',
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

  /**
   * 父对话的 CLI 结束了（宽限期到、用户停止、切换 CLI/模型、页面离开后被回收）：
   * 它名下子对话的进程一起结束，不留孤儿。子对话已产出的内容和状态都在，下次发消息会重新启动。
   * 统一在这里做，各个路由只管调用它。
   */
  /**
   * 同一个父对话下的合并 + 编译一个一个来：合并改的是原目录，编译也在那里跑，
   * 排成队就不会互相打断，也相当于一把构建锁
   */
  const mergeChains = new Map<string, Promise<unknown>>()
  const mergeWaiting = new Map<string, number>()
  function mergeLock<T>(rootId: string, fn: () => Promise<T>): Promise<T> {
    const prev = mergeChains.get(rootId) ?? Promise.resolve()
    mergeWaiting.set(rootId, (mergeWaiting.get(rootId) ?? 0) + 1)
    const next = prev
      .catch(() => {})
      .then(fn)
      .finally(() => mergeWaiting.set(rootId, (mergeWaiting.get(rootId) ?? 1) - 1))
    mergeChains.set(
      rootId,
      next.catch(() => {}),
    )
    return next
  }

  /**
   * 独立分支的工作区被回收了（合并完、标记完成、用户手动清理），对话又被继续：
   * 按原来的分支名把工作区建回来再执行，而不是直接报「项目目录不存在」。
   * 分支还在就从它接着改，分支也没了就从现在所在的分支重新开同名分支；合并回哪里也按当前目录重算。
   * 返回空字符串：不用重建或重建好了；返回的是给用户看的失败说明（已经尝试重建、怎么重试）。
   * 没开过独立分支、或者用户主动删除（discarded）的对话不受影响，仍在原目录执行。
   */
  async function restoreWorktree(tk: Task, project: Project): Promise<string> {
    const wt = tk.worktree
    if (!wt || (wt.state !== 'active' && wt.state !== 'merged')) return ''
    if (existsSync(wt.path)) return ''
    // 子对话从父对话现在的目录开、合回那里；顶层对话就是项目目录
    const cwd = (tk.parentTaskId ? await worktreeHome(tk, project) : '') || project.path
    try {
      const r = await ensureWorktree(cwd, wt, tk.id, tk.title)
      tk.worktree = r.worktree
      // 改动从重建这一刻重新算：之前的改动已经合回原分支了
      tk.baseRef = await gitHead(r.worktree.path).catch(() => tk.baseRef)
      tk.baseline = (await gitNumstat(r.worktree.path, tk.baseRef).catch(() => null)) ?? {}
      tk.updatedAt = new Date().toISOString()
      await store.update(tk.id, tk)
      log.info('task', '重建了独立分支的工作区', {
        task: tk.id,
        branch: r.worktree.branch,
        base: r.worktree.baseBranch,
        path: r.worktree.path,
      })
      return ''
    } catch (e) {
      log.warn('task', '重建独立分支的工作区失败', { task: tk.id, error: (e as Error).message })
      return (e as Error).message
    }
  }

  /** 重建失败时按「执行出错」记进对话：错误留得住，用户能照着里面写的重试 */
  function recordWorktreeError(tk: Task, error: string) {
    tk.status = 'failed'
    tk.working = false
    tk.awaitingUser = false
    tk.updatedAt = new Date().toISOString()
    tk.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: t('执行出错：{error}', { error }),
      tools: [],
      error: true,
      alert: makeAlert('error', error, 'worktree'),
      at: new Date().toISOString(),
    })
  }

  /**
   * 「独立 worktree」模式：子对话第一次执行时只记下「要改文件时开独立分支」，真要改时（begin_edit）
   * 才从父对话所在的目录开，只用来隔离改文件；只是查资料、回答问题的子对话不用开。
   * 不是 Git 仓库（P4、没有版本控制）时退回共用目录，靠认领文件避免冲突
   */
  async function ensureChildWorktree(entry: Live, project: Project | null | undefined) {
    const tk = entry.task
    if (!tk.parentTaskId || !project?.path || tk.worktree || tk.wantsWorktree) return
    if (project.childIsolation !== 'worktree') return
    const base = await taskDir({ ...tk, worktree: null })
    try {
      await checkRepo(base)
      entry.task.wantsWorktree = true
      await store.update(tk.id, entry.task)
    } catch (e) {
      log.info('task', '子对话不能开独立分支，共用目录', { task: tk.id, reason: (e as Error).message })
    }
  }

  /** 从对话现在的目录开独立分支（开不了时返回原因）。改动从分支开出的那一刻算起：原目录里别人没提交的改动不算这个对话的 */
  async function openWorktree(tk: Task): Promise<string> {
    const base = await taskDir({ ...tk, worktree: null })
    try {
      tk.worktree = await createWorktree(base, tk.id, tk.title)
    } catch (e) {
      log.warn('task', '开独立分支失败', { task: tk.id, error: (e as Error).message })
      return (e as Error).message
    }
    tk.wantsWorktree = false
    tk.baseRef = await gitHead(tk.worktree.path).catch(() => tk.baseRef)
    tk.baseline = (await gitNumstat(tk.worktree.path, tk.baseRef).catch(() => null)) ?? {}
    return ''
  }

  /** 还在执行或排队等着执行的子对话 */
  async function busyChildren(parentId: string) {
    return (await store.list())
      .filter((x) => x.parentTaskId === parentId)
      .map((x) => live.get(x.id)?.task ?? x)
      .filter((x) => x.working || startQueue.has(x.id))
  }

  /** 对话要改文件了：从它现在的目录开独立分支，这一轮结束后在新目录里开新会话接着做 */
  async function beginEdit(entry: Live, changed: (f?: boolean) => void): Promise<{ ok: boolean; info: string }> {
    const tk = entry.task
    if (isolated(tk)) return { ok: true, info: `已经在独立分支 ${tk.worktree!.branch} 里，直接改` }
    // 父对话的目录是子对话合并、编译的地方：有子对话在跑时父对话自己不改，交给子对话
    const busy = await busyChildren(tk.id)
    if (busy.length)
      return {
        ok: false,
        info: `现在有子对话在执行（${busy.map((k) => `「${k.title}」`).join('、')}），你不能自己改文件：用 send_to_conversation 交给相关的子对话，或者 create_conversation 新建一个。`,
      }
    const err = await openWorktree(tk)
    if (err) return { ok: false, info: `开独立分支失败：${err}\n先不要改文件，把情况告诉用户。` }
    const wt = tk.worktree!
    // 对话里不另记居中提示：begin_edit 这次工具调用本身显示成「开独立分支 分支名」，AI 的回复不被截断。
    // 这一轮结束后马上接着做：这里只登记交给新会话的要求（不记进对话）
    holdForNextTurn(tk.id, {
      id: randomUUID(),
      role: 'user',
      agentId: '',
      step: '',
      text: `（面板）已经开好独立分支 ${wt.branch}，你现在在它的目录里。接着刚才的任务开始修改；已经查清楚的不用重查。`,
      tools: [],
      at: new Date().toISOString(),
    })
    changed(true)
    log.info('task', '对话开了独立分支', { task: tk.id, branch: wt.branch })
    return {
      ok: true,
      info: `已开独立分支 ${wt.branch}（目录 ${wt.path}）。现在用一两句写下已经查到的情况和打算怎么改，然后马上结束这一轮，不要在当前目录改任何文件；面板会在独立分支的目录里开新会话，带上这段对话接着做。`,
    }
  }

  /**
   * 父对话的聊天里记一条系统消息并放进收件箱：它正在执行就实时交给它。
   * settle：父对话计划里有步骤在等这个子对话时，按结果标完成或退回进行中，并马上让父对话处理（空闲就开一轮），不放进收件箱干等
   * onlyIfWaiting：只有计划里真的在等它时才说一声。子对话每跑完一轮都走这里收口，没在等它时不能往父对话里刷消息
   */
  async function noteParent(
    parentId: string,
    from: Task,
    body: string,
    inboxText = body,
    settle?: { kind: PlanWait['kind']; ref: string; ok: boolean; onlyIfWaiting?: boolean },
    /** 子对话的状态上报：带上是谁、什么状态（行右边写状态，点开能跳到子对话） */
    child?: { id: string; title: string; state: ConvState },
    /** 发件对话：父对话里画成一行「接收消息」 */
    peer?: PeerFrom,
    /** 停下时独立分支里还有没提交的改动：父对话里那一行直接写几个文件、目录在哪，并给「继续」 */
    worktree?: TaskMessage['worktree'],
  ) {
    const parent = live.get(parentId)?.task ?? (await store.get(parentId))
    if (!parent) return
    const hit = settle ? settleWait(parent, settle.kind, settle.ref, settle.ok) : []
    if (settle?.onlyIfWaiting && !hit.length) return
    const text = waitNote(hit) + body
    if (hit.length) {
      const entry = live.get(parent.id)
      parent.updatedAt = new Date().toISOString()
      if (entry) entry.rev++
      await store.update(parent.id, parent).catch(() => {})
      try {
        if (entry?.task.status === 'running') {
          await deliver(
            entry,
            {
              id: randomUUID(),
              role: 'system',
              agentId: '',
              step: '',
              text,
              tools: [],
              panel: 'child',
              ...(child && { child }),
              ...(peer && { peer }),
              ...(worktree && { worktree }),
              at: new Date().toISOString(),
            },
            text,
            [],
          )
        } else await followUp(parent.id, { text, attachments: [], panel: 'child', child, peer, worktree })
        return
      } catch (e) {
        // 父对话这会儿被别的操作占着：退回收件箱，它下一轮开始时一起处理
        log.warn('task', '计划步骤等的结果没能马上交给父对话', { task: parent.id, error: (e as Error).message })
        alertOn(parent.id, 'delivery', t('子对话的结果没能马上交给这个对话，已放进收件箱，下一轮会处理'))(e)
      }
    }
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      // 父对话里画成一行「接收消息」（像一次工具调用），点开看全文
      panel: 'child',
      ...(child && { child }),
      ...(peer && { peer }),
      ...(worktree && { worktree }),
      at: new Date().toISOString(),
    }
    // 父对话正在执行：实时交给它；交不了的记进收件箱，父对话下一轮开始时一起处理
    const entry = live.get(parent.id)
    const how = entry?.task.working ? await steerTask(entry.task, text, msg).catch(() => false) : false
    // 写进「现在」的那一份：上面读的是磁盘上的旧对象，等待期间父对话可能已经开始执行（执行器拿的是一份拷贝），
    // 再往旧对象里写、拿旧对象落盘，收件箱这条会被执行器下一次落盘盖掉，父对话永远收不到这个子对话的回报
    const target = live.get(parent.id)?.task ?? parent
    if (!how) {
      target.messages.push(msg)
      target.inbox.push({ from: from.id, title: from.title, text: inboxText, at: msg.at })
    }
    target.updatedAt = new Date().toISOString()
    const now = live.get(parent.id)
    if (now) now.rev++
    // 父对话空闲时也要马上落盘，否则页面刷新后看不到子对话的回报
    await store
      .update(parent.id, target)
      .catch((e) => log.warn('task', '回报父对话失败', { error: (e as Error).message }))
  }

  /**
   * 把一条消息交给子对话：它正在执行就实时送达，空闲就占一个并发名额开新的一轮。
   * 父对话的 send_to_conversation 和面板自己推的编译结果都走这里
   */
  async function sendToChild(
    parentId: string,
    id: string,
    message: string,
    /** 面板自己推的结果（后台命令、合并编译）：对话里显示成 AI 回复里的一行，不是用户消息 */
    panel?: TaskMessage['panel'],
    /**
     * 父对话发来的是哪一类（交代任务、回答、收尾结果、编译结果）：子对话里画成「接收消息」，不当成用户说的话。
     * 不给时是面板自己的消息（后台命令结果、催合并），照旧画成面板的一行
     */
    kind?: PeerKind,
    failed = false,
  ): Promise<{ ok: boolean; info: string }> {
    const child = live.get(id)?.task ?? (await store.get(id))
    if (!child || child.parentTaskId !== parentId) return { ok: false, info: '找不到这个子对话' }
    if (child.imported) return { ok: false, info: READONLY }
    const parent = kind ? (live.get(parentId)?.task ?? (await store.get(parentId))) : undefined
    // 回答是「用户的决定：」换行再写答案：标题里接成一行
    const subject = kind === 'answer' ? message.replace(/：\n/, '：') : message
    const peer = parent && kind ? await peerOf(parent, 'parent', kind, subject, failed) : undefined
    const running = live.get(id)
    if (running?.task.status === 'running') {
      // 和人工输入走同一套投递：能交给 CLI 就马上实时送达，交不出去就等这一轮结束后接着处理
      const msg: TaskMessage = {
        id: randomUUID(),
        role: panel ? 'system' : 'user',
        agentId: '',
        step: '',
        text: message,
        tools: [],
        ...(panel ? { panel } : {}),
        ...(peer && { peer }),
        at: new Date().toISOString(),
      }
      const r = await deliver(running, msg, message, [])
      // 停在等下一句的子对话被唤醒、开始干活：它的名额在停下时让出去了，这里补上
      if (r.how === 'wait') holdSlot(running)
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
      const free = await takeSlot(parentId)
      try {
        try {
          await followUp(id, { text: message, attachments: [], panel, peer })
          const cur = live.get(id)
          if (cur) cur.freeSlot = free
        } catch (e) {
          // 上一轮刚结束、还在收尾（回报父对话、写盘）时执行位还占着：记进对话，登记成下一轮要处理的，
          // 收尾那边会接着开新一轮；收尾已经过了那一步就由这里补开，消息不能丢
          const cur = live.get(id)
          if (!(e instanceof TaskBusyError) || !cur) throw e
          const msg: TaskMessage = {
            id: randomUUID(),
            role: panel ? 'system' : 'user',
            agentId: '',
            step: '',
            text: message,
            tools: [],
            ...(panel ? { panel } : {}),
            ...(peer && { peer }),
            at: new Date().toISOString(),
          }
          cur.task.messages.push(msg)
          holdForNextTurn(id, msg)
          cur.rev++
          await store.update(id, cur.task)
          await cur.done?.catch(() => {})
          if (hasHeld(id) && !live.has(id)) await followUp(id)
        }
        await live.get(id)?.done
      } finally {
        free()
      }
    })().catch((e) => {
      log.error('task', '子对话执行出错', { task: id, error: (e as Error).message })
      alertOn(id, 'panel', t('执行这个子对话时出错'), 'error')(e)
    })
    return { ok: true, info: `已交给子对话「${child.title}」，它在后台执行` }
  }

  /**
   * 面板替后台命令说的话推回发起的对话：子对话按父对话投递的路子走（正在跑就实时送达，空闲就占名额开新一轮），
   * 顶层对话正在跑就实时送达，空闲就直接开新的一轮接着干。送不到要留下记录，不能悄悄丢
   */
  async function pushJobNote(tk: Task, job: BgJob, text: string) {
    if (tk.parentTaskId) {
      const r = await sendToChild(tk.parentTaskId, tk.id, text, 'background')
      if (!r.ok) throw new Error(r.info)
      log.info('background', '后台命令的消息已交给子对话', { task: tk.id, job: job.id, how: r.info })
      return
    }
    const running = live.get(tk.id)
    if (running?.task.status === 'running') {
      const msg: TaskMessage = {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text,
        tools: [],
        panel: 'background',
        at: new Date().toISOString(),
      }
      const r = await deliver(running, msg, text, [])
      log.info('background', '后台命令的消息已交给对话', { task: tk.id, job: job.id, how: r.how })
    } else {
      await followUp(tk.id, { text, attachments: [], panel: 'background' })
      log.info('background', '后台命令的消息开了新的一轮', { task: tk.id, job: job.id })
    }
  }

  /**
   * 后台命令置终态：对话里发起它的那一行（run_background）换成真实的用时和结果。
   * 交出去那一刻 CLI 拿到的是「已放到后台」，那一行记的是 0.09 秒「完成」；不改的话命令跑完了界面也看不出结果
   */
  async function settleJobTool(job: BgJob) {
    const stored = live.has(job.taskId) ? null : await store.get(job.taskId)
    // 读盘期间对话可能开了新的一轮：有执行中的那份就改那份，别拿读出来的旧副本写回去
    const entry = live.get(job.taskId)
    const tk = entry?.task ?? stored
    if (!tk) return
    const mark = `已放到后台（编号 ${job.id}）`
    // 申请的编译（request_build）一次排几条：每条跑完把结果接在那一行后面，有一条失败那一行就算失败
    const build = new RegExp(`^已申请编译（[^）]*），编号 [0-9a-f、]*${job.id}`)
    for (let i = tk.messages.length - 1; i >= 0; i--) {
      const hit = tk.messages[i].tools.find((x) => build.test(x.output ?? ''))
      if (hit) {
        hit.output = `${hit.output}\n\n${jobOutput(job)}`
        if (job.state !== 'done') hit.failed = true
        tk.updatedAt = new Date().toISOString()
        if (entry) entry.rev++
        await store.update(tk.id, tk)
        return
      }
      const tool = tk.messages[i].tools.find((x) => x.output?.startsWith(mark))
      if (!tool) continue
      tool.output = `${mark}\n\n${jobOutput(job)}`
      tool.ms = jobMs(job)
      tool.failed = job.state === 'done' ? undefined : true
      tool.detail = job.state === 'done' ? '' : job.state === 'stopped' ? '已停止' : `退出码 ${job.code ?? '无'}`
      tk.updatedAt = new Date().toISOString()
      if (entry) entry.rev++
      await store.update(tk.id, tk)
      return
    }
  }

  /**
   * 正在把结果写回工具行的（后台命令编号 → 写回的过程）：推结果前、面板退出前都要等它写完。
   * 没在执行的对话是读出来改完再整份写回的，和推结果开的新一轮并发写会把新消息盖掉
   */
  const settling = new Map<string, Promise<void>>()
  const background = createBackground(
    (job, result) => {
      void (async () => {
        await settling.get(job.id)
        const tk = live.get(job.taskId)?.task ?? (await store.get(job.taskId))
        if (!tk || tk.archived) {
          log.warn('background', '后台命令跑完了，但发起的对话已经不在或已归档，结果没有推回', {
            task: job.taskId,
            job: job.id,
          })
          return
        }
        // 计划里有步骤在等这条命令：成功标完成、失败退回进行中，推回的结果点名先处理这一步
        const hit = settleWait(tk, 'background', job.id, job.state === 'done')
        // 子任务起的命令：结果照常推回这个对话，但要写清是哪个子任务起的，否则父对话看到一条命令不知道来源
        const owner = job.step ? tk.steps.find((s) => s.id === job.step && s.slot === 'sub') : undefined
        const from = owner ? t('这条后台命令是子任务「{title}」起的。\n', { title: owner.title }) : ''
        const text = waitNote(hit) + from + result
        if (hit.length) {
          const entry = live.get(tk.id)
          if (entry) entry.rev++
          else await store.update(tk.id, tk)
        }
        // 父对话替子对话申请的编译：结果直接推给申请的子对话（它们靠这个结果判断能不能请求收尾）
        const forward = buildFor.get(job.id)
        if (forward) {
          buildFor.delete(job.id)
          for (const kid of forward.children)
            await sendToChild(
              forward.parent,
              kid,
              `【父对话编译结果】${result}`,
              'build',
              'build',
              /跑完了：失败|被停止了/.test(result),
            ).catch((e) => {
              log.warn('task', '编译结果推给子对话失败', { task: kid, error: (e as Error).message })
              alertOn(kid, 'delivery', t('父对话的编译结果没能交给这个对话'), 'error')(e)
            })
        }
        // 结果交给 CLI，但不是用户说的话：记成面板消息，对话里显示成 AI 回复里的一行
        try {
          await pushJobNote(tk, job, text)
        } catch (e) {
          // 第一次没送到（刚好在收尾、执行位被占）：等一下再送一次，还不行就记进对话、留给下一轮，不能丢
          log.warn('background', '后台命令结果推回对话失败，稍后重试', {
            task: tk.id,
            job: job.id,
            error: (e as Error).message,
          })
          await new Promise((r) => setTimeout(r, 3000))
          const cur = live.get(tk.id)?.task ?? (await store.get(tk.id))
          if (!cur) return
          await pushJobNote(cur, job, text).catch(async (err) => {
            log.error('background', '后台命令结果两次都没推回对话，记进对话留给下一轮', {
              task: tk.id,
              job: job.id,
              error: (err as Error).message,
            })
            const msg: TaskMessage = {
              id: randomUUID(),
              role: 'system',
              agentId: '',
              step: '',
              text,
              tools: [],
              panel: 'background',
              at: new Date().toISOString(),
            }
            const entry = live.get(cur.id)
            cur.messages.push(msg)
            holdForNextTurn(cur.id, msg)
            cur.messages.push({
              id: randomUUID(),
              role: 'system',
              agentId: '',
              step: '',
              text: t('后台命令的结果两次都没能交给 CLI，已经记在对话里，下一轮会处理'),
              tools: [],
              alert: makeAlert('warn', (err as Error).message, 'delivery'),
              at: new Date().toISOString(),
            })
            if (entry) entry.rev++
            await store.update(cur.id, cur)
          })
        }
        // 结果推回去会开新一轮；开不起来时（已停止、已经合并好的）就在这里再试一次回收独立分支
        if (tk.parentTaskId) void settleChildWorktree(tk.id)
      })().catch((e) => {
        log.warn('task', '后台命令结果推回对话失败', { task: job.taskId, error: (e as Error).message })
        alertOn(job.taskId, 'delivery', t('后台命令的结果没能推回这个对话'), 'error')(e)
      })
    },
    {
      onSettle: (job) => {
        const p = settleJobTool(job)
          .catch((e) => {
            log.warn('background', '更新后台命令那一行失败', { task: job.taskId, error: (e as Error).message })
            alertOn(job.taskId, 'panel', t('后台命令跑完了，但没能更新它那一行的结果'))(e)
          })
          .finally(() => settling.get(job.id) === p && settling.delete(job.id))
        settling.set(job.id, p)
      },
      onNotice: (job, text) =>
        void (async () => {
          const tk = live.get(job.taskId)?.task ?? (await store.get(job.taskId))
          if (tk && !tk.archived) await pushJobNote(tk, job, text)
        })().catch((e) => {
          log.warn('background', '提醒对话后台命令没输出失败', { task: job.taskId, error: (e as Error).message })
          alertOn(job.taskId, 'delivery', t('后台命令的提醒没能交给这个对话'))(e)
        }),
      // 同时跑几条在设置里改，改完下一条排名额时就按新的算
      maxRunning: async () => (await getSettings()).backgroundLimit,
    },
  )

  // 上次退出时还没结束的后台命令记录（只在同一个进程里中断时才会留到这时）：不再算「还在跑」，
  // 否则「彻底完成」和合并门禁会一直等一个永远不会来的结束
  void ready.then(() => background.recover()).catch(() => {})

  /** 发给界面的任务带上还在跑、排队的后台命令（不存盘：进程重启后这些命令也没了） */
  /**
   * 带上还在跑的后台命令。没有也写成空数组：界面靠「有没有这个字段」分辨这份任务是完整推送（带运行时字段）
   * 还是别的接口顺手返回的（没带），后者不能把列表和标题栏的转圈清掉（见 web/src/lib/live-fields.ts）
   */
  const withJobs = (task: Task): Task => ({ ...task, jobs: uiJobs(background.list(task.id)) })

  /**
   * 结束对话的后台命令，连同它名下子对话的：对话停止、归档、删除时调用。
   * CLI 因为页面切走被回收、换 CLI 重启时不调用，那时对话还在，结果推回会接着开一轮
   */
  async function endBackground(id: string) {
    const kids = (await store.list()).filter((x) => x.parentTaskId === id)
    await Promise.all([background.stop(id), ...kids.map((k) => endBackground(k.id))])
  }

  /** 父对话替子对话申请的编译（后台命令编号 → 申请的子对话）：结果出来时也推给它们 */
  const buildFor = new Map<string, { parent: string; children: string[] }>()

  /** 父对话正在合并的子对话：这一轮结束时不催它合并，父对话等它的计划步骤也留给合并结果收口 */
  const merging = new Set<string>()
  /** 这一轮结束时已经催过「请父对话收尾」的子对话：再结束还没请就照常上报父对话，不反复催 */
  const mergeNudged = new Set<string>()

  /**
   * 子对话只剩合回时请父对话收尾（ADR 0005）：子对话这边能做的都做完了——计划除了合回都做完、
   * 后台命令都结束、没有等用户 / 父对话回答的提问、编译测试在自己的分支里跑通（tests 写明）。
   * 面板先把现在的改动提交到它的分支，记下收尾请求，计划最后一步标「等待中」，再把请求交给父对话马上处理；
   * 合并、改计划、删分支都由父对话调用 finish_child 发起（面板做 git 操作，父对话决定什么时候收）。
   * 合并就是验收：所以测试必须在这之前、在子对话自己的分支里做完
   */
  async function submitMerge(
    childId: string,
    note: string,
    tests: string,
    /** UE 项目：合回去后父对话要接着编译（独立分支里编不了 UE，见 ADR 0004） */
    build = false,
    /** 交接要点（见 ADR 0007）：以后再被叫醒、上下文又大时只带这份摘要 */
    handoff: HandoffInput = {},
    /** 对最近一次评审每条高级、中级意见的处置（见 ADR 0009）：门禁按它放行，原样交给父对话验收 */
    triage: TriageItem[] = [],
  ): Promise<{ ok: boolean; info: string }> {
    const entry = live.get(childId)
    const tk = entry?.task ?? (await store.get(childId))
    if (!tk?.parentTaskId) return { ok: false, info: '只有子对话能请父对话收尾' }
    if (!isolated(tk)) return { ok: false, info: '你没有独立分支，改动已经在原目录里，不用合并' }
    // 合并就是验收：没写跑了什么就不收，免得没验证的改动进了父对话的分支
    if (!tests)
      return {
        ok: false,
        info: '没有请求收尾：tests 里写上你在独立分支里跑了哪些编译、测试和结果。没跑通就先修好再调用；这次确实不需要测试（只改了文档、注释）时写明原因。',
      }
    // 后台还在跑的命令多半就是测试：没跑完就不算跑通，合进去后回收分支还会把它掐掉
    const pending = background.list(childId).filter((j) => j.state === 'queued' || j.state === 'running')
    if (pending.length)
      return {
        ok: false,
        info: `没有请求收尾：后台还有命令没跑完（${pending.map((j) => `「${j.name}」`).join('、')}）。等结果推回来、确认通过后再调用 submit_merge。`,
      }
    if (tk.requests.length || tk.parentAsks?.length)
      return {
        ok: false,
        info: '没有请求收尾：还有等用户或父对话回答的提问。等回答回来、按回答处理完再调用 submit_merge。',
      }
    const left = openWork(tk)
    if (left.length)
      return {
        ok: false,
        info: `没有请求收尾：计划还有步骤没做完（${left
          .slice(0, 5)
          .map((x) => `${x.id}「${x.title}」`)
          .join('、')}）。做完并用 set_plan 标完成；确实不做的从计划里删掉并说明原因，再调用 submit_merge。`,
      }
    // 合回前必须先评审：收尾流程是 改完 → 快速检查 → 评审（计划里的独立步骤） → 按意见改 → 完整测试 → submit_merge，
    // 评审就是一次普通的 spawn_agents，结论从它的输出里读（见 shared/review-gate.ts）。
    // 子任务是按 id 或名字找角色的：用户自己建了同名的「评审」时，派出去的可能是那个，所以名字也认
    const reviewerName = coreDefinition('reviewer').agent.name
    // 读不到角色列表时单独说明：兜底成空数组会让门禁报「还没有真的派过评审」，把模型引向重复派评审
    const known = await deps.agents.list().catch(() => null)
    if (!known) return { ok: false, info: '没有请求收尾：读取角色列表失败，稍后再试一次。' }
    const review = reviewGate(
      tk.steps,
      (id) => known.some((a) => a.id === id && (a.origin === 'builtin:reviewer' || a.name === reviewerName)),
      activePlan(tk)?.steps ?? [],
      triage,
    )
    if (!review.ok) return review
    // 只认内存里的 merging：记录上的 merging 可能是合并途中面板重启、或旧版本没清掉留下的
    if (merging.has(childId)) return { ok: false, info: '父对话正在合并你的分支，等结果推回来。' }
    // 交接要点放在最后查：前面几样没满足时先修那些，别让它为了写摘要白跑一趟
    const missing = handoffMissing(handoff)
    if (missing.length)
      return {
        ok: false,
        info: `没有请求收尾：handoff 里还缺「${missing.join('、')}」。以后父对话再把消息交给你、上下文又大时，新会话只带这份交接摘要，按下面的模板写（每项写具体路径和结论，不写过程）：\n${handoffTemplate()}`,
      }
    const parentId = tk.parentTaskId
    const wt = tk.worktree!
    // 先把现在的改动提交到它自己的分支：之后再改的不在这次合并里
    try {
      await commitWorktree(wt, `Agent 面板：${tk.title}${note ? ` — ${note.slice(0, 60)}` : ''}`)
    } catch (e) {
      return { ok: false, info: `提交到独立分支失败：${(e as Error).message}` }
    }
    mergeNudged.delete(childId)
    const at = new Date().toISOString()
    // 面板补的事实（提交、改动文件）现在就读：合回去以后分支和目录会被删掉
    const [commits, changed] = await Promise.all([
      branchCommits(wt.path, tk.baseRef).catch(() => []),
      gitNumstat(wt.path, tk.baseRef).catch(() => null),
    ])
    const request = tk.messages.find((m) => m.role === 'user' && !m.step && !m.panel)?.text ?? ''
    tk.handoff = {
      text: handoffText(handoff, {
        title: tk.title,
        request,
        note,
        tests,
        branch: wt.branch,
        base: wt.baseBranch,
        commits,
        changed: changed ?? {},
        triage: triageText(triage),
      }),
      files: handoff.files ?? '',
      at,
    }
    tk.wrapRequest = { state: 'requested', at, note, tests, ...(build && { build }), info: '' }
    markWrapUp(tk, 'merge', 'waiting', '已请父对话收尾，等父对话合并')
    tk.updatedAt = at
    if (entry) entry.rev++
    await store.update(tk.id, tk)
    // 这次请求本身就是一次状态上报：一轮结束时不再报一遍「待收尾」
    reportedState.set(childId, reportKey(tk, 'wrapup'))
    const child = { id: tk.id, title: tk.title, state: 'wrapup' as const }
    await wakeTask(
      parentId,
      tk,
      `【收尾请求】子对话「${tk.title}」（id ${tk.id}）只剩合回了：计划其余步骤都做完、后台命令都结束、没有待回答的提问。
它在独立分支 ${wt.branch} 里的验证：${tests.slice(0, 600)}${note ? `\n它的说明：${note.slice(0, 300)}` : ''}${triage.length ? `\n它对评审意见的处置（评审只出意见，采不采纳是它核实后定的；驳回或留作已知问题的理由站不住时打回给它）：\n${triageText(triage).slice(0, 1500)}` : ''}
请你收尾：调用 finish_child（id ${tk.id}），面板把它的分支合回「${wt.baseBranch || '你所在的分支'}」、把它计划里的收尾步骤标完成、结束它并删除独立分支和分支。验证不够、你看出问题时不要收，用 send_to_conversation 把要补的交回给它。`,
      { panel: 'wrapup', child, peer: await peerOf(tk, 'child', 'wrapup', note || '只剩合回，请收尾') },
    )
    return {
      ok: true,
      info: '已请父对话收尾：它会把你的分支合回原分支、标完成并删除独立分支，结果推回给你。现在结束这一轮，不要再改文件（这次提交之后再改的不在这次合并里）；父对话退回要你补的，按它说的做完再调用 submit_merge。',
    }
  }

  /**
   * 把面板的消息交给一个对话并让它马上处理：正在执行就实时送达，空闲就开新的一轮；
   * 开不起来（正在收尾、被别的操作占着）就退回收件箱，它下一轮开始时一起处理
   */
  async function wakeTask(
    id: string,
    from: Task,
    text: string,
    meta: {
      panel?: TaskMessage['panel']
      child?: { id: string; title: string; state: ConvState }
      /** 发件对话：收件方画成一行「接收消息」 */
      peer?: PeerFrom
    } = {},
  ) {
    const running = live.get(id)
    const panel = meta.panel ?? 'child'
    try {
      if (running?.task.status === 'running') {
        const msg: TaskMessage = {
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text,
          tools: [],
          panel,
          ...(meta.child && { child: meta.child }),
          ...(meta.peer && { peer: meta.peer }),
          at: new Date().toISOString(),
        }
        await deliver(running, msg, text, [])
      } else await followUp(id, { text, attachments: [], panel, child: meta.child, peer: meta.peer })
    } catch (e) {
      log.warn('task', '没能马上交给对话，放进收件箱', { task: id, error: (e as Error).message })
      alertOn(id, 'delivery', t('一条消息没能马上交给这个对话，已放进收件箱'))(e)
      await noteParent(id, from, text, text, undefined, meta.child, meta.peer)
    }
  }

  /**
   * UE 项目的编译归父对话（见 EngineHost.ueBuild）：子对话的申请交给父对话马上处理，
   * 什么时候编、几个申请合成一次由父对话决定，它再向面板占位
   */
  async function askParentBuild(child: Task, note: string, checks = '') {
    if (!child.parentTaskId) return
    await wakeTask(
      child.parentTaskId,
      child,
      `【编译申请】子对话「${child.title}」（id ${child.id}）申请 UE 编译：${note}${checks ? `\n它做过的检查：${checks.slice(0, 400)}` : ''}
按申请处理：还有别的子对话的申请没编时合成一次，用 request_build 向面板申请编译，children 写上这些子对话的 id；编译结果面板会同时推给你和它们，失败时它们自己修好再申请。`,
      {
        panel: 'wrapup',
        child: { id: child.id, title: child.title, state: 'waiting' },
        peer: await peerOf(child, 'child', 'build', `申请 UE 编译：${note}`),
      },
    )
  }

  async function childRequestBuild(child: Task, note: string): Promise<{ ok: boolean; info: string }> {
    if (!child.parentTaskId) return { ok: false, info: '只有子对话向父对话申请编译' }
    if (isolated(child))
      return {
        ok: false,
        info: '你在独立分支里，改动要先合回父对话的目录才编得到：调用 submit_merge（build 保持 true），合进去后面板替你向父对话申请编译。',
      }
    await askParentBuild(child, note)
    return {
      ok: true,
      info: '已向父对话申请编译。现在可以结束这一轮，编译结果出来面板会直接推给你；报错就修好再申请，通过了再接着做（合并前的验证以这次编译结果为准）。',
    }
  }

  /**
   * 父对话向面板申请编译：编译是占位的资源，交给后台命令的独占队列，按编译目录排队，
   * 同一目录同一时间只编译一次；各自 worktree 的目录是不同的队，不互相占位。
   * 目录被别的父对话占着时告诉申请方占着的是谁，也告诉占着的一方后面有人在等
   */
  async function parentRequestBuild(
    parent: Task,
    project: Project,
    note: string,
    /** 申请这次编译的子对话：结果同时推给它们，不用父对话转述 */
    children: string[] = [],
  ): Promise<{ ok: boolean; info: string; id?: string }> {
    const steps = buildSteps(project.testSteps)
    if (!steps.length)
      return {
        ok: false,
        info: '项目测试步骤里没有编译步骤（勾「合并时编译」或名字带「编译」的）：请用户在项目设置 → 测试步骤里补上，补好之前不要自己拼命令编译。',
      }
    const dir = await taskDir(parent)
    // 先看占着的再排：排进去以后自己的也算在里面
    const before = background.occupants(dir)
    const ids: string[] = []
    for (const st of steps) {
      const r = background.start({
        taskId: parent.id,
        name: `UE 编译：${st.name}`,
        command: stepCommand(st, process.platform, project.wslDistro),
        cwd: st.cwd,
        root: dir,
        exclusive: true,
      })
      if (!r.ok) return { ok: false, info: r.info }
      ids.push(r.id!)
    }
    // 结果也推给申请的子对话：只认父对话名下的
    const mine = new Set((await store.list()).filter((x) => x.parentTaskId === parent.id).map((x) => x.id))
    const to = children.map((x) => x.trim()).filter((x) => mine.has(x))
    if (to.length) for (const id of ids) buildFor.set(id, { parent: parent.id, children: to })
    const queuedMine = before.filter((j) => j.taskId === parent.id).length
    const holders: Task[] = []
    for (const id of new Set(before.map((j) => j.taskId).filter((x) => x !== parent.id))) {
      const tk = live.get(id)?.task ?? (await store.get(id))
      if (tk) holders.push(tk)
    }
    // 占着的是别的父对话：告诉它后面有人在等（不叫醒它，执行中就实时送达，空闲就放进收件箱）
    for (const h of holders.filter((x) => !x.parentTaskId))
      await noteParent(
        h.id,
        parent,
        `【编译占位】父对话「${parent.title}」（id ${parent.id}）申请了编译（${note.slice(0, 200)}），排在你占着的编译后面，你的编译跑完它会自动开始。你还要连着编、或者需要它等你的改动时，用 message_peer 告诉它。`,
        undefined,
        undefined,
        undefined,
        await peerOf(parent, 'peer', 'build', `排在你后面等编译：${note}`),
      )
    const who = holders.map((x) => `「${x.title}」`).join('、')
    return {
      ok: true,
      id: ids.at(-1),
      info: [
        `已申请编译（${steps.map((x) => x.name).join('、')}），编号 ${ids.join('、')}。`,
        who
          ? `这个编译目录现在被${who}占着，你排在后面${holders.some((x) => !x.parentTaskId) ? '，已告诉对方' : ''}。`
          : queuedMine
            ? `你前面还有 ${queuedMine} 条自己的编译在排队。`
            : '编译目录空闲，马上开始。',
        to.length
          ? `结果会推回给你，也会直接推给申请的子对话（${to.join('、')}）；等的时候接着处理别的消息，不要另外跑编译。`
          : '结果会推回给你；等的时候接着处理别的消息，不要另外跑编译。',
      ].join(''),
    }
  }

  /** 同一项目里的其他父对话（顶层对话），最近活动的在前 */
  async function peerList(self: Task) {
    return (await store.list())
      .filter((x) => x.projectId === self.projectId && !x.parentTaskId && x.id !== self.id && !x.archived)
      .map((x) => live.get(x.id)?.task ?? x)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
  }

  /**
   * 合并成功：只更新分支状态（「已在「dev」里」）和计划最后一步，不等于这个子对话做完了。
   * 还在一轮里的把结果交给它，等这一轮结束再按 childFlowOf 收口；已经停下的马上试一次，
   * 计划、后台命令、提问还没完就保留独立分支（见 advanceChildTo）。返回收口的结果（还在一轮里时为空）
   */
  async function childMerged(
    childId: string,
    text: string,
    opts: { quiet?: boolean; peer?: PeerFrom } = {},
  ): Promise<{ holds: ChildHold[]; info: string } | undefined> {
    const entry = live.get(childId)
    const tk = entry?.task ?? (await store.get(childId))
    if (!tk) return undefined
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      panel: 'build',
      ...(opts.peer && { peer: opts.peer }),
      at: new Date().toISOString(),
    }
    const steered = entry?.task.working ? await steerTask(entry.task, text, msg).catch(() => false) : false
    if (!steered) tk.messages.push(msg)
    // 计划最后一步「合回父对话所在的分支」由面板标完成：计划做完才走得到完成那一步
    markWrapUp(tk, 'merge', 'done', '已合回父对话所在的分支')
    // 收尾请求办完了：合进去之后它就不再是「待收尾」。
    // 写 undefined 不用 delete：store.update 是把传入的字段盖到旧记录上，删掉的键盖不掉旧值
    tk.wrapRequest = undefined
    tk.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    await store.update(tk.id, tk)
    if (entry?.task.working) return undefined
    return advanceChildTo(childId, opts)
  }

  /**
   * finish_child 的唯一入口：每次收尾（合进去、没合进去、早就完成了、还不能收）结束后都强制刷新一次父对话的计划，
   * 并把刷新后的计划附在工具结果里。用户 2026-10-24 定的硬要求：「每次子对话请求收尾，父对话收尾完成都需要刷新一下计划列表」。
   * 以前只有独立分支合进去的那条路改父计划、而且一合进去就把那一步标完成（子对话还没收口也算），
   * 共用目录的子对话收尾完父计划一直挂着等待，父对话的 Agent 也看不到计划变成什么样
   */
  async function finishChild(parent: Task, childId: string): Promise<{ ok: boolean; info: string }> {
    const r = await finishChildStep(parent, childId)
    const plan = await syncParentPlan(parent.id, childId).catch((e) => {
      log.warn('task', '收尾后刷新父对话计划失败', { task: parent.id, error: (e as Error).message })
      alertOn(parent.id, 'panel', t('收尾子对话后刷新计划失败'))(e)
      return ''
    })
    return plan ? { ok: r.ok, info: `${r.info}\n\n${plan}` } : r
  }

  /**
   * 收尾之后把父计划里等这个子对话的那一步对齐到子对话现在的状态，和 reportChild 用同一个判据（childReport）：
   * 已完成标完成，失败、中断退回进行中，其余（合进去了还在收口、没合进去退回给它了）继续等并写清在等什么。
   * 不按上报去重：每次收尾都刷新、都落盘并推给界面。返回给父对话 Agent 看的计划文字（没有计划时为空）
   */
  async function syncParentPlan(parentId: string, childId: string): Promise<string> {
    const pEntry = live.get(parentId)
    const pTask = pEntry?.task ?? (await store.get(parentId))
    if (!pTask) return ''
    const tk = live.get(childId)?.task ?? (await store.get(childId))
    let report: ReturnType<typeof childReport> | undefined
    if (tk?.parentTaskId === parentId) {
      const jobs = background
        .list(childId)
        .filter((j) => j.state === 'queued' || j.state === 'running')
        .map((j) => j.name)
      const project = isolated(tk) ? await deps.projects.get(tk.projectId) : null
      report = childReport(tk, {
        background: jobs,
        more: startQueue.has(childId) || hasHeld(childId),
        unmerged: await childUnmerged(tk, project ?? null),
      })
    }
    const text = refreshChildWait(pTask, { id: childId, title: tk?.title ?? childId }, report)
    // 计划没变也写一次：rev 变了界面才会重取，保证每次收尾后看到的都是最新的计划
    pTask.updatedAt = new Date().toISOString()
    if (pEntry) pEntry.rev++
    await store.update(pTask.id, pTask, { now: true })
    return text
  }

  /**
   * 收尾一个子对话的实际动作（finish_child，见 ADR 0005）：子对话已经请求收尾（submit_merge），
   * 面板按父对话排队把它的分支合回父对话所在的分支（git 操作是确定的，交给面板做，父对话只决定收不收），
   * 合进去后把它计划里的收尾步骤标完成、按 childFlowOf 收口（结束进程、删独立分支和分支、置完成），
   * 父对话计划里等它的那一步由 finishChild 收尾后统一刷新。没合进去（冲突、原目录有挡路的改动）退回给子对话处理，它处理好会再请求。
   * 合并就是验收：没请求收尾（没交验证结果）的不收
   */
  async function finishChildStep(parent: Task, childId: string): Promise<{ ok: boolean; info: string }> {
    const tk = live.get(childId)?.task ?? (await store.get(childId))
    if (!tk || tk.parentTaskId !== parent.id)
      return { ok: false, info: '找不到这个子对话：id 从 list_conversations 取，只能收尾你自己名下的子对话' }
    if (tk.resolved) return { ok: true, info: `子对话「${tk.title}」已经完成了，不用再收尾` }
    if (!isolated(tk)) {
      // 共用目录的子对话没有分支要合：条件都满足就直接收口
      const r = await advanceChildTo(childId, { quiet: true })
      return r.holds.length
        ? { ok: false, info: `子对话「${tk.title}」还没做完：${r.info}` }
        : { ok: true, info: `子对话「${tk.title}」已标完成（它和你共用目录，改动已经在原目录里，不用合并）` }
    }
    if (merging.has(childId)) return { ok: false, info: `子对话「${tk.title}」正在合并，结果出来会告诉你` }
    if (tk.wrapRequest?.state !== 'requested')
      return {
        ok: false,
        info: `子对话「${tk.title}」还没请求收尾${tk.wrapRequest?.state === 'failed' ? `（上次没合进去：${tk.wrapRequest.info.split('\n')[0]}，它处理好会再请求）` : ''}：合并就是验收，要它先在自己的分支里跑通验证、调用 submit_merge。需要催它就用 send_to_conversation。`,
      }
    const req = tk.wrapRequest
    merging.add(childId)
    const setReq = async (next: Task['wrapRequest']) => {
      const entry = live.get(childId)
      const cur = entry?.task ?? tk
      cur.wrapRequest = next
      cur.updatedAt = new Date().toISOString()
      if (entry) entry.rev++
      await store.update(cur.id, cur)
      return cur
    }
    await setReq({ ...req, state: 'merging' })
    let r: { ok: boolean; info: string }
    try {
      r = await mergeLock(parent.id, async () => integrate(tk, live.get(parent.id)?.task ?? parent))
    } catch (e) {
      r = { ok: false, info: `合并出错：${(e as Error).message}` }
    } finally {
      merging.delete(childId)
    }
    if (!r.ok) {
      const cur = await setReq({ ...req, state: 'failed', info: r.info })
      markWrapUp(cur, 'merge', 'running', `没能合回：${r.info.split('\n')[0]}`)
      await store.update(cur.id, cur)
      // 退回去了：它处理好再请求时要重新上报一次
      reportedState.delete(childId)
      await sendToChild(
        parent.id,
        childId,
        `【父对话收尾】没能合回原分支：${r.info}
在你的分支里处理好、重新跑通验证后再调用 submit_merge 请父对话收尾。`,
        'build',
        'merge',
        true,
      )
      return { ok: false, info: `没能合回子对话「${tk.title}」：${r.info}\n已经退回给它处理，它处理好会再请你收尾。` }
    }
    const done = await childMerged(
      childId,
      `【父对话收尾】已合回原分支：${r.info}
父对话已经验收合并。计划、后台命令、提问都收口后面板结束这个子对话并删除独立分支；不要再改已经合进去的文件。`,
      { quiet: true, peer: await peerOf(parent, 'parent', 'merge', `已合回原分支：${r.info}`) },
    )
    const finished = !!done && !done.holds.length
    return {
      ok: true,
      info: [
        `已把子对话「${tk.title}」合回：${r.info}`,
        finished
          ? '它的计划收尾步骤已标完成，子对话已结束，独立分支和分支已删除。'
          : `它的计划收尾步骤已标完成；${done ? `还差：${done.info}` : '它这一轮还没结束'}，收口后面板自动结束它并删除独立分支。`,
        req.build
          ? `这是 UE 项目：改动已经进了你的目录，现在调用 request_build 编译（child 写 ${tk.id}），编译结果面板会转给它。`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  /** 后台命令还在跑 / 排队：结果推回来还要接着做，不算彻底结束 */
  const pendingJobs = (id: string) =>
    background.list(id).filter((j) => j.state === 'queued' || j.state === 'running').length

  /**
   * 子对话还在运行（见 convActive）：在跑、等结果、等回答，或者排着队、还有交过来的消息要接着处理。
   * 父对话的「子对话在跑」计数、标题和侧栏的转圈、能不能回收都读它
   */
  const childActive = (tk: Task) =>
    startQueue.has(tk.id) || hasHeld(tk.id) || convActive(convState(childFacts(tk, { background: pendingJobs(tk.id) })))

  /** 名下还在运行的子对话数：all 是已经取好的任务列表（列表接口一次算完所有父对话） */
  async function activeChildren(parentId: string, all?: Task[]) {
    let n = 0
    for (const k of all ?? (await store.list()))
      if (k.parentTaskId === parentId && childActive(live.get(k.id)?.task ?? k)) n++
    return n
  }

  /** 交给界面的任务：补上后台命令和还在运行的子对话数，对外的状态（taskState）才算得全 */
  async function withLive(task: Task): Promise<Task> {
    const t = withJobs(task)
    if (task.parentTaskId) return t
    // 0 也写上：理由同 withJobs
    return { ...t, childrenWorking: await activeChildren(task.id) }
  }

  /**
   * 父对话已经收到「子对话已完成」上报的子对话。只在进程里记：重启后把已经置完成（resolved）的当作上报过了，
   * 不重复往父对话里刷同一条「已完成」
   */
  const reportedDone = new Set<string>()

  /** 上次交给父对话的状态（见 reportChild）：同一个状态不重复报 */
  const reportedState = new Map<string, string>()
  /** 上报去重的键：收尾请求按请求的时间，别的状态按这一轮结束的时间（每轮结束各报一次） */
  const reportKey = (tk: Task, state: ConvState) =>
    state === 'wrapup' ? `wrapup|${tk.wrapRequest?.at ?? ''}` : `${state}|${tk.turnDoneAt}|${tk.status}`

  /**
   * 正在做的「彻底完成」：删独立分支的目录和分支、清后台命令。
   * 继续执行（追加要求）要等它结束再重建目录：收尾和重建撞在一起时，刚重建起来的分支可能又被这次收尾删掉
   * （测试里表现为刚重建的分支状态又变回「已合并」）。并发的两次收尾共用同一次，不重复删。
   */
  const completing = new Map<string, Promise<void | ChildFlowStop>>()
  function completeChildOnce(childId: string, tk: Task): Promise<void | ChildFlowStop> {
    const running = completing.get(childId)
    if (running) return running
    const p = completeChild(childId, tk).finally(() => {
      if (completing.get(childId) === p) completing.delete(childId)
    })
    completing.set(childId, p)
    return p
  }

  /**
   * 第 4 步：子对话这一侧把自己置为完成。
   * 独立分支的目录和分支只在这一步回收（合并成功不等于做完了，别在别处删目录：
   * 还在跑、计划没做完、后台命令还在写目录时删了就把改动一起丢了），
   * 交回原因就停在原地，父对话那边也看不到「已完成」。
   */
  async function completeChild(childId: string, tk: Task): Promise<void | ChildFlowStop> {
    const entry = live.get(childId)
    // 这次收尾推进到一半时用户又发消息继续了：live 里已经换成新的一轮（resume 会重新 reserve、克隆新任务），
    // 这次完成作废。否则收尾结束时会把旧快照写回去，刚重建的分支又被标成「已合并」
    if (entry && entry.task !== tk) return { holds: ['working'], info: t('子对话又开始执行了，等这一轮结束再收尾') }
    // 彻底完成就不再留着会话进程：共用父目录的子对话也一样。
    // 以前这一步只在独立分支里做，共用目录的子对话 resolved 之后 CLI 还在等下一句，
    // 只能等 presence 宽限期（未读的连计时都不排）兜底，实测会留下十几个没人用的进程。
    // 原因写 finish：界面和引擎都按「做完后收尾」处理，不显示成「这一轮被中断」
    if (entry) {
      if (!cancelWait(childId)) stopTask(childId, 'finish')
      await entry.done?.catch(() => {})
    }
    // 后台命令结果推回来还要开新一轮，彻底完成时一起停掉
    await background.stop(childId)
    if (isolated(tk)) {
      const project = await deps.projects.get(tk.projectId)
      const info = project
        ? await releaseWorktree(project.path, tk.worktree!, []).catch((err) => {
            log.warn('task', '彻底完成后删除独立分支失败', { task: childId, error: (err as Error).message })
            alertOn(childId, 'worktree', t('对话完成了，但删除独立分支失败，分支和目录还留着'))(err)
            return ''
          })
        : ''
      // 目录或分支删不掉：仍算没合回去，下次再收一次
      if (info) return { holds: ['unmerged'], info }
      tk.worktree = { ...tk.worktree!, state: 'merged', note: tk.worktree!.baseBranch }
    }
    tk.resolved = true
    tk.wrapRequest = undefined
    tk.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    await store.update(tk.id, tk)
  }

  /**
   * 子对话完成状态的唯一入口：按 wrapup → plan → pending → complete → report → list 走一遍（见 advanceChild）。
   * 用户点「标记完成」、父对话收尾、一轮结束收口、后台命令结束都走这里：父对话侧的动作只是发起这一趟流转，
   * 判定和置完成仍然在子对话这一侧，父对话不直接改子对话的最终状态。
   * 还差什么就原样交回去（原因给用户看），不跳步、不重复置完成、不重复上报。
   * quiet：父对话自己发起的收尾（finish_child），结果已经在工具结果里，不再往父对话里推一条「已完成」
   */
  async function advanceChildTo(
    childId: string,
    opts: { quiet?: boolean } = {},
  ): Promise<{ holds: ChildHold[]; info: string }> {
    const entry = live.get(childId)
    const tk = entry?.task ?? (await store.get(childId))
    if (!tk?.parentTaskId) return { holds: [], info: '' }
    if (isolated(tk)) {
      const project = await deps.projects.get(tk.projectId)
      // 合没合回去要问 git：分支被删、目录被手动清理过时任务上记的 state 不可信
      const st = project ? await worktreeStatus(project.path, tk.worktree!).catch(() => null) : null
      if (!st?.merged) {
        // 分支上还有没合回原分支的改动：不能标完成，也不能删（删了改动就没了）
        if (tk.resolved) {
          tk.resolved = false
          reportedDone.delete(childId)
          tk.updatedAt = new Date().toISOString()
          if (entry) entry.rev++
          await store.update(tk.id, tk)
        }
        return {
          holds: ['unmerged'],
          info: st
            ? t(
                '这个子对话的独立分支还有没合回原分支的改动（{n} 个提交、{d} 个未提交的文件）：先合并或删除分支，再标记完成',
                {
                  n: st.ahead,
                  d: st.dirty,
                },
              )
            : t('查不到这个子对话独立分支的状态（git 没读出来）：先确认分支已经合并，再标记完成'),
        }
      }
    }
    // 已经置过完成的当作已经上报过：重启后再走一趟时不重复往父对话里刷「已完成」
    const done = tk.resolved === true
    const run = await advanceChild(
      childFlowOf(tk, { background: pendingJobs(childId), reported: done || reportedDone.has(childId) }),
      {
        complete: () => completeChildOnce(childId, tk),
        // 第 5 步：上报父对话，走统一的状态上报（见 reportChild）：说法、计划收口和别的状态变化是同一套
        report: async () => {
          reportedDone.add(childId)
          if (opts.quiet) reportedState.set(childId, reportKey(tk, 'done'))
          else await reportChild(childId)
        },
      },
    )
    // 第 6 步（列表）：父对话列表是从子对话状态派生的，第 5 步已经把父对话推了一版（见 noteParent），
    // 页面收到就重取，不在这里另存一份状态
    return { holds: run.holds, info: run.info }
  }

  /** 一次合并：试合并 → 提交；冲突或原目录状态不对就撤回，原目录不变 */
  async function integrate(tk: Task, parent: Task): Promise<{ ok: boolean; info: string }> {
    const wt = tk.worktree!
    const target = await taskDir(parent)
    // 从哪开的分支就合回哪：原目录后来换了分支就不合，免得合到别的分支上
    const now = await currentBranch(target)
    if (wt.baseBranch && now !== wt.baseBranch)
      return {
        ok: false,
        info: `原目录现在在「${now || '分离的 HEAD'}」，不是开分支时的「${wt.baseBranch}」，没有合并。切回「${wt.baseBranch}」后再合。`,
      }
    const blocked = await mergeBlocker(target)
    if (blocked) return { ok: false, info: `${blocked}，没有合并。这不是你的问题，等父对话或用户处理好后再合。` }
    // 两边都改过的文件：git 只在同一处改动上报冲突，同一个文件改不同位置会静默合上。
    // 合并前连同双方的提交记录一起记下来：合进去时一并告诉子对话和父对话「这个文件两边都动过」，
    // 并且让他们能按提交说明和文档看懂各自为什么这么改，而不是只看 diff 拿主意（见 project-vcs 的「合并审查」）
    const sides = await mergeSides(target, wt.branch).catch(() => null)
    const overlap = sides?.overlap ?? []
    const about = sides ? `\n\n${mergeSidesText(sides)}` : ''
    const m = await trialMerge(target, wt.branch)
    if (!m.ok)
      return {
        ok: false,
        info: m.dirty
          ? `原目录里有还没提交的改动和你改的文件重叠，没有合并，原目录没有改动。这不是你的问题，告诉父对话，等那边处理后再合。\n${m.error}${about}`
          : `和「${wt.baseBranch || '原分支'}」上新合进去的改动冲突，已撤回，原目录没有改动。在你的目录里先 git merge ${wt.baseBranch || '原分支'} 把它合进来、解决冲突、重新跑一遍验证并提交，再调用 submit_merge。\n${m.error}${about}`,
      }
    if (m.nothing) return { ok: true, info: '分支上没有新的改动，原分支已经是最新的' }
    try {
      const sha = await commitMerge(target, `Agent 面板：合并「${tk.title}」`)
      const both = overlap.length
        ? `\n两边都改了这些文件：${overlap.slice(0, 20).join('、')}${overlap.length > 20 ? ` 等 ${overlap.length} 个` : ''}。git 已经自动合并，但同一个文件两边都动过：必须逐文件核对有没有盖掉对方的改动，核对结论写进合并结论（见 project-vcs 技能 git.md 的「合并审查」）。`
        : ''
      return {
        ok: true,
        info: `已合进「${wt.baseBranch || '原目录'}」（${sha}），改了 ${m.files.length} 个文件。${both}`,
      }
    } catch (e) {
      await abortMerge(target)
      return { ok: false, info: `合并后提交失败，已撤回：${(e as Error).message}` }
    }
  }

  async function closeChildren(parentId: string) {
    const kids = (await store.list()).filter((x) => x.parentTaskId === parentId && live.has(x.id))
    // 先一起发停止、再一起等：一个一个等的话每个子对话收尾最多要几秒（杀进程树、写盘），
    // 父对话名下十几个子对话时停一次父对话就要卡上一两分钟，期间新的请求也排在后面
    await Promise.all(
      kids.map(async (k) => {
        const entry = live.get(k.id)
        if (!entry) return
        // 正在等下一句的直接结束这一轮；正在执行的按停止处理（输出和状态都保留）。
        // 原因是 parent：父对话收尾停的子对话不能显示成「用户按了暂停」
        if (!cancelWait(k.id)) stopTask(k.id, 'parent')
        if (entry.done) await entry.done.catch(() => {})
        if (live.has(k.id)) stopTask(k.id, 'parent')
      }),
    )
  }

  /**
   * 子对话的状态交给父对话：每轮结束、请求收尾、合并、置完成都走这一个出口（ADR 0005）。
   * 状态只从 childReport（convState）来：父对话收到的说法、父计划里等它那一步的收口、子对话栏是同一个结论。
   * - 还在动（执行中、等结果、等用户回答）：只把父计划那一步的说明改成现在的状态，不刷消息
   * - 未完成、待收尾：那一步继续等，发一条状态（同一状态同一轮只发一次）
   * - 已完成：那一步标完成；失败、中断：那一步退回进行中，都发一条状态
   */
  async function reportChild(childId: string) {
    const tk = live.get(childId)?.task ?? (await store.get(childId))
    if (!tk?.parentTaskId) return
    // 父对话正在合并：合并结果出来时再报，这时报「待收尾」「未完成」会让父对话误判
    if (merging.has(childId)) return
    const jobs = background
      .list(childId)
      .filter((j) => j.state === 'queued' || j.state === 'running')
      .map((j) => j.name)
    // 这一轮结束后还要接着做：排队的要求、面板交过来的消息、刚开好独立分支马上在分支目录里接着做的
    const more = startQueue.has(childId) || hasHeld(childId)
    const project = isolated(tk) ? await deps.projects.get(tk.projectId) : null
    const r = childReport(tk, { background: jobs, more, unmerged: await childUnmerged(tk, project ?? null) })
    if (r.settle === 'hold') {
      await holdChildWait(tk, r.why).catch((e) =>
        log.warn('task', '更新父对话计划的等待说明失败', { task: tk.id, error: (e as Error).message }),
      )
      if (!r.notify) return
    }
    const key = reportKey(tk, r.state)
    if (reportedState.get(childId) === key) return
    reportedState.set(childId, key)
    const summary = tk.summary || lastReply(tk)
    const text = `【子对话状态】「${tk.title}」（id ${tk.id}）${r.why}${summary ? `\n最近的结果：${summary.slice(0, 1500)}` : ''}`
    await noteParent(
      tk.parentTaskId,
      tk,
      text,
      text,
      r.settle === 'hold' ? undefined : { kind: 'child', ref: tk.id, ok: r.settle === 'ok' },
      { id: tk.id, title: tk.title, state: r.state },
      await peerOf(tk, 'child', 'report', r.why, r.state === 'failed'),
    )
  }

  /**
   * 子对话这一轮结束了（CLI 报完成、停在等下一句，或者整次执行结束）：
   * 独立分支里的先试着收口（条件都满足就完成、回收；只差请求收尾时提醒它一次），再统一上报父对话。
   * 放到下一拍：别在 CLI 收尾的回调里结束它
   */
  function settleChildTurn(child: Task) {
    if (!child.parentTaskId) return
    if (isolated(child) && !hasHeld(child.id) && !merging.has(child.id) && !child.resolved) {
      setImmediate(
        () =>
          void settleChildWorktree(child.id).catch((e) => {
            log.warn('task', '子对话一轮结束收口失败', { task: child.id, error: (e as Error).message })
            alertOn(child.id, 'panel', t('这一轮结束后整理独立分支、上报父对话时出错'))(e)
          }),
      )
      return
    }
    void reportChild(child.id).catch((e) => {
      log.warn('task', '子对话状态上报失败', { task: child.id, error: (e as Error).message })
      alertOn(child.id, 'delivery', t('这个对话的状态没能报给父对话'))(e)
    })
  }

  /**
   * 一轮结束后收口子对话的独立分支：条件都满足就回收（见 advanceChildTo，会上报「已完成」），
   * 只差「请父对话收尾」却没请的提醒它一次；其余照常上报现在的状态
   */
  async function settleChildWorktree(childId: string) {
    const tk = live.get(childId)?.task ?? (await store.get(childId))
    if (!tk?.parentTaskId) return
    if (isolated(tk)) {
      const { holds } = await advanceChildTo(childId)
      if (!holds.length) return
      if (await nudgeMerge(tk)) return
    }
    await reportChild(childId)
  }

  /**
   * 子对话这一轮做完了，除了合回之外都做完了，却没请父对话收尾：推一条面板消息提醒它跑通验证后调用 submit_merge。
   * 只提醒一次，再结束还没请就照常上报父对话（未完成），由父对话决定。提醒发出去了返回 true
   */
  async function nudgeMerge(child: Task): Promise<boolean> {
    if (!child.parentTaskId || mergeNudged.has(child.id) || child.wrapRequest) return false
    if (child.status !== 'done' || child.working) return false
    if (child.requests.length || child.parentAsks?.length || openWork(child).length) return false
    if (background.list(child.id).some((j) => j.state === 'queued' || j.state === 'running')) return false
    const project = await deps.projects.get(child.projectId)
    const st = project ? await worktreeStatus(project.path, child.worktree!).catch(() => null) : null
    if (!st) return false
    // 分支已经在原分支里了（子对话或它派的子任务自己 git merge 过去），计划却还停在「合回」这一步：
    // 不提醒的话没人会去调用 submit_merge，计划一直卡在收尾、子对话也一直不算完成
    const wrapOpen = !!activePlan(child)?.steps.some((s) => s.wrapUp === 'merge' && s.status !== 'done')
    if (st.merged && !wrapOpen) return false
    mergeNudged.add(child.id)
    const what = [st.ahead ? `${st.ahead} 个提交` : '', st.dirty ? `${st.dirty} 个未提交的文件` : ''].filter(Boolean)
    const r = await sendToChild(
      child.parentTaskId,
      child.id,
      st.merged
        ? '【面板】你的分支已经在父对话的分支里了，但还没请父对话收尾，计划停在「合回父对话所在的分支」。直接调用 submit_merge（tests 写上跑过的验证），父对话确认后面板标完成并删除分支。以后收尾都用 submit_merge，不要自己或派子任务去 git merge。'
        : `【面板】你的独立分支里还有没合回父对话分支的改动（${what.join('、')}），也还没请父对话收尾。按「验证」在你的分支里跑通编译和测试后调用 submit_merge（tests 写上跑了什么、结果如何），父对话会合并、标完成并删除分支；没合回去之前不算做完。验证没过就修好再交，确实不该合并就说明原因。`,
      'build',
    )
    return r.ok
  }

  /** 子对话还没交付完：父对话计划里等它的那一步继续等，note 写清它现在的状态 */
  async function holdChildWait(child: Task, why: string) {
    if (!child.parentTaskId) return
    const entry = live.get(child.parentTaskId)
    const parent = entry?.task ?? (await store.get(child.parentTaskId))
    if (!parent) return
    if (!holdWait(parent, 'child', child.id, why).length) return
    parent.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    await store
      .update(parent.id, parent)
      .catch((e) => log.warn('task', '更新父对话计划的等待说明失败', { task: parent.id, error: (e as Error).message }))
  }

  /** 子对话整次执行结束（成功、失败、被停）：和一轮结束走同一个收口（重复的上报会被去掉） */
  async function reportToParent(task: Task) {
    if (!task.parentTaskId) return
    settleChildTurn(task)
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
        const msg: TaskMessage = {
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: body,
          tools: [],
          peer: await peerOf(tk, 'parent', 'rule', fresh),
          at,
        }
        const how = await steerTask(k.task, body, msg).catch(() => false)
        if (!how) k.task.messages.push(msg)
        k.rev++
      }
    return { task: tk }
  }

  /** 父对话分派的子对话：占一个执行位再开始，这一轮结束（含它跑的工作流）才让出来 */
  async function startChild(parentId: string, sub: Task, message: string, agents: Agent[]) {
    startQueue.add(sub.id)
    const free = await takeSlot(parentId).finally(() => startQueue.delete(sub.id))
    try {
      const got = reserve(sub)
      // 同一个子对话已经被启动了：复用正在跑的那一轮，不再开第二个进程
      if (!got.fresh) return
      const entry = got.value
      entry.freeSlot = free
      await start(entry, withAttachments(message, []), true, agents)
      await entry.done
    } catch (e) {
      log.error('task', '子对话执行出错', { task: sub.id, error: (e as Error).message })
      alertOn(sub.id, 'panel', t('执行这个子对话时出错'), 'error')(e)
    } finally {
      free()
    }
  }

  /**
   * 子对话给父对话发消息：父对话正在执行就实时交给它，否则记进父对话，下一轮一起处理。
   * 汇报只交给父对话的 AI（界面上在子对话自己的对话里看）；提问、收尾建议在父对话里显示成可以直接选择的卡片。
   * kind 为 suggestion 时是这一轮做完的收尾建议：说法不一样，没给选项时补上默认的两个
   */
  async function messageParent(
    child: Task,
    text: string,
    question: boolean,
    options: string[] = [],
    kind: AskKind = 'question',
  ) {
    const parent = live.get(child.parentTaskId)?.task ?? (await store.get(child.parentTaskId))
    if (!parent) return { ok: false, info: '找不到父对话' }
    const suggestion = question && kind === 'suggestion'
    // 「提问」开关关着（默认就是关的）：子对话的提问和收尾建议不交给用户，直接交给父对话的 AI 决定。
    // 这时不产生 ask 卡片：卡片和「交给父对话决定」的折叠行都是给用户准备的，用户已经不回答问题了，
    // 留着它只会让父对话里多出一条等人点「去选择」的东西；只有 panel 为 child 的汇报记一条给 AI 看
    const auto = question && !parent.askUser
    const head = question
      ? suggestion
        ? `子对话「${child.title}」的收尾建议`
        : `子对话「${child.title}」提问`
      : `子对话「${child.title}」汇报`
    const opts = question ? askOptions(options, kind) : []
    const body = opts.length ? `${text}\n\n可选的做法：\n${opts.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : text
    // 自动交给父对话时把「谁来答」写进正文：父对话的 AI 之后从对话历史和收件箱读到的就是这句
    const why = auto ? '\n\n（「提问」关着，用户不会回答：请你按最合理的做法直接决定，别再问用户）' : ''
    // 提问卡片（ask）自己就说明了是谁问的；其余（汇报、自动交给父对话 AI 的提问）画成「接收消息」
    const peer = await peerOf(child, 'child', question ? 'question' : 'report', text)
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: `${head}：\n${body}${question ? `\n\n（决定后用 send_to_conversation 交给这个子对话，id: ${child.id}）` : ''}${why}`,
      tools: [],
      panel: question && !auto ? 'ask' : 'child',
      ...(!(question && !auto) && { peer }),
      ...(question && !auto
        ? {
            ask: {
              from: child.id,
              title: child.title,
              question: text,
              options: opts,
              kind: suggestion ? ('suggestion' as const) : ('question' as const),
            },
          }
        : {}),
      at: new Date().toISOString(),
    }
    // 提问、收尾建议同时挂在子对话上：子对话的输入框换成选择弹窗，用户进子对话就能直接选
    // 自动交给父对话的不挂：不产生要用户回答的弹窗，也不计入「需要你处理」
    if (question && !auto) {
      child.parentAsks = [...(child.parentAsks ?? []), { id: msg.id, question: text, options: opts, kind }]
      const ce = live.get(child.id)
      if (ce) ce.rev++
      else await store.update(child.id, child).catch(() => {})
    }
    const entry = live.get(parent.id)
    const how = entry?.task.working ? await steerTask(entry.task, msg.text, msg).catch(() => false) : false
    if (!how) {
      parent.messages.push(msg)
      parent.inbox.push({ from: child.id, title: child.title, text: question ? `（提问）${body}` : text, at: msg.at })
    } else if (!parent.messages.some((x) => x.id === msg.id)) {
      // 正在跑的父对话已经从插话里收到问题：也记一条（自动交出时 panel 是 child，界面不画），它下一轮还能看到
      parent.messages.push(msg)
    }
    parent.updatedAt = msg.at
    if (entry) entry.rev++
    else await store.update(parent.id, parent).catch(() => {})
    // 自动交给父对话的 AI 作答：正在执行的已经在插话里收到了，空闲的给它开一轮（答案从收件箱里看全文）
    if (auto) {
      await store.update(parent.id, parent).catch(() => {})
      if (!entry?.task.working)
        await followUp(parent.id, {
          text: `子对话「${child.title}」${suggestion ? '的收尾建议' : '在等你决定'}（在收件箱里，「提问」关着，用户不会回答）。按已有信息选最合理的做法，把「你替它决定了什么、依据、不对怎么改」写清楚，再用 send_to_conversation 交给它（id: ${child.id}）。`,
          attachments: [],
          panel: 'child',
          peer,
        }).catch((e) => {
          log.warn('task', '自动交给父对话决定时没能开始新的一轮', { error: (e as Error).message })
          alertOn(parent.id, 'delivery', t('子对话等你决定，但没能开一轮来处理，问题在收件箱里'))(e)
        })
    }
    if (auto)
      return {
        ok: true,
        info: suggestion
          ? '「提问」关着，这条建议自动交给父对话决定（不问用户）。这一轮可以结束了，不要再把建议重复写进结论里等它。'
          : `「提问」关着、用户不会回答：这条提问已经交给父对话的 AI 决定${how ? '（它正在执行，已经实时收到）' : '（它空闲时会接着作答）'}。你按${opts.length ? `第 1 个做法「${opts[0]}」` : '最稳妥的做法'}继续往下做，不要停下来等；结论里写一句「提问已按默认处理：${opts.length ? opts[0] : '按最稳妥的做法继续'}」。`,
      }
    if (how) return { ok: true, info: '已实时交给父对话' }
    return {
      ok: true,
      info: question
        ? suggestion
          ? '父对话现在没在执行，这条收尾建议已经记在父对话里，用户会在面板上直接选。选完会自动交回给你；这一轮可以结束了，不要再把建议重复写进结论里等它。'
          : '父对话现在没在执行，问题已经记在父对话里，用户或父对话下一轮会回答。不要停下来等：先按最稳妥的做法继续，或者结束这一轮并写清需要决定的事。'
        : '已记在父对话里，它下一轮会看到',
    }
  }

  /**
   * 父对话把消息交给子对话时：这个子对话还没人回答的提问算父对话回答了，卡片收起。
   * 给了 msgId 只收这一张（用户在弹窗里一个个回答时，别的提问还在等）
   */
  function settleAsks(
    parent: Task,
    childId: string,
    answer: string,
    by: 'user' | 'parent',
    msgId?: string,
    declined = false,
  ) {
    const ids: string[] = []
    for (const m of parent.messages)
      if (m.panel === 'ask' && m.ask?.from === childId && m.ask.answer === undefined && (!msgId || m.id === msgId)) {
        m.ask = { ...m.ask, answer: answer.slice(0, 2000), by, ...(declined ? { declined } : {}) }
        ids.push(m.id)
      }
    if (ids.length)
      void dropChildAsks(childId, ids).catch((e) =>
        log.warn('task', '没能收起子对话的选择弹窗', { task: childId, error: (e as Error).message }),
      )
    return ids.length > 0
  }

  /** 子对话上挂着的提问（选择弹窗）：父对话那边回答了或交出去了就去掉 */
  async function dropChildAsks(childId: string, ids: string[]) {
    const entry = live.get(childId)
    const child = entry?.task ?? (await store.get(childId))
    if (!child?.parentAsks?.some((x) => ids.includes(x.id))) return
    child.parentAsks = child.parentAsks.filter((x) => !ids.includes(x.id))
    if (entry) entry.rev++
    else await store.update(child.id, child)
  }

  /**
   * 用户直接在子对话里回复：这就算回答了它挂在父对话里的提问。
   * 以前只有「在父对话卡片上点选」和「父对话转发」两条路会收起卡片，用户自己进子对话答完，
   * 父对话里的卡片仍停在「待决定」，还得再答一次
   */
  async function settleAskFromChild(childId: string, answer: string) {
    const child = live.get(childId)?.task ?? (await store.get(childId))
    if (!child?.parentTaskId) return
    const entry = live.get(child.parentTaskId)
    const parent = entry?.task ?? (await store.get(child.parentTaskId))
    if (!parent || !settleAsks(parent, childId, answer, 'user')) return
    // 父对话的 AI 也从收件箱收到过这个问题：换成「用户已回答」，免得它再决定一遍
    parent.inbox = parent.inbox.filter((x) => !(x.from === childId && x.text.startsWith('（提问）')))
    parent.inbox.push({
      from: childId,
      title: child.title,
      text: `（用户已回答你收到的提问）${answer}`,
      at: new Date().toISOString(),
    })
    parent.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    await store.update(parent.id, parent)
  }

  /**
   * 让父对话马上处理一件事（子对话的提问交给它决定之类），并把「到底交到了没有」如实告诉调用方。
   * 父对话正在这一轮里：走和用户消息一样的实时交付 —— CLI 停在等下一句就直接续上、能插话就插话、
   * 收不下就记下来这一轮结束后处理。不再只看 working：等下一句、收尾中、预热时 working 都是 false，
   * 但执行位仍然占着，以前直接 followUp 会抛 TaskBusyError、被吞成一条日志，界面上就是「点了没反应」。
   * 完全空闲才开新一轮；开不起来时返回原因，由界面显示给用户。
   */
  async function nudgeParent(parent: Task, text: string) {
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      panel: 'child',
      at: new Date().toISOString(),
    }
    // 刚开始预热、CLI 还没停在等下一句：这一轮收不下，也不能干等它启动完，让用户稍后重试
    if (live.get(parent.id)?.task.prewarming) return { ok: false as const, error: t('父对话正在启动，稍后再试') }
    for (let i = 0; i < 2; i++) {
      const entry = live.get(parent.id)
      if (entry?.task.status === 'running') {
        const r = await deliver(entry, msg, text, [])
        return { ok: true as const, how: r.how }
      }
      if (!entry) break
      // 进程还占着执行位但没在跑这一轮（刚结束、正在收尾）：等它收完再开新一轮
      await entry.done?.catch(() => {})
      if (!live.has(parent.id)) break
    }
    try {
      await followUp(parent.id, { text, attachments: [], panel: 'child' })
      return { ok: true as const, how: 'next' as const }
    } catch (e) {
      if (e instanceof TaskBusyError) return { ok: false as const, error: t('父对话正在执行，等它这一轮结束后重试') }
      return { ok: false as const, error: (e as Error).message }
    }
  }

  /**
   * 「提问」关掉时，父对话里还没人回答的子对话提问（历史卡片）一起交给父对话的 AI 决定：
   * 卡片记成已交出、子对话那边的选择弹窗收掉，父对话空闲时开一轮作答。
   * 不做这一步，关掉开关后这些卡片仍停在「等你选择」/「交给父对话决定」，子对话也会一直等着
   */
  async function handChildAsksToParent(parent: Task, working: boolean) {
    const waiting = parent.messages.filter(
      (m) => m.panel === 'ask' && m.ask && m.ask.answer === undefined && !m.ask.delegated,
    )
    if (!waiting.length) return false
    const lines: string[] = []
    for (const m of waiting) {
      const ask = m.ask!
      m.ask = { ...ask, delegated: true }
      await dropChildAsks(ask.from, [m.id])
      lines.push(
        `- 子对话「${ask.title}」${ask.kind === 'suggestion' ? '的收尾建议' : '的提问'}：${ask.question}${
          ask.options.length ? `（可选做法：${ask.options.join(' / ')}）` : ''
        }（交给它用 send_to_conversation，id: ${ask.from}）`,
      )
    }
    const text = `用户关掉了「提问」，下面这些子对话的问题不会再有人回答，请你按已有信息选最合理的做法，把「你替它们决定了什么、依据、不对怎么改」写清楚，再用 send_to_conversation 交给它们：\n${lines.join('\n')}`
    const msg: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      panel: 'child',
      at: new Date().toISOString(),
    }
    if (working) {
      const how = await steerTask(parent, text, msg).catch(() => false)
      if (!how) parent.messages.push(msg)
    } else {
      parent.messages.push(msg)
      await followUp(parent.id, { text, attachments: [], panel: 'child' }).catch((e) => {
        log.warn('task', '关闭提问时没能开始一轮作答', { error: (e as Error).message })
        alertOn(parent.id, 'delivery', t('关掉「提问」后没能开一轮去回答子对话的问题'))(e)
      })
    }
    return true
  }

  /**
   * 把一张提问卡片交给父对话的 AI 决定：先记 delegated 并落盘（刷新后仍是「交给父对话决定」），
   * 再用实时交付叫起父对话（等下一句、收尾中、刚预热时都要交得到），交不到时把原因写回卡片。
   * 用户点卡片上的按钮走这个函数。
   */
  async function delegateAsk(parentId: string, msgId: string) {
    const found = live.get(parentId)
    const parent = found?.task ?? (await store.get(parentId))
    const m = parent?.messages.find((x) => x.id === msgId && x.panel === 'ask')
    if (!parent || !m?.ask) return null
    const ask = m.ask
    // 已经交出去、也真的叫起过：重复点击不再叫一次（用户会连点好几下）
    if (ask.delegated && ask.delegatedAt) {
      await dropChildAsks(ask.from, [m.id])
      return { task: parent, nudge: { ok: true as const, how: 'already' as const } }
    }
    // 先记成「已交给父对话决定」并落盘：叫父对话时它会重新读这份任务，不先写下去这一步会被新副本盖掉
    ask.delegated = true
    if (found) found.rev++
    await store.update(parent.id, parent).catch(() => {})
    await dropChildAsks(ask.from, [m.id])
    // 问题全文一起交过去：父对话续上等下一句的那次调用时，收件箱不会重新读，只写「在收件箱里」它拿不到内容
    const nudge = await nudgeParent(parent, delegatePrompt(ask))
    const cur = live.get(parent.id)?.task ?? parent
    const at = new Date().toISOString()
    if (nudge.ok) {
      // 记下叫起的时间，重复点击据此判断；问题已经随消息交出去了，收件箱里不再留一份免得又答一遍
      const done = cur.messages.find((x) => x.id === msgId)?.ask
      if (done) {
        done.delegatedAt = at
        delete done.delegatedError
      }
      cur.inbox = cur.inbox.filter(
        (x) => !(x.from === ask.from && x.text.startsWith('（提问）') && x.text.includes(ask.question)),
      )
    } else {
      // 没能叫起父对话：问题留在收件箱里，父对话下一轮还能读到；卡片上另外显示原因和重试
      if (!cur.inbox.some((x) => x.from === ask.from && x.text.startsWith('（提问）') && x.text.includes(ask.question)))
        cur.inbox.push({ from: ask.from, title: ask.title, text: `（提问）${ask.question}`, at })
      const failed = cur.messages.find((x) => x.id === msgId)?.ask
      if (failed) failed.delegatedError = nudge.error
    }
    const live2 = live.get(parent.id)
    if (live2) live2.rev++
    await store.update(parent.id, cur).catch(() => {})
    return { task: cur, nudge }
  }

  /**
   * 用户在父对话的提问卡片上回答：答案直接交给子对话，并告诉父对话的 AI 不用再回答；
   * 不回答而是交给父对话决定时（delegate），走 delegateAsk
   */
  async function answerChildAsk(parentId: string, msgId: string, answer: string, delegate: boolean) {
    const found = live.get(parentId)
    const parent = found?.task ?? (await store.get(parentId))
    const m = parent?.messages.find((x) => x.id === msgId && x.panel === 'ask')
    if (!parent || !m?.ask) return { error: t('找不到这个提问') }
    if (m.ask.answer !== undefined) return { error: t('这个提问已经回答过了') }
    const { from, title, question } = m.ask
    const suggestion = m.ask.kind === 'suggestion'
    if (delegate) {
      const r = await delegateAsk(parent.id, m.id)
      if (!r) return { error: t('找不到这个提问') }
      return r
    }
    const r = await sendToChild(
      parent.id,
      from,
      suggestion ? `关于你刚才的收尾建议，用户的决定：\n${answer}` : `关于你刚才的提问，用户的决定：\n${answer}`,
      undefined,
      'answer',
    )
    if (!r.ok) return { error: r.info }
    const cur = live.get(parent.id)?.task ?? parent
    settleAsks(cur, from, answer, 'user', m.id) // 父对话的 AI 也收到过这个问题：告诉它用户已经回答了，不要再答一遍
    const note = suggestion
      ? `用户已经决定了子对话「${title}」建议的下一步，不用再回答。\n建议：${question}\n用户的选择：${answer}`
      : `用户已经直接回答了子对话「${title}」的提问，不用再回答。\n问题：${question}\n用户的决定：${answer}`
    const live2 = live.get(parent.id)
    const steered = live2?.task.working
      ? await steerTask(live2.task, note, {
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: note,
          tools: [],
          panel: 'child',
          at: new Date().toISOString(),
        }).catch(() => false)
      : false
    if (!steered) {
      // 只去掉这一个问题：同一个子对话别的提问还在等
      cur.inbox = cur.inbox.filter((x) => !(x.from === from && x.text.startsWith(`（提问）${question}`)))
      cur.inbox.push({ from, title, text: `（用户已回答你收到的提问）${answer}`, at: new Date().toISOString() })
    }
    cur.updatedAt = new Date().toISOString()
    if (live2) live2.rev++
    await store.update(cur.id, cur)
    return { task: cur }
  }

  /**
   * 子对话一轮结束后：这一轮改过的文件和其他还在执行的兄弟子对话改过的撞了，
   * 在子对话里留一条提醒（只在这些对话真的共用一个工作目录时：后写的会覆盖先写的）。
   * 走独立分支的子对话各改各的，撞了是合并时的事，由 git merge 处理，不提醒也不汇报父对话。
   */
  async function checkCollisions(child: Task) {
    const list = collisionNotice(
      child,
      [...live.values()].map((e) => e.task),
    )
    if (!list) return
    child.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: t(
        '这些文件同时被别的子对话改过：{list}。这些对话和你在同一个工作目录里改文件，后写的会覆盖先写的，先约定先后或各自改哪些文件。',
        { list },
      ),
      tools: [],
      at: new Date().toISOString(),
    })
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
      release(entry)
      throw e
    })
    // 项目里给必备角色填的参数当作这个项目里的默认值（对话、节点、派出去的子 Agent 都按它）
    agents = withProjectParams(agents, found ?? undefined)
    if (task.projectId) await ensureChildWorktree(entry, found)
    // 独立分支的工作区被回收后又继续（父对话交给子对话、面板重启后续接）：先建回来，再按新目录执行
    const restoreErr = !prewarm && found ? await restoreWorktree(entry.task, found) : ''
    // 独立分支执行时，Agent 在任务自己的工作目录里改，不碰项目目录；
    // 子对话不建独立分支，和父对话用同一个目录（父对话在独立分支里时就是父的那个目录）
    const dir = found ? await taskDir(task).catch(() => found.path) : ''
    const project = found && dir && dir !== found.path ? { ...found, path: dir } : found
    const parentTask = task.parentTaskId
      ? (live.get(task.parentTaskId)?.task ?? (await store.get(task.parentTaskId)) ?? undefined)
      : undefined
    const rootId = task.parentTaskId || task.id
    // 父对话在对话设置里给子对话定了 CLI / 模型 / 思考强度：子对话的角色按它跑。
    // 换了 CLI 时角色原来的模型、强度是另一个 CLI 的，没另外指定就用新 CLI 的默认
    const childRun = parentTask?.childRun
    if (childRun && (childRun.cli || childRun.model || childRun.effort))
      agents = agents.map((a) => {
        if (a.id !== task.agentId) return a
        const cli = childRun.cli || a.cli
        const same = cli === a.cli
        return {
          ...a,
          cli,
          model: childRun.model || (same ? a.model : ''),
          effort: childRun.effort || (same ? a.effort : ''),
        }
      })
    // 这一轮启动时的选择，用来判断执行中用户有没有换 CLI/模型/强度。
    // 不用 Agent 角色的对话（agentId 为空）按默认 Agent 的配置算，CLI、模型取任务里选的那一套
    const startAgent = task.agentId ? agents.find((a) => a.id === task.agentId) : { ...defaultAgent(), id: '' }
    const startedRun = startAgent ? agentRun(withTaskModel(startAgent, task), settings) : undefined
    // 项目里用分派角色（统筹）的顶层对话就是父对话：只统筹，不改文件
    const coordinatorRole = !task.parentTaskId && !!task.projectId && !!startAgent?.canDelegate
    // UE 项目（目录里有 .uproject）的编译归父对话：子对话申请，父对话按申请占位编译
    const ueProject = task.mode === 'chat' && !!found?.path && (await isBigProject(found.path).catch(() => false))
    const ueRole = !ueProject ? undefined : task.parentTaskId ? 'child' : coordinatorRole ? 'parent' : undefined
    let last = 0
    /**
     * 落盘。now：对话消息立即写，不等 400ms 合并窗口——关键节点（changed(true)、这一轮结束/失败/停止）
     * 用它，面板被强杀时不会丢最后一段。keepUpdatedAt：预热收尾要保留原来的列表时间
     */
    const flush = (keepUpdatedAt = false, now = false) =>
      store
        .update(task.id, entry.task, { keepUpdatedAt, now })
        .catch((e) => console.error(`保存任务失败：${(e as Error).message}`))
    const changed = (f?: boolean) => {
      entry.task.updatedAt = new Date().toISOString()
      trackWait(entry.task)
      entry.rev++
      // 对话的 CLI 回复完会常驻等下一句，不等进程结束：第一次回复完就起标题
      if (entry.task.turnDoneAt) nameOnce(entry.task, startedRun?.cli ?? '')
      // 流式输出时最多每 3 秒落盘一次，关键节点（节点开始/结束、调用完成、提问、等用户决定、这一轮收尾）
      // 都走 changed(true) 立即落盘（消息文件也不走合并窗口），所以节流只影响正在输出途中的中间态。
      // 从 1 秒放宽到 3 秒：指纹已经是增量的（见 task-store 的 createStampTracker），
      // 但整份 messages 的序列化还是 O(全部消息)，3 秒一次把这个成本降下来，
      // 代价是面板被强杀时最多丢 3 秒的流式输出（正常结束、失败、停止都还会立即写一次）。
      if (f || Date.now() - last > 3000) {
        last = Date.now()
        void flush(false, f === true)
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
      // 工作区建不回来就别再跑下去了：runRealTurn 里只会报「项目目录不存在」，用户不知道该怎么办
      if (restoreErr) throw new Error(restoreErr)
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
        // 停下这一轮的原因：engine 收尾时按它决定写「已暂停」还是写清是谁结束的（见 StopReason）
        stopReason: () => entry.stopReason,
        // 开始保活（CLI 停在等下一句）前先按全局上限收一批最久没用的，别让挂着的进程越来越多
        onKeepAlive: (taskId) => {
          // 子对话回复完停在等下一句：不再干活，把父对话的并发名额让给排队的子对话
          if (task.parentTaskId) releaseSlot(entry)
          // 回收计时从现在起算满一整段：执行期间计时器被 busy 挡回去过，不重置会提前收掉刚空下来的会话
          resetIdleCountdown(taskId)
          void enforceKeepAlive(taskId)
        },
        changed,
        newId: randomUUID,
        // 子对话这一轮真结束的地方收口父对话计划里等它的步骤（进程保活等下一句时 run 不返回，等不到收尾）
        onTurnEnd: task.parentTaskId ? () => settleChildTurn(entry.task) : undefined,
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
        goal: (task.parentTaskId ? parentTask?.goal : entry.task.goal) || '',
        takeInbox: task.parentTaskId
          ? undefined
          : () => {
              const got = entry.task.inbox
              entry.task.inbox = []
              return got
            },
        messageParent: task.parentTaskId
          ? (text, question, options, kind) => messageParent(entry.task, text, question, options, kind)
          : undefined,
        childIsolation: found?.childIsolation,
        worktreeHome: isolated(entry.task) && found ? await worktreeHome(entry.task, found) : undefined,
        wrapUp: await childWrapUp(entry.task, project?.path),
        // P4 项目里的对话和节点都能用：分 changelist 由面板照类型执行，不靠 Agent 自己记得分（见 p4-split.ts）
        p4Split:
          dir && project?.path && (await isP4(project.path))
            ? (input) => splitChangelists(p4Runner(dir), input)
            : undefined,
        submitMerge:
          task.parentTaskId && isolated(entry.task)
            ? (note, tests, build, handoff, triage) =>
                submitMerge(task.id, note, tests, ueRole === 'child' && build !== false, handoff, triage)
            : undefined,
        ueBuild:
          ueRole === 'child'
            ? { role: 'child', request: (note) => childRequestBuild(entry.task, note) }
            : ueRole === 'parent' && found
              ? { role: 'parent', request: (note, kids) => parentRequestBuild(entry.task, found, note, kids) }
              : undefined,
        // 顶层项目对话收尾名下的子对话：子对话 submit_merge 请求后由它合回、标完成、删分支（ADR 0005）
        finishChild: !task.parentTaskId && task.projectId ? (id) => finishChild(entry.task, id) : undefined,
        // 父对话之间：看同一项目里的其他父对话、给它们传话（编译占位时的协调就靠它）
        peers: coordinatorRole
          ? async () =>
              (await peerList(entry.task)).map((p) => ({
                id: p.id,
                title: p.title,
                status: p.status,
                busy: !!p.working,
                building: background
                  .list(p.id)
                  .filter((j) => j.exclusive && !j.endedAt)
                  .map((j) => `${j.name}（${j.state === 'running' ? '正在跑' : '排队中'}）`)
                  .join('、'),
              }))
          : undefined,
        messagePeer: coordinatorRole
          ? async (id, text) => {
              const peer = (await peerList(entry.task)).find((p) => p.id === id)
              if (!peer) return { ok: false, info: '找不到这个父对话：id 从 list_peers 取，只能联系同一项目里的父对话' }
              await wakeTask(
                peer.id,
                entry.task,
                `【父对话传话】来自「${entry.task.title}」（id ${entry.task.id}）：${text}\n要回话就用 message_peer 回给它；只协调，不用替它做决定。`,
                { peer: await peerOf(entry.task, 'peer', 'chat', text) },
              )
              return { ok: true, info: `已交给父对话「${peer.title}」` }
            }
          : undefined,
        // 只有项目里的对话有：工作流的测试验收节点照常按快照里的完整步骤跑
        verify:
          task.mode === 'chat' && found?.id
            ? {
                steps: found.testSteps,
                platform: process.platform,
                wslDistro: found.wslDistro,
                scaled: found.scaledVerify,
              }
            : undefined,
        // 父对话（统筹）不改文件、不开独立分支（靠角色说明约束，不关它的工具）：就在项目目录的当前分支上，子对话从这里开、合回这里
        beginEdit:
          task.mode === 'chat' && !coordinatorRole && entry.task.wantsWorktree && !isolated(entry.task)
            ? () => beginEdit(entry, changed)
            : undefined,
        branch: coordinatorRole && dir ? await currentBranch(dir).catch(() => '') : undefined,
        // 只给对话用：工作流节点一跑完就结束，结果没有地方推回
        runBackground:
          task.mode === 'chat' && dir
            ? async (input) => {
                // UE 的编译归父对话：子对话交来的编译命令不跑，父对话也走 request_build 占位，不从这里绕过排队
                if (ueRole && isUeBuildCommand(input.command))
                  return {
                    ok: false,
                    info:
                      ueRole === 'child'
                        ? 'UE 项目里子对话不编译：改完向父对话申请（独立分支里用 submit_merge 并保持 build 为 true，否则用 request_build）。'
                        : 'UE 编译要用 request_build 申请：面板按编译目录占位排队，不从后台命令直接跑。',
                  }
                return background.start({ ...input, taskId: task.id, root: dir, env: noPushEnv(entry.task) })
              }
            : undefined,
        checkBackground: (id) => background.check(task.id, id),
        stopBackground: (id) => background.stopOne(task.id, id),
        // 独立分支里的子对话改不到别人的文件，不用认领；要改时才开分支的也一样
        claimFiles:
          task.parentTaskId && !isolated(entry.task) && !entry.task.wantsWorktree
            ? (paths) => claims.claim(rootId, { taskId: task.id, title: entry.task.title }, paths)
            : undefined,
        // 项目教训：每次查都读最新的（别的对话刚记的也能看到）；Agent 记的标上来源，用户在项目设置里复查
        lessons: task.projectId
          ? {
              list: async () => (await deps.projects.get(task.projectId))?.lessons ?? [],
              globals: readGlobalLessons,
              record: async (input) =>
                deps.recordLesson
                  ? deps.recordLesson(task.projectId, { ...input, source: 'agent', taskId: task.id })
                  : { ok: false, info: '这里记不了项目教训' },
            }
          : undefined,
        releaseFiles:
          task.parentTaskId && !isolated(entry.task) && !entry.task.wantsWorktree
            ? (paths) => claims.release(rootId, task.id, paths.length ? paths : undefined)
            : undefined,
        listConversations: async () => {
          const kids = (await store.list()).filter((x) => x.parentTaskId === entry.task.id)
          // 正在跑的对话用内存里的最新状态（标题只在创建时定，摘要随每一轮更新）
          return kids.map((k) => {
            const cur = live.get(k.id)?.task ?? k
            // 在做什么、在等什么、多久没新输出：父对话问「是不是卡住了」时不用再去猜
            // 不在内存里的子对话只有摘要（store.list 只留用户消息），算不出准确的「在做什么」
            const doing = live.has(k.id) ? childActivity(cur) : undefined
            return {
              id: cur.id,
              title: cur.title,
              // 状态用对话的 8 个状态说（见 ConvState），和子对话栏、状态上报是同一个结论
              status: convStateText(convState(childFacts(cur, { background: pendingJobs(cur.id) }))),
              busy: cur.working || startQueue.has(cur.id),
              // 已完成的报关键文件：父对话按它判断新问题该交给谁，比最后一句回复准
              summary:
                cur.resolved && cur.handoff?.files
                  ? `关键文件：${cur.handoff.files.replace(/\s+/g, ' ')}`
                  : cur.summary || lastReply(cur),
              at: cur.updatedAt,
              doing: childActivityText(doing),
              waiting: childWaitText(childWait(cur, { background: pendingJobs(cur.id), cliAlive: live.has(cur.id) })),
              lastActivityAt: childLastActivity(cur),
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
          // 第一条要求是父对话交代的：子对话里画成「接收消息 · 交代任务」，不当成用户说的话
          if (draft.messages[0]) draft.messages[0].peer = await peerOf(entry.task, 'parent', 'task', message)
          // 共用目录模式：父对话划好的范围先替它认领，别的子对话改这些文件要等它做完
          // 独立分支模式不认领：两个子对话可以同时改同一个文件，各在自己的 worktree 里改互不影响
          const sharedDir = project.childIsolation !== 'worktree'
          const got =
            sharedDir && files?.length
              ? claims.claim(entry.task.id, { taskId: subId, title: draft.title }, files)
              : { granted: [], held: [] }
          let both: { path: string; with: string }[] = []
          const round = (files ?? []).map(normClaimPath).filter(Boolean)
          if (round.length && !sharedDir) {
            const mine = scopes.get(entry.task.id) ?? scopes.set(entry.task.id, new Map()).get(entry.task.id)!
            const others: { title: string; files: string[] }[] = []
            for (const [otherId, s] of mine) {
              const other = live.get(otherId)?.task
              if (!other || !isolated(other)) {
                mine.delete(otherId)
                continue
              }
              others.push({ title: s.title, files: s.files })
              // 兄弟没声明范围、但已经改了这些文件：同样算重叠
              others.push({ title: other.title, files: other.changes.map((c) => c.path) })
            }
            both = scopeOverlaps(round, others)
            mine.set(subId, { title: draft.title, files: round })
          }
          const sub = await store.create({ ...draft, id: subId })
          const limit = await childLimit(entry.task.id)
          const wait = queued(entry.task.id) > 0 || slots.running(entry.task.id) >= limit
          void startChild(entry.task.id, sub, message, agents)
          return {
            ok: true,
            id: sub.id,
            title: sub.title,
            info: [
              wait
                ? `已新建子对话「${sub.title}」。同时执行的子对话已经到上限（${limit} 个），它在排队，前面的做完一个就开始`
                : `已新建子对话「${sub.title}」，它在后台执行，完成后会回报到这里`,
              ...childFilesInfo({
                isolation: sharedDir ? 'claim' : 'worktree',
                granted: got.granted,
                held: got.held,
                both,
              }),
            ]
              .filter(Boolean)
              .join('\n'),
          }
        },
        sendToConversation: async (id, message) => {
          // 父对话交给已有子对话：子对话里画成「接收消息 · 交代任务」，不当成用户说的话
          const r = await sendToChild(entry.task.id, id, message, undefined, 'task')
          // 交给子对话就算回答了它的提问：父对话里的提问卡片收起
          if (r.ok && settleAsks(entry.task, id, message, 'parent')) entry.rev++
          return r
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
          alert: makeAlert('error', (e as Error).stack ?? (e as Error).message, 'panel'),
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
        // 工作流跑完（成功或失败）才有结果可看，这时起标题
        if (!prewarm) nameOnce(entry.task, startedRun?.cli ?? '')
        // 子对话这一轮结束了：释放认领的文件，查一下和同时在改的兄弟子对话有没有改到同一个文件
        if (entry.task.parentTaskId) {
          claims.release(entry.task.parentTaskId, task.id)
          if (!prewarm) await checkCollisions(entry.task).catch(() => {})
        }
        // 更新摘要并回报父对话（父对话卡片和消息流据此显示进度）
        if (!prewarm && entry.task.parentTaskId) {
          entry.task.summary = lastReply(entry.task)
          // 这一轮结束：消息立即落盘，不等合并窗口（进程保活等下一句时这可能是最后一次写）
          await flush(keepTime, true)
          await reportToParent(entry.task)
        } else await flush(keepTime, true)
        // 只删自己的执行位：这一轮收尾时如果已经有新的一轮占住了，不能把它删掉
        release(entry)
        // 整轮结束了，没被节点取走的补充不会再有人取
        forgetNotes(task.id)
        // 这一轮顺利完成：执行中收不下的消息，马上开始新一轮接着处理；失败或暂停时消息留在对话里等用户决定
        if (entry.task.status === 'done' && hasHeld(task.id) && !shuttingDown)
          await followUp(task.id).catch((e) => console.error(`接着处理执行中收到的消息失败：${(e as Error).message}`))
        else if (entry.task.status !== 'done') {
          // 这一轮没能正常结束（失败、被停止）：排着的消息不会再被自动处理了。
          // 在对话里把它们改成「没送出去」，用户才知道要重新发一次，而不是一直等着
          const lost = dropHeld(task.id)
          if (lost.length) {
            const at = new Date().toISOString()
            for (const m of lost)
              for (const x of entry.task.messages)
                if (x.id === m.id && x.role === 'user') x.delivery = { how: 'lost', at }
            await store
              .update(task.id, entry.task)
              .catch((e) => log.warn('task', '标记没送出去的消息失败', { task: task.id, error: (e as Error).message }))
          }
        }
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
   * placed：附件已经拷进任务目录的那一份（只给 CLI）；记进对话的永远是 msg.attachments 里的原路径。
   */
  async function followUp(
    id: string,
    msg?: {
      text: string
      attachments: Attachment[]
      placed?: Attachment[]
      recorded?: boolean
      panel?: TaskMessage['panel']
      /** 子对话状态上报、收尾请求：是哪个子对话、什么状态（见 TaskMessage.child） */
      child?: TaskMessage['child']
      /** 另一个对话发来的：界面画成「接收消息」（见 TaskMessage.peer） */
      peer?: TaskMessage['peer']
      /** 交给 CLI 的内容和对话里显示的不一样时（例如重启卡住的 CLI 时补上没被处理的那条）：交给 CLI 的这份 */
      prompt?: string
      /** 这条消息是怎么交给 CLI 的：新记一条时直接写上去，界面据此说「排到下一轮」这类事实（见 DeliveryHow） */
      delivery?: DeliveryHow
      /** 停下时独立分支里还有没提交的改动（见 stopWorktreeNote）：父对话里那一行直接写几个文件、目录在哪 */
      worktree?: TaskMessage['worktree']
    },
  ) {
    // 上一次收尾还在删独立分支的目录：等它结束再继续，不然它会在重建之后把新目录和同名分支删掉
    await completing.get(id)?.catch(() => {})
    const task = await store.get(id)
    if (!task) throw new Error('任务不存在')
    const got = reserve(task)
    // 已经有了执行位：并发进来的两条消息只能有一条启动，另一条交给路由按 409 处理
    if (!got.fresh) throw new TaskBusyError('任务正在执行，请等它完成或先停止')
    const entry = got.value
    const next = entry.task
    let m = msg
    if (!m) {
      const q = takeHeld(id)
      if (!q) {
        release(entry)
        return next
      }
      m = { text: q.text, attachments: q.attachments, recorded: true }
      // 这一轮已经结束、马上按新的一轮交给 CLI：把消息上的交付状态从将来的「结束后自动处理」改成实际发生的事
      const was = next.messages.find((x) => x.id === q.id && x.role === 'user')
      if (was) was.delivery = { how: 'next', at: new Date().toISOString() }
    }
    const expanded = await expandForWorkflow(next, m.text)
    dropEndNotes(next)
    // 已完成的子对话又被继续：重新算进行中，这次的改动要再合一次才算完成
    if (next.parentTaskId && next.resolved) {
      next.resolved = false
      // 上次的上下文大：开新会话只带交接摘要，不把上次的工具输出全读一遍（见 ADR 0007）。
      // 旧会话的位置还记在各条消息的轮次上，要完整过程时用户可以回退到旧消息接回去
      if (!next.rewind && wantsHandoff(next.usage.agents[next.agentId]?.context, !!next.handoff?.text)) {
        next.rewind = { session: '', through: null, latest: false, summary: next.handoff!.text }
        log.info('task', '叫醒已完成的子对话：上下文大，开新会话带交接摘要', {
          task: id,
          context: next.usage.agents[next.agentId]?.context,
        })
      }
      // 又要接着做：再完成一次时该重新上报父对话
      reportedDone.delete(id)
      mergeNudged.delete(id)
    }
    // 请过收尾又开始干活（父对话退回、用户追加要求）：收尾请求作废，做完要重新请求；正在合并的不动
    // （记录上是 merging、内存里却没在合并的是残留：旧版本完成时没清掉，留着它 submit_merge 会一直被拒）
    if (next.wrapRequest && !merging.has(id)) {
      if (next.wrapRequest.state === 'requested')
        markWrapUp(next, 'merge', 'running', '又有新的要求：做完、验证后再请父对话收尾')
      next.wrapRequest = undefined
      reportedState.delete(id)
    }
    // 这条消息新记进对话时一并记下交付方式和独立分支的改动情况：界面读它就能说清「已排到下一轮」「N 个文件未提交」
    const stamp = {
      ...(m.delivery ? { delivery: { how: m.delivery, at: new Date().toISOString() } } : {}),
      ...(m.worktree ? { worktree: m.worktree } : {}),
    }
    // 独立分支的工作区被回收后又被继续：先建回来，附件落盘和这一轮执行才有目录
    const project = next.projectId ? await deps.projects.get(next.projectId) : null
    const restoreErr = project ? await restoreWorktree(next, project) : ''
    if (restoreErr) {
      if (!m.recorded) {
        next.messages.push({
          id: randomUUID(),
          role: m.panel ? 'system' : 'user',
          agentId: '',
          step: '',
          text: m.text,
          ...(m.panel ? { panel: m.panel } : {}),
          ...(m.child ? { child: m.child } : {}),
          ...(m.peer ? { peer: m.peer } : {}),
          ...(expanded ? { prompt: expanded } : {}),
          tools: [],
          ...(m.attachments.length ? { attachments: m.attachments } : {}),
          ...stamp,
          at: new Date().toISOString(),
        })
      }
      recordWorktreeError(next, restoreErr)
      await store.update(id, next)
      release(entry)
      return next
    }
    // 附件拷进这个任务的执行目录，交给 Agent 的是这一份（对话里显示、导出仍用原来的那份）
    const placed = m.placed ?? (await placeInTask(next, m.attachments))
    if (!m.recorded) {
      next.messages.push({
        id: randomUUID(),
        role: m.panel ? 'system' : 'user',
        agentId: '',
        step: '',
        text: m.text,
        ...(m.panel ? { panel: m.panel } : {}),
        ...(m.child ? { child: m.child } : {}),
        ...(m.peer ? { peer: m.peer } : {}),
        ...(expanded ? { prompt: expanded } : {}),
        tools: [],
        ...(m.attachments.length ? { attachments: m.attachments } : {}),
        ...stamp,
        at: new Date().toISOString(),
      })
    }
    try {
      return await start(
        entry,
        withAttachments(m.prompt || expanded || m.text, placed),
        false,
        await deps.agents.list(),
      )
    } catch (e) {
      release(entry)
      throw e
    }
  }

  /**
   * 一条消息交给正在跑的任务，先试能实时送到 CLI 的办法：
   * CLI 正停在等下一句 → 直接交回同一个进程；支持插话 → 插话；
   * 能用面板工具取补充 → 登记给它取；都收不下就记下来，这一轮结束后马上开始新一轮。
   * 返回的 how 是这条消息实际去了哪里：调用方把它落到那条消息上，界面才知道该说「插进当前轮」还是「排到下一轮」
   */
  async function deliver(
    entry: Live,
    msg: TaskMessage,
    text: string,
    attachments: Attachment[],
    placed: Attachment[] = attachments,
  ): Promise<{ task: Task; how: DeliveryHow }> {
    const task = entry.task
    // CLI 收到上一条后一直没有任何输出（卡住了）：再往这一轮里插话也不会有回应，停掉它、接回会话重开
    const stuck = stalledTurn(task.id)
    if (stuck) return restartStalled(entry, msg, text, placed, stuck.input)
    // 交给 CLI 的是拷进任务目录的那一份（placed）；记进对话的 msg 仍是用户原来的附件，缩略图从附件目录读
    const wait = deliverWait(task, msg, placed)
    if (wait === 'ok') {
      task.updatedAt = new Date().toISOString()
      markDelivery(task, msg, 'wait')
      await store.update(task.id, task)
      return { task, how: 'wait' as const }
    }
    // 等着的还是旧 CLI：让它退出，按输入框里现在的选择重新开始这一轮
    if (wait === 'stale') {
      entry.restart = true
      if (entry.done) await entry.done
      const next = live.get(task.id)
      if (next) {
        if (deliverWait(next.task, msg, placed) === 'ok') {
          next.task.updatedAt = new Date().toISOString()
          markDelivery(next.task, msg, 'wait')
          await store.update(task.id, next.task)
          return { task: next.task, how: 'wait' as const }
        }
        return intoTurn(next, msg, text, placed)
      }
      // 这次要记进对话的是用户原来的附件（上传目录的绝对路径），拷进任务目录的那份只给 CLI。
      // panel / child / peer / worktree 也要带过去：不带的话面板推给父对话的那条（例如「子对话停止 + 未提交改动」）
      // 会变成一条普通用户消息，行上的「N 个文件未提交」和「继续」都没了
      return {
        task: await followUp(task.id, {
          text,
          attachments: msg.attachments ?? [],
          placed,
          delivery: 'next',
          ...(msg.panel ? { panel: msg.panel } : {}),
          ...(msg.child ? { child: msg.child } : {}),
          ...(msg.peer ? { peer: msg.peer } : {}),
          ...(msg.worktree ? { worktree: msg.worktree } : {}),
        }),
        how: 'next' as const,
      }
    }
    return intoTurn(entry, msg, text, placed)
  }

  /**
   * 重启卡住的 CLI：停掉这一轮（原因记成 stalled，不说成用户暂停），接回原会话开新的一轮，
   * 把没得到回应的那条和新消息一起交过去；对话里只显示新消息本身
   */
  async function restartStalled(entry: Live, msg: TaskMessage, text: string, placed: Attachment[], missed: string) {
    const id = entry.task.id
    log.warn('task', 'CLI 没有响应，停掉它接回会话重开', { task: id })
    // 「没有响应」那一行记下结果：停下的说明是临时的，开新一轮时会被去掉
    for (const m of entry.task.messages)
      if (m.alert?.kind === 'no_response' && !m.alert.resolved)
        m.alert = { ...m.alert, resolved: t('收到新消息时停掉了卡住的 CLI，接回会话重新开始') }
    stopTask(id, 'stalled')
    if (entry.done) await entry.done
    // 停下的这段时间里别的消息已经开了新的一轮：交给那一轮
    const next = live.get(id)
    if (next) return deliver(next, msg, text, [], placed)
    const prompt =
      `（面板说明：上一条交给你的消息你一直没有回应，CLI 卡住了，面板已经停掉它并接回这个会话。没被处理的那条是：\n${missed}\n\n` +
      `先处理它，再处理下面这条新消息。）\n\n${text}`
    const task = await followUp(id, {
      text: msg.text,
      attachments: msg.attachments ?? [],
      placed,
      ...(msg.panel ? { panel: msg.panel } : {}),
      ...(msg.child ? { child: msg.child } : {}),
      ...(msg.peer ? { peer: msg.peer } : {}),
      prompt,
      delivery: 'restart',
    })
    return { task, how: 'restart' as const }
  }

  /**
   * 把交付结果记到那条消息上（界面按它说清消息去了哪里）。按 id 找：插话那条记在节点的消息上，
   * 是异步之前就 push 进去的一份拷贝，改手里这个 msg 不会反映到对话里
   */
  function markDelivery(task: Task, msg: TaskMessage, how: DeliveryHow) {
    const at = new Date().toISOString()
    for (const m of task.messages)
      if (m.id === msg.id && m.role === 'user') {
        m.delivery = { how, at }
        return
      }
  }

  /** CLI 没在等下一句：插话 → 登记给 read_user_notes → 记下来这一轮结束后接着处理 */
  async function intoTurn(entry: Live, msg: TaskMessage, text: string, attachments: Attachment[]) {
    const task = entry.task
    const how = await steerTask(task, withAttachments(text, attachments), msg)
    if (!how) {
      task.messages.push(msg)
      holdForNextTurn(task.id, msg)
    }
    markDelivery(task, msg, how || 'held')
    task.updatedAt = new Date().toISOString()
    await store.update(task.id, task)
    return { task, how: how || ('held' as const) }
  }

  const stopTask = (id: string, reason: StopReason) => {
    // 停止、删除后不会再开始排队的子对话：让等着的调用拿到明确失败，不然它们会一直挂着
    slots.drain(id, new Error('任务已停止，排队的子对话不再开始'))
    // 只有用户自己停止、归档时名下子对话才一起结束（原因记成 parent，不是用户暂停）。
    // 父对话自己的 CLI 已经退了（这一轮说完、只剩子对话在跑）也要停：在这里先做，不受下面「没在跑」的提前返回影响。
    // 闲置回收、换 CLI、打断重发、CLI 卡住重开只是父对话自己这一轮的事：子对话有自己的进程和状态，
    // 还在跑的不能跟着被杀，做完结果照样推回父对话（见 ADR 0010）
    if (reason === 'user' || reason === 'archive') void closeChildren(id)
    const e = live.get(id)
    if (!e) return
    // 已经在停了（停止按钮连点、closeChildren 先停一次再补一次）：别再推一条一模一样的提示
    const firstStop = !e.stop
    e.stop = true
    // 只有用户按的暂停才标成 'user'，其余调用点必须传清是谁结束的，界面才能不把它说成「已暂停」
    e.stopReason = reason
    // CLI 卡住了（没有响应）：不理会中断，直接结束进程，别让用户的新消息再等上几秒
    e.abort.abort(reason === 'stalled' ? HARD_STOP : undefined)
    // 用户按的暂停、父对话收尾、打断并重发：独立分支里没提交的改动会留在那儿，
    // 现在就在父对话里点明，不留到用户自己发现
    if (firstStop && (reason === 'user' || reason === 'parent' || reason === 'supersede'))
      void stopWorktreeNote(e.task, reason)
  }

  /**
   * 这个对话还在运行，不能回收、失活（ADR 0010）：两个回收时长、保活上限都先问它，页面开着还是切到后台都一样。
   * 判定就是 convActive（自己在跑、在等子任务 / 子对话 / 后台命令 / 工作流，有没回复的提问和请求），
   * 再加上这一轮没收尾、在预热、还有排队的消息。只有停在等下一句、什么都没挂着的才是空闲会话。
   * 名下子对话只算还在运行的（childActive）：父对话被回收不会再连带停掉子对话，闲着的子对话不用护着它
   */
  function keepAliveBusy(id: string): boolean {
    const entry = live.get(id)
    if (!entry) return false
    if (startQueue.has(id) || hasHeld(id)) return true
    const children = [...live.values()].filter(
      (e) => e !== entry && e.task.parentTaskId === id && childActive(e.task),
    ).length
    return keepAliveBusyOf(entry.task, { background: pendingJobs(id), children })
  }

  /**
   * 停下时独立分支里还有没提交的改动：在父对话里点明几个文件没提交、改动在哪个目录，带着「继续」入口。
   * 不自动提交、也不清理目录（那是用户和子对话的改动），只把事实说清楚，接着做还是合并由用户定。
   * reason：被打断重发（supersede）紧接着就会开新的一轮，不能说成「已停下」，否则父对话会以为还要点「继续」
   */
  async function stopWorktreeNote(tk: Task, reason: StopReason) {
    const wt = tk.worktree
    if (!tk.parentTaskId || !tk.projectId || wt?.state !== 'active') return
    const project = await deps.projects.get(tk.projectId)
    if (!project) return
    // 和 /children 的同一个查询一样走并发闸：父对话停止时 closeChildren 会给每个子对话各触发一次
    const st = await gitGate(() => worktreeStatus(project.path, wt)).catch(() => null)
    if (!st?.dirty) return
    const how = { title: tk.title, id: tk.id, branch: wt.branch, n: st.dirty, path: wt.path }
    const text =
      reason === 'supersede'
        ? t(
            '【子对话被打断】「{title}」（id {id}）被新消息打断、马上接着做，独立分支「{branch}」里还有 {n} 个文件没有提交，目录：{path}。这些改动都还在。',
            how,
          )
        : t(
            '【子对话停止】「{title}」（id {id}）已停下，独立分支「{branch}」里还有 {n} 个文件没有提交，目录：{path}。这些改动都还在：可以让它继续接着做，或者合并、删除这个独立分支。',
            how,
          )
    await noteParent(
      tk.parentTaskId,
      tk,
      text,
      text,
      undefined,
      // 被打断的那条马上就在跑下一轮，不要说成「已中断」
      { id: tk.id, title: tk.title, state: reason === 'supersede' ? 'running' : 'stopped' },
      undefined,
      { dirty: st.dirty, path: wt.path, branch: wt.branch },
    ).catch((e) => log.warn('task', '子对话停止时没能提示父对话', { task: tk.id, error: (e as Error).message }))
  }

  /**
   * 保活会话的全局上限：CLI 回复完停在等下一句时会留一个进程，页面开着的不算（用户马上回来）。
   * 没人在看又超过设置里的上限时，结束最久没用的那个（reason='idle'），
   * 下次打开靠 --resume 续接，代价是冷启动一次。
   * 只收空闲会话：正在跑的对话（不管页面开着还是切到后台）不占名额也不被选走
   */
  async function enforceKeepAlive(selfId = '') {
    const { keepAliveLimit } = await getSettings()
    if (!keepAliveLimit) return
    // 还在运行的对话（自己或名下子对话、子任务、后台命令没完，提问没回复，排着队）不回收：只收真闲着的。
    // 判定和宽限到期时是同一个（keepAliveBusy → convActive）
    const pool = [...live.values()].map((e) => e.task).filter((t) => !queued(t.id) && !keepAliveBusy(t.id))
    // 只放过前台正开着的页面：切走后还在宽限期里的也算进上限（hasViewer 会把它们都当成有人在看，
    // 一小时内点开过的对话全部豁免，上限形同虚设）。这里排掉的只有 running 的，见 keepAliveVictims
    // 刚进入保活的那个也算进上限（+1）；它其实是 busy（后台命令还在跑）时不占名额，别多收一个空闲会话
    const exceptId = selfId && !keepAliveBusy(selfId) ? selfId : ''
    const victims = keepAliveVictims(pool, keepAliveLimit, exceptId, isViewing)
    for (const id of victims) {
      log.info('task', '保活的会话超过上限，结束最久没用的', { task: id, limit: keepAliveLimit })
      stopTask(id, 'idle')
    }
  }

  // ---- 进程与内存：标题栏下拉里的进程列表、关闭、清理、内存曲线 ----

  /** 对话树最上层：子对话、子任务的进程都算进父对话的统计 */
  const rootIdOf = (tk: Task) => tk.rootTaskId || tk.id

  /** 进程面板判断「任务还活着」：还在内存里执行、保活等下一句，或者排队等名额 */
  const taskAlive = (id: string) => live.has(id) || startQueue.has(id)

  /** 这个对话的进程树（登记的主进程 + 它起的子进程，MCP 服务都算进去）和内存合计 */
  async function processPanel(tk: Task) {
    const rootId = rootIdOf(tk)
    const entries = trackedClis().filter((e) => e.owner?.rootTaskId === rootId)
    const map = await processSnapshot()
    const now = Date.now()
    const processes: TaskProcess[] = []
    const pids = new Set<number>()
    for (const e of entries) {
      // 进程已经结束、登记还留着：顺手清掉，别让列表一直挂着一个不存在的 pid
      if (map && !map.has(e.pid)) {
        untrackCliProcess(e.pid)
        continue
      }
      const status = trackedStatus(e, taskAlive, now)
      for (const pid of map ? subtree(e.pid, map) : [e.pid]) {
        if (pids.has(pid)) continue
        pids.add(pid)
        const node = map?.get(pid)
        const startedAt = node?.startedAt ?? (pid === e.pid ? e.startedAt : null)
        processes.push({
          pid,
          parentPid: node && pid !== e.pid ? node.ppid : null,
          command: commandSummary(node?.argv ?? (pid === e.pid ? e.argv : '')),
          ownerTaskId: e.owner?.taskId ?? '',
          ownerTitle: e.owner?.title ?? '',
          startedAt,
          durationMs: startedAt ? Math.max(0, now - startedAt) : null,
          rss: node?.rss ?? null,
          status,
          kind: pid === e.pid ? 'cli' : 'child',
        })
      }
    }
    // 没有进程时是 0（这个对话确实没在跑），系统信息取不到时是 null（界面显示「未知」）
    const cliMemory = !map ? null : pids.size ? sumRss(pids, map) : 0
    const serverMemory = process.memoryUsage().rss
    return {
      sampledAt: now,
      processes: processes.sort((a, b) => (a.kind === b.kind ? a.pid - b.pid : a.kind === 'cli' ? -1 : 1)),
      cliMemory,
      serverMemory,
      totalMemory: cliMemory === null ? null : cliMemory + serverMemory,
      unavailable: map ? '' : t('取不到系统进程信息（权限不足或命令不可用）'),
    }
  }

  /** 这个对话能动的 pid：登记的进程和它们的整棵子树 */
  async function allowedPids(rootId: string) {
    const entries = trackedClis().filter((e) => e.owner?.rootTaskId === rootId)
    const map = await processSnapshot()
    const out = new Set<number>()
    for (const e of entries) for (const pid of map ? subtree(e.pid, map) : [e.pid]) out.add(pid)
    return out
  }

  const routes = new Hono()

  routes.get('/', async (c) => {
    const pid = c.req.query('projectId')
    // 列表只给摘要：侧栏和项目首页不需要消息内容，任务多了也不会越来越慢
    const all = (await store.list()).map((t) => idle(live.get(t.id)?.task ?? t))
    // 子对话还在运行时父对话也算在运行：一次算好所有父对话名下的数量，前端不用再为每个任务发请求。
    // 口径和标题栏、能不能回收是同一个（childActive）：等结果、等回答的子对话也算，不只看 working
    const kids = new Map<string, number>()
    for (const k of all) {
      if (!k.parentTaskId || !childActive(k)) continue
      kids.set(k.parentTaskId, (kids.get(k.parentTaskId) ?? 0) + 1)
    }
    let list = all.map((t) => {
      const n = kids.get(t.id) ?? 0
      // 带上还在跑的后台命令：交出去的命令没跑完，列表里这个对话就还在「等结果」，不能显示成做完了
      return taskSummary(withJobs(t.parentTaskId ? t : { ...t, childrenWorking: n }))
    })
    // 子对话不进入项目列表：按 parentId 查询时才返回它们
    const parent = c.req.query('parentId')
    list = parent ? list.filter((t) => t.parentTaskId === parent) : list.filter((t) => !t.parentTaskId)
    return c.json(pid ? list.filter((t) => t.projectId === pid) : list)
  })

  /** 子对话独立分支状态的缓存：子对话 id → 当时的子对话版本、问的时间和结果 */
  const worktreeSeen = new Map<
    string,
    { key: string; at: number; value: { merged: boolean; ahead: number; dirty: number } | null }
  >()
  const UNMERGED_TTL = 10_000
  /** 停下的子对话不会马上下一次：同一份状态留久一点，父对话页每 4 秒刷一次时不必一直跑 git */
  const STOPPED_TTL = 60_000
  /** 子对话栏查 git 的并发上限：几十个子对话时别一下子起上百个 git 进程 */
  const gitGate = createGate(4)

  /**
   * 子对话独立分支的实际情况（只问本地 git）：合没合回去、还有几个未提交的文件。
   * 没停的子对话只在「别的条件都满足」时才问：还在跑、计划没做完时本来就轮不到判完成，
   * 每 4 秒为它们多跑几次 git 不值得。
   * 已经停下 / 失败的例外：用户点了停止，最想知道的就是「改的东西还在不在」，
   * 这时候不管计划做没做完都要报出未提交的文件（界面靠它显示「N 个文件未提交 + 继续」）
   */
  async function childWorktree(tk: Task, project: Project | null) {
    if (!project || tk.worktree?.state !== 'active') return null
    const stopped = tk.status === 'stopped' || tk.status === 'failed'
    if (!stopped && childHoldsOf(tk, { background: pendingJobs(tk.id), merged: true }).length) return null
    // 子对话没变过就沿用刚问过的结果：父对话页每 4 秒刷一次子对话栏，每个做完的子对话要跑 4 条 git，
    // 子对话一多、再开着两个页面，就是每秒十几个 git 进程抢 CPU 和仓库的锁
    const key = `${tk.updatedAt}|${tk.status}|${tk.worktree.branch}|${tk.worktree.path}`
    const ttl = stopped ? STOPPED_TTL : UNMERGED_TTL
    const hit = worktreeSeen.get(tk.id)
    if (hit && hit.key === key && Date.now() - hit.at < ttl) return hit.value
    // git 读不出来时不当成没合并：这里只为了让没合回去的子对话不显示成已完成，不该反过来把它卡住
    const st = await gitGate(() => worktreeStatus(project.path, tk.worktree!)).catch(() => null)
    const value = st ? { merged: st.merged, ahead: st.ahead, dirty: st.dirty } : null
    worktreeSeen.set(tk.id, { key, at: Date.now(), value })
    // 顺手丢掉早就过期的记录，删掉的子对话不会一直留在这里
    if (worktreeSeen.size > 200)
      for (const [id, v] of worktreeSeen) if (Date.now() - v.at > STOPPED_TTL * 6) worktreeSeen.delete(id)
    return value
  }

  /** 子对话的独立分支还没合回父对话的分支（见 childHolds 的 unmerged） */
  async function childUnmerged(tk: Task, project: Project | null) {
    const st = await childWorktree(tk, project)
    return !!st && !st.merged
  }

  // 父对话的子对话卡片：标题、状态、摘要和最近更新时间
  routes.get('/:id/children', async (c) => {
    const parent = await current(c.req.param('id'))
    if (!parent) return bad(c, t('任务不存在'), 404)
    const project = parent.projectId ? await deps.projects.get(parent.projectId) : null
    const kids = (await store.list()).filter((t) => t.parentTaskId === parent.id)
    const items = await Promise.all(
      kids.map(async (t) => {
        const liveTask = live.get(t.id)?.task ?? t
        // 子对话栏、超时判定、计划面板都读这两份：同一处算出「在做什么」和「在等什么」
        // 不在内存里的子对话只有摘要（store.list 只留用户消息），算不出准确的「在做什么」
        const doing = live.has(liveTask.id) ? childActivity(liveTask) : undefined
        const pending = pendingJobs(liveTask.id)
        const open = openPlan(liveTask)
        // 独立分支的实际情况只问一次 git：既要说「没合回去」，也要说「还有几个文件没提交」
        const wt = await childWorktree(liveTask, project)
        return {
          id: liveTask.id,
          title: liveTask.title,
          status: liveTask.status,
          summary: liveTask.summary || lastReply(liveTask),
          working: liveTask.working,
          updatedAt: liveTask.updatedAt,
          // 进程还活着（预热、等下一句、正在执行）：列表默认只列这些，不用 status === 'running' 猜
          cliAlive: live.has(liveTask.id),
          // 排序按本次开启的时间：做完或停下后又接到新任务会开新的一轮，重新排到最前面
          startedAt: childStartedAt(liveTask),
          // 总览分组用：等用户确认的请求数、还在跑的后台命令数、独立 worktree 的分支
          requests: liveTask.requests.length,
          // 后台命令跑在服务端，CLI 只是在等结果：有这个就还当执行中，不能显示成已完成
          background: pending,
          // start_plan 启动的工作流运行还没跑完：「启动工作流」那一行工具调用早就返回了，不能凭它当结束
          workflow: runRunning(liveTask),
          // 它派出去的子任务还在跑：结果交回来它还要接着做，也不能算做完了
          helpers: helpersWorking(liveTask),
          // 计划没做完（如「计划 7/8」）：不算已完成，浮层里归「未完成」；带上正在做的那一步
          plan: open ? { ...open, step: doing?.plan?.title, child: doing?.plan?.child } : undefined,
          // 独立分支还没合回父分支：任务看起来做完了也不算完成（见 childWorktree）
          unmerged: !!wt && !wt.merged,
          // 分支目录里还有几个文件没提交：停下时行上直接写出来，并且给「继续」接着做
          dirty: wt?.dirty ?? 0,
          // 已经请父对话收尾、还没出结果：行上是「待收尾」
          wrapup: !!liveTask.wrapRequest && liveTask.wrapRequest.state !== 'failed',
          // 请用户选择、还没人回答的提问数：父对话的子对话栏里显眼地提示
          asking: liveTask.parentAsks?.length ?? 0,
          branch: liveTask.worktree?.branch ?? '',
          // 独立分支目录：停下时告诉用户改动在哪个目录里
          dir: liveTask.worktree?.path ?? '',
          activity: doing,
          // 最后有动静的时间：几分钟没有新输出、又不能用等待解释时，界面上标黄 / 标红
          lastActivityAt: childLastActivity(liveTask),
          // 在等什么（等用户回答、等后台命令、等子任务、等工作流、等下一句）：不是在跑也不是卡住
          waiting: childWait(liveTask, { background: pending, cliAlive: live.has(liveTask.id) }),
          // 用户标记的「解决」：列表归到「已完成」并加标记，和 status / working 都无关
          resolved: liveTask.resolved === true,
          // 停下的原因：任务本身就有，页面不用再为每个停下的子对话取一遍完整对话
          stopReason: idle(liveTask).stopReason ?? '',
        }
      }),
    )
    return c.json(items)
  })

  /** 对话设置里的「停止全部子对话」：正在执行的停下（输出和状态保留），等下一句的结束这一轮 */
  routes.post('/:id/children/stop', async (c) => {
    const parent = await current(c.req.param('id'))
    if (!parent) return bad(c, t('任务不存在'), 404)
    const kids = (await store.list()).filter((x) => x.parentTaskId === parent.id)
    const before = kids.filter((x) => live.has(x.id)).length
    await closeChildren(parent.id)
    await Promise.all(kids.map((k) => endBackground(k.id)))
    return c.json({ stopped: before })
  })

  /**
   * 终止对话派出的一个子任务（界面上的终止按钮）：还在跑的结束它的 CLI，还在排队的不再开始，
   * 按「已终止」交回给派它的对话；对话本身、别的子任务都不动
   */
  routes.post('/:id/subtasks/stop', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const stepId = typeof body?.step === 'string' ? body.step : ''
    const tk = await current(id)
    if (!tk) return bad(c, t('任务不存在'), 404)
    const step = tk.steps.find((s) => s.id === stepId && s.slot === 'sub')
    if (!step) return bad(c, t('找不到这个子任务'), 404)
    if (!stopHelper(id, step.id, '用户在界面上终止了这个子任务')) return bad(c, t('这个子任务已经结束了'), 409)
    log.info('task', '用户终止了子任务', { task: id, step: step.id })
    return c.json(await current(id))
  })

  /** 这个对话的进程列表和内存合计：标题栏下拉展开时才拉，收起时不请求 */
  routes.get('/:id/processes', async (c) => {
    const tk = await current(c.req.param('id'))
    if (!tk) return bad(c, t('任务不存在'), 404)
    return c.json(await processPanel(tk))
  })

  /** 关闭一个进程：只认这个对话进程树上的 pid，面板自己和用户自己开的进程都进不来 */
  routes.post('/:id/processes/:pid/kill', async (c) => {
    const tk = await current(c.req.param('id'))
    if (!tk) return bad(c, t('任务不存在'), 404)
    const pid = Number(c.req.param('pid'))
    if (!Number.isInteger(pid) || pid <= 0) return bad(c, t('进程号不对'))
    const allowed = await allowedPids(rootIdOf(tk))
    if (!allowed.has(pid)) return bad(c, t('这个进程不属于当前对话，不能从这里关闭'))
    killTree(pid)
    // 等一下再看：结束失败（权限不足、被系统占用）要把真实状态告诉用户，不能悄悄把登记删掉
    await new Promise((r) => setTimeout(r, 1200))
    if (isProcessAlive(pid)) return c.json({ ok: false, pid, error: t('进程还在，可能权限不足或被系统占用，稍后再试') })
    // 登记还在的话，下次刷新会显示成「已结束」：先去掉，界面只反映还活着的
    untrackCliProcess(pid)
    log.info('exec', '从进程面板关闭进程', { task: tk.id, pid })
    return c.json({ ok: true, pid, error: '' })
  })

  /**
   * 清理无效进程：只清面板登记过、任务已经不在跑的（登记残留）。
   * 用户确认列表里的 pid 传进来就只清这些；传空时清这个对话的全部残留
   */
  routes.post('/:id/processes/clean', async (c) => {
    const tk = await current(c.req.param('id'))
    if (!tk) return bad(c, t('任务不存在'), 404)
    const body = (await c.req.json().catch(() => ({}))) as { pids?: unknown }
    const only = Array.isArray(body.pids) ? body.pids.filter((x): x is number => Number.isInteger(x)) : []
    const roots = rootIdOf(tk)
    const map = await processSnapshot()
    const { targets, skipped, gone } = cleanableClis({
      entries: trackedClis(),
      map,
      aliveTask: taskAlive,
      rootTaskId: roots,
      only,
    })
    // 进程已经不在的登记顺手清掉（不算「结束」，界面照样显示成已结束）
    for (const pid of gone) untrackCliProcess(pid)
    for (const e of targets) killTree(e.pid)
    // 只把真的结束了的从登记里去掉；没结束的留在列表里并说明原因，用户可以再试
    if (targets.length) await new Promise((r) => setTimeout(r, 1200))
    const killed: number[] = []
    for (const e of targets) {
      if (isProcessAlive(e.pid)) {
        skipped.push({ pid: e.pid, reason: t('进程没有结束（可能权限不足）') })
        continue
      }
      killed.push(e.pid)
      untrackCliProcess(e.pid)
    }
    if (killed.length || gone.length) log.info('exec', '清理无效进程', { task: tk.id, 清理: killed, 登记残留: gone })
    return c.json({ killed, skipped, gone })
  })

  /**
   * AI 清理建议：把进程列表交给本机的 CLI，让它指出可以关掉的项和理由。
   * 只给建议，不杀任何进程；用户确认后前端再调清理接口
   */
  routes.post('/:id/processes/suggest', async (c) => {
    const tk = await current(c.req.param('id'))
    if (!tk) return bad(c, t('任务不存在'), 404)
    const panel = await processPanel(tk)
    const settings = await getSettings()
    const cliId = defaultCli(settings)
    const def = getCli(cliId)
    if (!def) return bad(c, t('没有可用的 CLI'))
    const cs = cliSettings(settings, cliId)
    const run = agentRun({ cli: cliId, model: '', effort: '' }, settings)
    const cwd = path.join(tmpdir(), 'agent-panel-process-review')
    await mkdir(cwd, { recursive: true })
    let text = ''
    const r = await invokeCli({
      cliId,
      command: cs.command,
      build: {
        model: run.model,
        effort: run.effort,
        // 只是看进程列表做判断，用 CLI 自己的只读权限
        permission: def.readOnly || cs.permission,
        extraArgs: cs.extraArgs,
      },
      cwd,
      env: childEnv(cs.env),
      input: buildSuggestPrompt(panel),
      timeoutMs: 120_000,
      onEvent: (ev) => {
        if (ev.type === 'text' || ev.type === 'text_delta') text += ev.text
      },
    })
    if (r.spawnError) return c.json({ suggestions: [], text: '', error: r.spawnError })
    const parsed = extractJson(text) as { kill?: unknown } | undefined
    const allowed = await allowedPids(rootIdOf(tk))
    const suggestions = (Array.isArray(parsed?.kill) ? parsed.kill : [])
      .map((x) => x as { pid?: unknown; reason?: unknown })
      .filter((x) => Number.isInteger(x.pid) && allowed.has(Number(x.pid)))
      .map((x) => ({ pid: Number(x.pid), reason: String(x.reason ?? '').slice(0, 200) }))
    // 没有解析出 JSON：把 CLI 的原文交给界面，用户自己看
    return c.json({ suggestions, text: text.slice(0, 4000), error: '' })
  })

  /** 内存曲线：按时间从旧到新，from/to 是 epoch ms（不传就是全部历史） */
  routes.get('/:id/memory', async (c) => {
    const tk = await current(c.req.param('id'))
    if (!tk) return bad(c, t('任务不存在'), 404)
    const from = Number(c.req.query('from') ?? '')
    const to = Number(c.req.query('to') ?? '')
    const points = summarize(loadHistory(), rootIdOf(tk), {
      from: Number.isFinite(from) && from > 0 ? from : undefined,
      to: Number.isFinite(to) && to > 0 ? to : undefined,
    })
    return c.json({ sampledAt: Date.now(), intervalMs: SAMPLE_INTERVAL_MS, capacity: HISTORY_CAPACITY, points })
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
      const jobKey = () =>
        background
          .list(id)
          .filter((j) => j.state === 'queued' || j.state === 'running')
          .map((j) => `${j.id}:${j.state}`)
          .join(',')
      // 名下子对话还在运行的数量也要比：子对话开始、做完不改父对话本身，标题栏的转圈要跟着变
      const liveKey = async () => `${jobKey()}|${await activeChildren(id)}`
      while (!closed) {
        // 没在执行的任务先只看任务本身的更新时间：完整对话在内存里只留十几个，被挤出去后
        // 每秒都 current() 一次就是每秒从磁盘重读、校验一遍几 MB 的对话；没变就不用读
        const e = live.get(id)
        if (!e && meta) {
          const head = await store.peek(id)
          if (head && `${head.updatedAt}|${await liveKey()}` === seen.slice(seen.indexOf('#') + 1)) {
            if (Date.now() - beat > 15_000) {
              await stream.writeSSE({ event: 'ping', data: '' })
              beat = Date.now()
            }
            await stream.sleep(1000)
            continue
          }
        }
        const cur = await current(id)
        if (!cur) {
          await send('gone', {})
          break
        }
        const t = await withLive(cur)
        // 没有变化时什么都不比较：长任务的消息很多，每次都逐条比较、序列化会拖慢整个服务。
        // 后台命令开始、结束、子对话开始做完都不一定改任务本身（对话空闲时），单独算进去
        const jobs = t.jobs?.map((j) => `${j.id}:${j.state}`).join(',') ?? ''
        // # 后面是不在执行时的比较键（只用任务本身的更新时间），上面那一步不读对话就能比
        const key = `${e ? `${e.rev}|${t.messages.length}` : t.messages.length}#${t.updatedAt}|${jobs}|${t.childrenWorking ?? 0}`
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
    return task ? c.json(await withLive(task)) : bad(c, t('任务不存在'), 404)
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
  routes.get('/:id/export', async (c) => {
    const id = c.req.param('id')
    const root = await store.get(id)
    if (!root) return bad(c, t('任务不存在'), 404)
    try {
      // 先按摘要找出整棵树的 id，再逐个读完整任务（导出时才读子对话的对话文件，平时不读）
      const ids = runTree(root, await store.list()).map((x) => x.id)
      const tree = (await Promise.all(ids.map((x) => (x === id ? root : store.get(x))))).filter((x): x is Task => !!x)
      const bundle = exportTaskTree(root, tree, await deps.agents.list(), c.req.query('app') ?? '')
      return c.json({ bundle, bytes: checkExportSize(bundle) })
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  })

  // 导入别人导出的任务：连同包里的子对话一起建成本机的只读任务，放进指定的项目（为空放进聊天）
  routes.post('/import', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { projectId?: string; bundle?: unknown } | null
    if (!body) return bad(c, t('不是有效的 JSON 文件'))
    const projectId = body.projectId ?? ''
    if (projectId && !(await deps.projects.get(projectId))) return bad(c, t('项目不存在'), 404)
    let created: Task[]
    try {
      const bundle = parseTaskExport(body.bundle)
      // 父任务和每个子对话各分配一个本机 id（父在前、子在后）；重复导入同一棵树也不会撞 id
      created = importTaskTree(bundle, projectId, [randomUUID(), ...bundle.children.map(() => randomUUID())])
    } catch (e) {
      return bad(c, (e as Error).message)
    }
    // 按父先子后的顺序落盘：子对话的 parentTaskId 指向的是前面的父任务
    const saved: Task[] = []
    for (const task of created) saved.push(await store.create(task))
    log.info('task', '导入任务', { task: saved[0].id, title: saved[0].title, children: saved.length - 1 })
    return c.json(saved, 201)
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
      if (input.agentId && !agents.some((a) => a.id === input.agentId)) return bad(c, t('请选择对话的角色'))
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
    // 这里是顶层对话选的独立分支（子对话由项目设置决定）：只看输入框的「独立分支」按钮，不看角色。
    // 勾了就在创建时建好（用户要求），父对话也一样，它的子对话从这个分支开出、合回这里
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
    return c.json(
      await start(reserve(task).value, withAttachments(expanded || input.prompt, placed), true, agents),
      201,
    )
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
    // 用户直接进子对话回复，就当作回答了它挂在父对话里的提问（不打断这次发送）
    await settleAskFromChild(id, text).catch((e) =>
      log.warn('task', '回答子对话时没能收起父对话的提问卡片', { task: id, error: (e as Error).message }),
    )
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
      stopTask(id, 'supersede')
    }
    // 刚执行完、还在落盘的任务：等它写完再接着跑
    prev = live.get(id)
    if (prev) await prev.done
    if (live.has(id)) return bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    try {
      return c.json(await followUp(id, { text, attachments }))
    } catch (e) {
      // 检查执行位和真正占到之间另一条请求先占了：按「正在执行」返回，不能冒成 500
      if (e instanceof TaskBusyError) return bad(c, t('任务正在执行，请等它完成或先停止'), 409)
      throw e
    }
  })

  /**
   * 执行位还占着、但这一轮已经结束（status 已标完 done、收尾还在落盘）时，预热不能直接把它原样返回：
   * 那样拿到的是 done，CLI 根本没启动。还在真跑（执行中 / 停在等下一句 / 正在预热）的才复用，
   * 收尾中的等它释放；等完之后又被新的一轮占住就返回那一份，没有就返回 undefined 走正常启动流程
   */
  async function reusedPrewarmEntry(id: string): Promise<Task | undefined> {
    const entry = live.get(id)
    if (!entry) return undefined
    const now = entry.task
    if (now.status === 'running' || now.awaitingUser || now.prewarming) return now
    await entry.done?.catch(() => {})
    return live.get(id)?.task
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
      // 能保活（keepAlive）的对话才值得先启动进程等着：不然预热了也用不上，每轮还是重启
      if (!def?.keepAlive) return task
      // Claude Code、Codex 有自己的协议，不走面板的等待工具
      if (def.rpc?.nativeAsk) return task
      if (!force && task.sessionCli && task.sessionCli !== run.cli) return task
      // 走到这里之前可能又有别的请求占住执行位：真在跑就复用，收尾中就先等它释放
      const again = await reusedPrewarmEntry(task.id)
      if (again) return again
      const got = reserve(task)
      entry = got.value
      // 另一个请求已经先占住（真正发消息或另一次预热）：复用它的执行位，不再开第二个 CLI
      if (!got.fresh) return entry.task
      return await start(entry, PREWARM_PROMPT, false, agents, undefined, false, true)
    } catch (e) {
      if (entry) release(entry)
      log.warn('task', '对话预热失败', { task: task.id, error: (e as Error).message })
      alertOn(task.id, 'cli_exit', t('提前启动 CLI 失败：发消息时会再启动一次，仍然失败会在这里报错'))(e)
      return task
    }
  }

  // 打开对话页时调用
  routes.post('/:id/prewarm', async (c) => {
    const id = c.req.param('id')
    // 看到 done 就立刻预热的请求会撞在「状态标完、执行位还没释放」的那几毫秒上：
    // 先等它收尾，再按正常流程启动，不要返回一份没启动的 done
    const reused = await reusedPrewarmEntry(id)
    if (reused) return c.json(reused)
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
    // 占执行位要在后面的 await 之前：否则两条「继续」请求会各自检查通过、各启动一遍
    const got = reserve(task)
    if (!got.fresh) return bad(c, t('任务正在执行'), 409)
    const entry = got.value
    const users = task.messages.filter((m) => m.role === 'user' && !m.step)
    try {
      // 停在某个节点结论上的工作流（例如前置检查不通过）也能继续：从那个节点重新检查
      const blocked = !!blockedStep(task, taskFlow(task, taskWorkflows(task, await deps.workflows.list()).workflow))
      if (task.status !== 'failed' && task.status !== 'stopped' && !blocked) {
        release(entry)
        return bad(c, t('只有失败或停止的任务可以继续'), 409)
      }
      // latest：改用现在的工作流（任务创建后工作流改过，想按新的流程接着跑）
      const { latest } = (await c.req.json().catch(() => ({}))) as { latest?: boolean }
      let fresh: Workflow | undefined
      if (latest && task.workflowId) {
        fresh = (await deps.workflows.get(task.workflowId)) ?? undefined
        if (!fresh) {
          release(entry)
          return bad(c, t('工作流已经被删除，只能按任务创建时的工作流继续'))
        }
      }
      dropEndNotes(entry.task)
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
      release(entry)
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

  /** 独立分支合回去的目录：子对话合进父对话的目录（父也在独立分支时是父的那个），顶层对话合进项目目录 */
  async function worktreeHome(tk: Task, project: Project) {
    const parent = tk.parentTaskId ? (live.get(tk.parentTaskId)?.task ?? (await store.get(tk.parentTaskId))) : null
    return parent ? (await taskDir(parent)) || project.path : project.path
  }

  /** 正在动手（不是停在等下一句）的对话不能动它的独立分支，免得 Agent 还在往里写 */
  const busyWith = (id: string) => !!live.get(id)?.task.working

  /**
   * 这个对话和它名下子对话的独立分支，带上 git 里的实际情况（有没有合进原分支、几个提交没合、几个文件没提交）。
   * 合并编译、AI 合并都会改变这些，所以每次现查，不存在任务上
   */
  routes.get('/:id/worktrees', async (c) => {
    const id = c.req.param('id')!
    const tk = await current(id)
    if (!tk) return bad(c, t('任务不存在'), 404)
    const project = tk.projectId ? await deps.projects.get(tk.projectId) : null
    const kids = (await store.list()).filter((x) => x.parentTaskId === id).map((k) => live.get(k.id)?.task ?? k)
    const list = [tk, ...kids].filter((x) => x.worktree)
    const items = await Promise.all(
      list.map(async (x) => {
        const wt = x.worktree!
        const st = project && wt.state === 'active' ? await worktreeStatus(project.path, wt).catch(() => null) : null
        return {
          taskId: x.id,
          title: x.title,
          child: x.id !== id,
          working: !!x.working,
          branch: wt.branch,
          baseBranch: wt.baseBranch,
          path: wt.path,
          state: wt.state,
          note: wt.note,
          home: project && wt.state === 'active' ? await worktreeHome(x, project) : '',
          exists: st?.exists ?? false,
          ahead: st?.ahead ?? 0,
          dirty: st?.dirty ?? 0,
          merged: st ? st.merged : wt.state === 'merged',
          // 已经合回去了却还留着目录（计划、后台命令、提问、这一轮还没完）：把原因带到分支状态行上
          holds:
            x.id === id
              ? undefined
              : childHoldsOf(live.get(x.id)?.task ?? x, {
                  background: pendingJobs(x.id),
                  merged: st ? st.merged : wt.state === 'merged',
                }),
        }
      }),
    )
    return c.json({ items })
  })

  /**
   * 合并独立分支：没提交的改动先提交到任务分支，再合进开分支的那个目录（原分支）。
   * 合完分支和目录都留着，对话还能接着在里面改；不要了再单独删除。
   */
  routes.post('/:id/worktree/merge', async (c) => {
    const id = c.req.param('id')!
    if (busyWith(id)) return bad(c, t('对话正在执行，等这一轮结束后再合并'), 409)
    const tk = await current(id)
    if (!tk) return bad(c, t('任务不存在'), 404)
    if (!isolated(tk)) return bad(c, t('这个任务没有待处理的独立分支'))
    const project = await deps.projects.get(tk.projectId)
    if (!project) return bad(c, t('任务所属的项目已经不存在'))
    // 子对话已经请父对话收尾：用户在界面上点合并就是替父对话收尾，走同一条路（合回、标完成、删分支）
    if (tk.parentTaskId && tk.wrapRequest?.state === 'requested') {
      const parent = await current(tk.parentTaskId)
      if (!parent) return bad(c, t('父对话已经不存在'))
      const r = await finishChild(parent, id)
      if (!r.ok) return c.json({ error: r.info, conflict: true }, 409)
      return c.json({ task: await current(id), into: tk.worktree!.baseBranch, overlap: [] })
    }
    const wt = tk.worktree!
    try {
      const { into, overlap, sides } = await mergeWorktree(
        project.path,
        wt,
        `Agent 面板：合并「${tk.title}」`,
        await worktreeHome(tk, project),
        true,
      )
      log.info('task', '合并了独立分支', { task: id, branch: wt.branch, into, overlap })
      // 同一个文件两边都改过时，git 可能自动合上、不报冲突：在对话里留一条，用户才知道要核对内容
      if (overlap.length) {
        const cur = (await store.get(id)) ?? tk
        const note =
          t(
            '这次合并里两边都改了这些文件：{list}。git 已经自动合并，但必须逐文件核对有没有盖掉对方的改动，把核对结论写进合并结论（对方为什么这么改见下面的提交记录）。',
            { list: overlap.join('、') },
          ) + (sides ? `\n\n${mergeSidesText(sides)}` : '')
        await store.update(id, {
          ...cur,
          messages: [
            ...cur.messages,
            {
              id: randomUUID(),
              role: 'system',
              agentId: '',
              step: '',
              text: note,
              tools: [],
              at: new Date().toISOString(),
            },
          ],
        })
      }
      return c.json({ task: await current(id), into, overlap, sides })
    } catch (e) {
      return c.json({ error: (e as Error).message, conflict: !!(e as { conflict?: boolean }).conflict }, 409)
    }
  })

  /** 删除独立分支：连目录和分支一起删；还没合并的改动就丢了（界面上先确认过） */
  routes.post('/:id/worktree/discard', async (c) => {
    const id = c.req.param('id')!
    if (busyWith(id)) return bad(c, t('对话正在执行，等这一轮结束后再删除独立分支'), 409)
    const tk = await current(id)
    if (!tk) return bad(c, t('任务不存在'), 404)
    if (!isolated(tk)) return bad(c, t('这个任务没有待处理的独立分支'))
    const project = await deps.projects.get(tk.projectId)
    if (!project) return bad(c, t('任务所属的项目已经不存在'))
    const wt = tk.worktree!
    const st = await worktreeStatus(project.path, wt).catch(() => null)
    const into = st?.merged ? wt.baseBranch : ''
    // 对话还停在等下一句：先结束这一轮，CLI 的工作目录马上就没了；下一轮按原目录开新会话
    const entry = live.get(id)
    if (entry) {
      if (!cancelWait(id)) stopTask(id, 'archive')
      await entry.done?.catch(() => {})
    }
    // 后台命令跑在这个目录里：先停掉并等进程退出，目录删掉后它的结果也没意义了
    await background.stop(id)
    try {
      await removeWorktree(project.path, wt, true)
    } catch (e) {
      return bad(c, (e as Error).message, 409)
    }
    const cur = (await store.get(id)) ?? tk
    const next = { ...wt, state: st?.merged ? ('merged' as const) : ('discarded' as const), note: into }
    return c.json(await store.update(id, { ...cur, worktree: next }))
  })

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

  // 回答子对话交给父对话决定的提问：直接把决定交给子对话，或者交给父对话的 AI 决定
  routes.post('/:id/child-asks/:mid', async (c) => {
    const body = z
      .object({ answer: z.string().default(''), delegate: z.boolean().default(false) })
      .safeParse(await c.req.json())
    if (!body.success) return bad(c, z.prettifyError(body.error))
    const answer = body.data.answer.trim()
    if (!answer && !body.data.delegate) return bad(c, t('回答是空的'))
    const r = await answerChildAsk(c.req.param('id'), c.req.param('mid'), answer, body.data.delegate)
    if ('error' in r) return bad(c, r.error ?? '')
    // 带上 nudge：交给父对话决定时到底叫没叫起来，界面据此显示结果或原因（不能只写日志）
    return c.json({ task: r.task, nudge: 'nudge' in r ? r.nudge : undefined })
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
    // 子对话标记完成：它的独立分支跟着删掉。改动还没合回原分支时不标，免得把没合的改动一起删了
    if (p.data.resolved === true && cur.parentTaskId) {
      // 父对话（或用户）点「标记完成」只是发起这一趟流转：判定和置完成在子对话那一侧，
      // 还有没收口的东西就拒绝并说清卡在哪一项，不在这里直接写子对话的最终状态
      const { holds, info } = await advanceChildTo(id)
      if (holds.length) return bad(c, info || childHoldText(holds), 409)
      Object.assign(cur, {
        resolved: true,
        worktree: (live.get(id)?.task ?? (await store.get(id)) ?? cur).worktree,
      })
    }
    // 取消完成：再完成一次时该重新上报父对话
    if (p.data.resolved === false && cur.parentTaskId) reportedDone.delete(id)
    // 归档：只拦正在执行这一轮的；CLI 只是活着（等下一句、预热）时照样归档，顺手结束这个进程和它名下的子对话
    if (p.data.archived === true && e) {
      if (e.task.working) return bad(c, t('对话正在执行，等这一轮结束或停止后再归档'), 409)
      if (!cancelWait(id)) stopTask(id, 'archive')
      else void closeChildren(id)
    }
    // 归档的对话不再接收结果：后台命令（连同名下子对话的）一起停掉
    if (p.data.archived === true) await endBackground(id)
    const beforeAgentId = cur.agentId
    const agentChanged = p.data.agentId !== undefined && p.data.agentId !== beforeAgentId
    const touchesRun =
      p.data.cli !== undefined || p.data.model !== undefined || p.data.effort !== undefined || agentChanged
    if (touchesRun && cur.mode !== 'chat') return bad(c, t('只有对话任务可以这样做'))
    const settings = touchesRun ? await getSettings() : undefined
    const agents = touchesRun ? await deps.agents.list() : undefined
    if (p.data.agentId && !agents?.some((a) => a.id === p.data.agentId)) return bad(c, t('找不到这个角色'))
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
    const { childRun, ...rest } = p.data
    Object.assign(task, rest)
    // null 表示改回按执行角色自己的配置
    if (childRun !== undefined) task.childRun = childRun ?? undefined
    // 用户自己起了名：之后不再自动换标题
    if (p.data.title !== undefined) task.autoTitle = false
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
    if (p.data.askUser === false) {
      autoAnswerQuestions(task)
      // 子对话已经问出去、还挂在父对话里的那些，也一起交给 AI：否则卡片仍停在「等你选择」
      await handChildAsksToParent(task, !!e?.task.working)
    }
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
        // 执行中改的：画成 AI 回复里的一行，不在回复中间插一条居中提示
        panel: 'note',
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
    // 正在回复这一轮、或者在等派出的子任务（它们跑在这个进程的这一轮里）：不能现在换进程；
    // 这一轮结束时 start 的收尾、下一条消息交付时都会按新的选择重开
    if (e?.task.working || (e && helpersWorking(e.task))) return c.json(task)
    // 空闲的常驻 CLI：让它结束，按新的选择重新预热，命令和上下文不再显示旧 CLI
    if (e) {
      e.restart = true
      const canceled = cancelWait(id)
      if (!canceled) stopTask(id, 'switch')
      if (!e.done) return c.json(task)
      await e.done
      // 子对话不跟着重启：它们有自己的 CLI 和模型，还在跑的被杀就是误杀
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
      rewind: { ...turnBefore(task, i), cut: removed.turn ?? null },
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
      autoTitle: false,
      // 消息 id 换新的，免得两个任务里的消息 id 相同
      messages: kept.map((m) => ({ ...m, id: randomUUID() })),
      // 下一条用户消息那一轮是丢掉的第一轮：只能分叉到某一轮之前的 CLI 按它截
      rewind: { through, session, latest, cut: next < 0 ? null : (task.messages[next].turn ?? null) },
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
    const got = reserve(task)
    if (!got.fresh) return bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    const entry = got.value
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
      release(entry)
      throw e
    }
  })

  // 审查改动：Codex 用自己的审查模式，其他 CLI 按审查的要求跑一轮；只审查，不改文件
  routes.post('/:id/review', async (c) => {
    const task = await idleTask(c, false)
    if (task instanceof Response) return task
    // 占执行位放在检查目录这些 await 之前：两条「审查」请求不会各自通过检查再各启动一遍
    const got = reserve(task)
    if (!got.fresh) return bad(c, t('任务正在执行，请等它完成或先停止'), 409)
    const entry = got.value
    const body = (await c.req.json().catch(() => ({}))) as { base?: string }
    const target = body.base ? { type: 'base' as const, branch: body.base } : { type: 'uncommitted' as const }
    if (!(await taskDir(task)) || (await gitNumstat(await taskDir(task), '').catch(() => null)) === null) {
      release(entry)
      return bad(c, t('项目不是 git 仓库，没法审查改动'))
    }
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
      release(entry)
      throw e
    }
  })

  /** 用户停止这个对话：停止按钮、提问窗口的关闭都走这里 */
  async function userStop(id: string) {
    // 用户点「暂停」是唯一标成 user 的路径：别处停任务必须写清是谁结束的（见 StopReason）
    stopTask(id, 'user')
    // 还在等回答的提问、确认马上作废并落盘：不然返回的任务还带着它们，提问窗口关不掉。
    // 停止是停掉这个对话附属的一切：名下子对话的提问、确认、请用户决定的选择也一起作废
    const kids = (await store.list()).filter((x) => x.parentTaskId === id)
    for (const tid of [id, ...kids.map((k) => k.id)]) {
      const e = live.get(tid)
      const tk = e?.task ?? (await store.get(tid))
      if (!tk) continue
      const asked = !!tk.parentAsks?.length
      if (asked) tk.parentAsks = []
      if (!dropRequests(tk) && !asked) continue
      tk.updatedAt = new Date().toISOString()
      if (e) {
        trackWait(e.task)
        e.rev++
      }
      await store.update(tk.id, tk)
    }
    // 停止就是这个对话先别干了：它和名下子对话的后台命令一起停掉，不然跑完的结果推回来又会开新的一轮
    void endBackground(id)
  }

  routes.post('/:id/stop', async (c) => {
    const id = c.req.param('id')
    await userStop(id)
    // 强制停止：连 CLI 进程一起结束。平时停止只收这一轮，等下一句的进程留着（下一句直接交给它）；
    // 进程不该再留着时（卡住、换机器前的清理）用这个
    if (c.req.query('force')) {
      cancelWait(id)
      forgetNotes(id)
    }
    return c.json(await current(id))
  })

  // 子对话请用户决定的提问，用户点了关闭：这些提问不回答，子对话终止。
  // 父对话里的提问卡片记成「不回答」，它的 AI 也从收件箱知道，不会再替用户决定
  routes.post('/:id/parent-asks/close', async (c) => {
    const id = c.req.param('id')
    const e = live.get(id)
    const child = e?.task ?? (await store.get(id))
    if (!child) return bad(c, t('任务不存在'), 404)
    const asks = child.parentAsks ?? []
    if (asks.length && child.parentTaskId) {
      const pe = live.get(child.parentTaskId)
      const parent = pe?.task ?? (await store.get(child.parentTaskId))
      if (parent) {
        settleAsks(parent, id, t('不回答，终止了子对话'), 'user', undefined, true)
        parent.inbox = parent.inbox.filter((x) => !(x.from === id && x.text.startsWith('（提问）')))
        parent.inbox.push({
          from: id,
          title: child.title,
          text: '（用户不回答你收到的提问，终止了这个子对话，不用再替用户决定）',
          at: new Date().toISOString(),
        })
        parent.updatedAt = new Date().toISOString()
        if (pe) pe.rev++
        await store.update(parent.id, parent)
      }
    }
    // 子对话这边马上去掉：settleAsks 收起弹窗是异步的，返回的任务里不能再带着它
    child.parentAsks = []
    child.updatedAt = new Date().toISOString()
    if (e) e.rev++
    await store.update(child.id, child)
    // 终止：连等下一句的 CLI 进程一起结束（同强制停止），子对话这一轮多半已经说完、停在等回答
    await userStop(id)
    cancelWait(id)
    forgetNotes(id)
    return c.json(await current(id))
  })

  routes.delete('/:id', async (c) => {
    const id = c.req.param('id')
    // 删父对话时把它的子对话一起删掉，不留孤儿
    const kids = (await store.list()).filter((x) => x.parentTaskId === id)
    stopTask(id, 'archive')
    forgetNotes(id)
    // 等后台命令的进程真正退出再删目录：Windows 上进程占着目录删不掉
    await endBackground(id)
    const task = await store.get(id)
    if (!task || !(await store.remove(id))) return bad(c, t('任务不存在'), 404)
    forgetPresence(id)
    background.forget(id)
    const dropped = [task]
    for (const k of kids) {
      stopTask(k.id, 'parent')
      forgetNotes(k.id)
      background.forget(k.id)
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
    /** 启动时清理没有任务在用的附件 */
    async cleanupUploads() {
      const all = await store.list()
      await cleanupUploads(new Set(all.flatMap((t) => [...uploadDirs(t)])), {
        keepNames: new Set(all.flatMap((t) => [...uploadNames(t)])),
      })
    },
  }
}
