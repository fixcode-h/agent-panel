import type { TurnInfo } from '../exec/turn-info.ts'
import type { Hono, Context } from 'hono'
import type {
  Task,
  Agent,
  AskKind,
  Attachment,
  Project,
  ProjectCategory,
  PeerFrom,
  PeerKind,
  Workflow,
  AlertKind,
} from '../../shared/schema.ts'
import type { LessonDraft } from '../lessons.ts'
import type { Lister, Live } from './types.ts'
import type { createTaskStore } from '../task-store.ts'
import type { worktreeStatus } from '../exec/worktree.ts'
import type { IntegrateKind, IntegrateResult } from '../exec/worktree-integrate.ts'
import type { createClaims } from '../claims.ts'

/**
 * tasksApi 闭包里、被 server/tasks/ 下各模块用到的名字（值在 server/tasks.ts 的 scope 对象里，取值时才读）。
 * 模块要用闭包里的新名字时：在这里加一项类型，在 scope 对象（lazyScope）里加一个同名取值函数（let 变量写成 [取值, 写入]）。
 */
export interface TasksScope {
  closeWaiting: (id: string, e: Live) => Promise<void>
  /** 结束对话的 CLI 并等执行位释放，限时内没收完就强制停（见 keepalive.ts） */
  endLive: (id: string, e: Live, reason: import('../../shared/schema.ts').StopReason, graceMs?: number) => Promise<void>
  /** 子对话完成后 CLI 再保留一段（设置「子对话完成后保留」），返回 false 时调用方马上结束它（见 keepalive.ts） */
  keepDoneChild: (id: string, e: Live) => Promise<boolean>
  /** 已完成的子对话 CLI 还在保留期里 */
  keepingDone: (id: string) => boolean
  /** 停掉整棵对话树并直接结束名下全部 CLI 进程（用户停止、归档） */
  stopTree: (id: string, reason?: import('../../shared/schema.ts').StopReason) => Promise<void>
  PLAN_NUDGE_MS: number
  READONLY: string
  activeChildren: (parentId: string) => Promise<number>
  advanceChildTo: (
    childId: string,
    opts?: {
      quiet?: boolean
      fromUser?: boolean
    },
  ) => Promise<{
    holds: import('../../shared/task.ts').ChildHold[]
    info: string
  }>
  alertOn: (taskId: string, kind: AlertKind, text: string, level?: 'warn' | 'error') => (e: unknown) => undefined
  allowedPids: (ids: Set<string>) => Promise<Set<number>>
  answerChildAsk: (
    parentId: string,
    msgId: string,
    answer: string,
    delegate: boolean,
  ) => Promise<
    | {
        task: Task
        nudge: {
          ok: true
          how: 'already'
        }
      }
    | {
        task: Task
        nudge:
          | {
              ok: false
              error: string
              how?: undefined
            }
          | {
              ok: true
              how: 'restart' | 'lost' | 'pending' | 'wait' | 'steer' | 'notes' | 'next-node' | 'held' | 'next'
              error?: undefined
            }
      }
    | {
        error: string
        task?: undefined
      }
    | {
        task: Task
        error?: undefined
      }
  >
  applyAskUser: (task: Task, on: boolean, working: boolean) => Promise<void>
  applyChildAskUser: (parent: Task, on: boolean) => Promise<void>
  attachOrchestra: (taskId: string, orch: import('../../shared/engine-host.ts').Orchestra | undefined) => void
  background: {
    start(input: {
      taskId: string
      step?: string
      name: string
      command: string
      cwd: string
      root: string
      exclusive: boolean
      env?: {
        key: string
        value: string
      }[]
      timeoutMinutes?: number
      /** 被停止时也要把结果交回发起方（父对话测试用，见 background.ts 的 BgJob.notifyOnStop） */
      notifyOnStop?: boolean
      /** 常驻服务（BgJob.service） */
      service?: boolean
      /** 指定用哪个 shell 起进程（面板跑的测试步骤，见 server/step-run.ts） */
      shell?: import('../background.ts').BgJob['shell']
    }):
      | {
          ok: boolean
          info: string
          id?: undefined
        }
      | {
          ok: boolean
          id: string
          info: string
        }
    view(taskId: string, id: string): import('../../shared/schema.ts').TaskJobView | null
    check(taskId: string, id: string): string
    stopOne(
      taskId: string,
      id: string,
    ): {
      ok: boolean
      info: string
    }
    occupants(root: string): import('../background.ts').BgJob[]
    active(): import('../background.ts').BgJob[]
    known(id: string): boolean
    lostNote(id: string): string | undefined
    list(taskId: string): import('../background.ts').BgJob[]
    stop(taskId: string, note?: string): Promise<void>
    recover(stale?: import('../background.ts').BgJob[]): number
    forget(taskId: string): void
  }
  bad: (
    c: Context,
    error: string,
    status?: 400 | 404 | 409,
  ) => Response &
    import('hono').TypedResponse<
      {
        error: string
      },
      400 | 404 | 409,
      'json'
    >
  beginEdit: (
    entry: Live,
    changed: (f?: boolean) => void,
  ) => Promise<{
    ok: boolean
    info: string
  }>
  beginInlineEdit: (
    parent: Task,
    dir: string,
    files: string[],
    reason: string,
  ) => Promise<{
    ok: boolean
    info: string
  }>
  chatProject: (dir: string) => Project
  chatWorkspace: (id: string) => Promise<Project>
  /** 一轮结束后按整棵对话树核用量上限；true 表示到了上限、已经停下（见 tasks/budget.ts） */
  checkBudget: (tk: Task) => Promise<boolean>
  /** 面板替别人叫醒一个对话之前的唯一判断，返回不叫的原因（规则见 shared/wake.ts） */
  holdWake: (
    target: Task,
    opts?: { from?: string; fromAbove?: boolean },
  ) => Promise<import('../../shared/wake.ts').WakeHold | undefined>
  childActive: (tk: Task) => boolean
  /** 子对话卡住了、面板正在重启它或找人接手（见 server/tasks/stuck-child.ts）：这段时间不往父对话报中断 / 失败 */
  childRecovering: (id: string) => boolean
  childMerged: (
    childId: string,
    text: string,
    opts?: {
      quiet?: boolean
      peer?: PeerFrom
    },
  ) => Promise<
    | {
        holds: import('../../shared/task.ts').ChildHold[]
        info: string
      }
    | undefined
  >
  childRequestBuild: (
    child: Task,
    note: string,
  ) => Promise<{
    ok: boolean
    info: string
  }>
  childUnmerged: (tk: Task, project: Project | null) => Promise<boolean>
  childrenRunning: (parentId: string) => number
  claims: ReturnType<typeof createClaims>
  cliChildren: (parentId: string) => Promise<number>
  closeChildren: (parentId: string) => Promise<void>
  completing: Map<string, Promise<void | import('../../shared/task.ts').ChildFlowStop>>
  current: (id: string) => Promise<Task | null>
  deliver: (
    entry: Live,
    msg: import('../../shared/schema.ts').TaskMessage,
    text: string,
    attachments: Attachment[],
    placed?: Attachment[],
  ) => Promise<{
    task: Task
    how: import('../../shared/schema.ts').DeliveryHow
  }>
  deps: {
    agents: Lister<Agent>
    workflows: Lister<Workflow>
    projects: Lister<Project>
    projectCategories: Lister<ProjectCategory>
    /** 记项目教训（和界面上的「记成教训」共用一个队列） */
    recordLesson?: (
      projectId: string,
      draft: LessonDraft,
    ) => Promise<{
      ok: boolean
      info: string
    }>
    /**
     * 子对话独立分支的 git 查询：测试里换成假的，用来验证「git 很慢时 /children 也不阻塞」；
     * 不传就用真的 worktreeStatus
     */
    worktreeStatus?: typeof worktreeStatus
  }
  dropUploads: (removed: Task[]) => Promise<void>
  dropWorktree: (tk: Task, repo?: string) => Promise<void>
  endBackground: (id: string) => Promise<void>
  endInlineEdit: (
    parent: Task,
    dir: string,
  ) => Promise<{
    ok: boolean
    info: string
  }>
  ensureChildWorktree: (entry: Live, project: Project | null | undefined) => Promise<void>
  expandForWorkflow: (tk: Pick<Task, 'mode' | 'worktree' | 'projectId' | 'id'>, text: string) => Promise<string>
  finishChild: (
    parent: Task,
    childId: string,
  ) => Promise<{
    ok: boolean
    info: string
    /** 没合进去的类别（见 worktree-integrate.ts）：只有 conflict 是子对话要修的 */
    kind?: IntegrateKind
    /** 一行的原因，界面提示用 */
    why?: string
  }>
  followUp: (
    id: string,
    msg?: {
      text: string
      attachments: Attachment[]
      placed?: Attachment[]
      recorded?: boolean
      panel?: import('../../shared/schema.ts').TaskMessage['panel']
      child?: import('../../shared/schema.ts').TaskMessage['child']
      peer?: import('../../shared/schema.ts').TaskMessage['peer']
      prompt?: string
      delivery?: import('../../shared/schema.ts').DeliveryHow
      messageId?: string
      worktree?: import('../../shared/schema.ts').TaskMessage['worktree']
      /** 面板在父对话里自动画出的子对话总结卡（见 TaskMessage.summaryCards） */
      summaryCards?: import('../../shared/schema.ts').TaskMessage['summaryCards']
    },
  ) => Promise<Task>
  forwardSpawn: (
    child: Task,
    spec: import('../../shared/engine-host.ts').HelperSpec,
  ) => {
    ok: boolean
    info: string
    id?: string
  }
  getMeta: (id: string) => Promise<Task | null>
  gitGate: <T>(run: () => Promise<T>) => Promise<T>
  idle: (task: Task) => Task
  integrate: (tk: Task, parent: Task) => Promise<IntegrateResult>
  lastReply: (task: Task) => string
  live: Map<string, Live>
  liveAgents: {
    name: string
    description: string
    cli: string
    model: string
    effort: string
    categoryId: string
    icon: string
    instructions: string
    includes: string[]
    params: {
      key: string
      label: string
      type: 'number' | 'select' | 'multi' | 'bool' | 'text'
      options: string[]
      ask: boolean
      description: string
      default?: string | number | boolean | string[] | undefined
      when?:
        | {
            key: string
            values: string[]
            not: boolean
          }
        | undefined
      optionsBy?:
        | {
            key: string
            map: Record<string, string[]>
          }
        | undefined
    }[]
    skills: string[]
    starters: string[]
    tags: string[]
    permission: string
    extraArgs: string[]
    enabled: boolean
    common: boolean
    canDelegate: boolean
    canPlan: boolean
    runIn: 'any' | 'parent'
    when: string
    modes: ('inline' | 'subtask')[]
    independent: boolean
    mounts: {
      agentId: string
      mode: 'parent' | 'inline' | 'subtask' | 'auto'
      preload: boolean
      rule: string
      params: Record<string, string | number | boolean | string[]>
    }[]
    inlineEdit: 'off' | 'tiny'
    capsSet: boolean
    origin: string
    id: string
    createdAt: string
    updatedAt: string
    kind?: 'basic' | 'advanced' | undefined
    mountsCustom?: boolean | undefined
    upgrades?: string[] | undefined
  }[]
  mergeLock: <T>(rootId: string, fn: () => Promise<T>) => Promise<T>
  mergeNudged: Set<string>
  merging: Set<string>
  messageParent: (
    child: Task,
    text: string,
    question: boolean,
    options?: string[],
    kind?: AskKind,
    fix?: boolean,
  ) => Promise<{
    ok: boolean
    info: string
  }>
  nameOnce: (task: Task, cli: string) => void
  noteParent: (
    parentId: string,
    from: Task,
    body: string,
    inboxText?: string,
    settle?: {
      kind: import('../../shared/schema.ts').PlanWait['kind']
      ref: string
      ok: boolean
      onlyIfWaiting?: boolean
    },
    child?: {
      id: string
      title: string
      state: import('../../shared/task.ts').ConvState
    },
    peer?: PeerFrom,
    worktree?: import('../../shared/schema.ts').TaskMessage['worktree'],
    wake?: boolean,
    summaryCards?: import('../../shared/schema.ts').TaskMessage['summaryCards'],
  ) => Promise<void>
  notePlanInput: (tk: Task, skip?: boolean, now?: string) => boolean
  nudgePlan: (conv: Task, turn?: TurnInfo) => Promise<boolean>
  /** 父对话一轮结束时有子对话在等它收尾：推它 finish_child（见 drive.ts 的 nudgeWrapUp） */
  nudgeWrapUp: (conv: Task) => Promise<boolean>
  /** 结束前钩子（ADR 0049）：CLI 在模型准备结束这一轮时问，拦住就在同一轮里接着做（见 before-end.ts） */
  beforeEnd: (
    convId: string,
    input: import('../../shared/hooks.ts').BeforeEndInput,
  ) => Promise<import('../../shared/hooks.ts').BeforeEndDecision>
  /** 推进计数的现状（诊断用）：最后一个进度指纹和推了几次 */
  nudgeState: (id: string) => { key: string; n: number } | undefined
  /** 用户亲自发了新消息：推进次数清零（ADR 0041） */
  resetNudge: (id: string) => void
  /** 停止时记下（自驱不推被叫停的对话），开新一轮时清掉 */
  noteStop: (id: string, reason: string) => void
  clearStop: (id: string) => void
  panelAlert: (taskId: string, kind: AlertKind, text: string, error: unknown, level?: 'warn' | 'error') => Promise<void>
  paramsOf: (p: Project, workflowId: string) => Record<string, string | number | boolean | string[]>
  parentRequestBuild: (
    parent: Task,
    project: Project,
    note: string,
    children?: string[],
    custom?: { name: string; command: string; cwd: string; timeoutMinutes?: number },
  ) => Promise<{
    ok: boolean
    info: string
    id?: string
  }>
  parentTestStepsOf: (tk: Task) => Promise<
    {
      name: string
      command: string
      env: 'auto' | 'wsl' | 'powershell' | 'cmd' | 'bash'
      cwd: string
      when: string
      appliesTo: string[]
      scope: 'parent' | 'always' | 'changed'
      timeoutSec: number
      note: string
      enabled: boolean
      merge: boolean
      quick: boolean
      id: string
    }[]
  >
  parentTesting: (childId: string, tk: Pick<Task, 'wrapRequest'>) => boolean
  parentTests: import('../parent-tests.ts').ParentTests
  peerList: (self: Task) => Promise<Task[]>
  peerOf: (from: Task, rel: PeerFrom['rel'], kind: PeerKind, subject: string, failed?: boolean) => Promise<PeerFrom>
  pendingJobs: (id: string) => number
  placeInTask: (
    tk: Pick<Task, 'worktree' | 'projectId' | 'id' | 'placedAttachments'>,
    attachments: Attachment[],
  ) => Promise<
    {
      name: string
      path: string
      size: number
      mime: string
      ref?: boolean | undefined
      quote?: string | undefined
    }[]
  >
  planKids: (parentId: string) => Promise<import('../../shared/plan.ts').PlanKid[]>
  planNudged: Map<string, string>
  planWorkflow: (
    project: Project,
    all: Workflow[],
    fallback: Workflow | undefined,
    id: string,
  ) =>
    | {
        workflow: Workflow
        workflows: Workflow[]
        skillSlots: Record<string, string>
      }
    | undefined
  prewarmChat: (task: Task, force?: boolean) => Promise<Task>
  processPanel: (tk: Task) => Promise<{
    sampledAt: number
    processes: {
      pid: number
      parentPid: number | null
      command: string
      ownerTaskId: string
      ownerTitle: string
      startedAt: number | null
      durationMs: number | null
      rss: number | null
      status: 'idle' | 'running' | 'orphan'
      kind: 'cli' | 'child'
    }[]
    cliMemory: number | null
    serverMemory: number
    totalMemory: number | null
    unavailable: string
  }>
  projectWorkflow: (p: Project) => Promise<Workflow | undefined>
  readableDir: (id: string | undefined) => Promise<string>
  ready: Promise<unknown>
  recordSelfTestRun: (job: import('../background.ts').BgJob) => Promise<void>
  recordWorktreeError: (tk: Task, error: string) => void
  recoverParentTests: () => Promise<void>
  refreshAgents: () => Promise<
    {
      name: string
      description: string
      cli: string
      model: string
      effort: string
      categoryId: string
      icon: string
      instructions: string
      includes: string[]
      params: {
        key: string
        label: string
        type: 'number' | 'select' | 'multi' | 'bool' | 'text'
        options: string[]
        ask: boolean
        description: string
        default?: string | number | boolean | string[] | undefined
        when?:
          | {
              key: string
              values: string[]
              not: boolean
            }
          | undefined
        optionsBy?:
          | {
              key: string
              map: Record<string, string[]>
            }
          | undefined
      }[]
      skills: string[]
      starters: string[]
      tags: string[]
      permission: string
      extraArgs: string[]
      enabled: boolean
      common: boolean
      canDelegate: boolean
      canPlan: boolean
      runIn: 'any' | 'parent'
      when: string
      modes: ('inline' | 'subtask')[]
      independent: boolean
      mounts: {
        agentId: string
        mode: 'parent' | 'inline' | 'subtask' | 'auto'
        preload: boolean
        rule: string
        params: Record<string, string | number | boolean | string[]>
      }[]
      inlineEdit: 'off' | 'tiny'
      capsSet: boolean
      origin: string
      id: string
      createdAt: string
      updatedAt: string
      kind?: 'basic' | 'advanced' | undefined
      mountsCustom?: boolean | undefined
      upgrades?: string[] | undefined
    }[]
  >
  release: (entry: Live) => void
  /** 扫父对话名下排在别的子对话之后的：前置都合回就启动，等不到的告诉父对话（见 tasks/after-deps.ts） */
  releaseAfter: (parentId: string) => Promise<void>
  reportKey: (tk: Task, state: import('../../shared/task.ts').ConvState) => string
  reportToParent: (task: Task) => Promise<void>
  reportedDone: Set<string>
  reportedState: Map<string, string>
  reserve: (task: Task) =>
    | {
        value: Live
        fresh: false
      }
    | {
        value: Live
        fresh: true
      }
  restoreWorktree: (tk: Task, project: Project) => Promise<string>
  routes: Hono<import('hono/types').BlankEnv, import('hono/types').BlankSchema, '/'>
  ruleCommand: (
    id: string,
    text: string,
  ) => Promise<
    | {
        task: Task
      }
    | {
        error: string
      }
  >
  runningConv: (id: string) => Live | undefined
  scopes: Map<
    string,
    Map<
      string,
      {
        title: string
        files: string[]
      }
    >
  >
  sendToChild: (
    parentId: string,
    id: string,
    message: string,
    panel?: import('../../shared/schema.ts').TaskMessage['panel'],
    kind?: PeerKind,
    failed?: boolean,
  ) => Promise<{
    ok: boolean
    info: string
  }>
  settleAskFromChild: (childId: string, answer: string) => Promise<void>
  settleAsks: (
    parent: Task,
    childId: string,
    answer: string,
    by: 'user' | 'parent',
    msgId?: string,
    declined?: boolean,
  ) => boolean
  settleChildTurn: (child: Task, turn?: TurnInfo) => void
  settleChildWorktree: (childId: string, turn?: TurnInfo) => Promise<void>
  shuttingDown: boolean
  /** 面板替父对话新建子对话（卡住的子对话找人接手时用），和父对话的 create_conversation 走同一条创建路径 */
  spawnChildOf: (
    parentId: string,
    input: { title: string; message: string; agentId?: string },
  ) => Promise<{ ok: boolean; info: string; id?: string; title?: string }>
  start: (
    entry: Live,
    prompt: string,
    first: boolean,
    agents: Agent[],
    op?: import('../exec/real-context.ts').RealContext['op'],
    resume?: boolean,
    prewarm?: boolean,
  ) => Promise<Task>
  startChild: (sub: Task, message: string, agents: Agent[]) => Promise<void>
  /** 父对话给还在等前置的子对话交消息：现在就启动它（见 tasks/after-deps.ts） */
  startAfterNow: (parent: Task, child: Task, text: string) => Promise<{ ok: boolean; info: string }>
  startParentTests: (tk: Task, steps: import('../../shared/schema.ts').TestStep[]) => Promise<void>
  startQueue: Set<string>
  stopTask: (id: string, reason: import('../../shared/schema.ts').StopReason) => void
  store: ReturnType<typeof createTaskStore>
  stuckAfterNudge: (tk: Task) => boolean
  submitMerge: (
    childId: string,
    note: string,
    tests: string,
    build?: boolean,
    handoff?: import('../../shared/handoff.ts').HandoffInput,
    triage?: import('../../shared/review-gate.ts').TriageItem[],
    override?: import('../../shared/review-gate.ts').ReviewOverride,
  ) => Promise<{
    ok: boolean
    info: string
  }>
  subtreeIdsOf: (tk: Task) => Promise<Set<string>>
  taskAlive: (id: string) => boolean
  taskDir: (
    tk: Pick<Task, 'worktree' | 'projectId' | 'id'> & {
      parentTaskId?: string
    },
  ) => Promise<string>
  testOpts: (project: Project) => {
    agents: {
      name: string
      description: string
      cli: string
      model: string
      effort: string
      categoryId: string
      icon: string
      instructions: string
      includes: string[]
      params: {
        key: string
        label: string
        type: 'number' | 'select' | 'multi' | 'bool' | 'text'
        options: string[]
        ask: boolean
        description: string
        default?: string | number | boolean | string[] | undefined
        when?:
          | {
              key: string
              values: string[]
              not: boolean
            }
          | undefined
        optionsBy?:
          | {
              key: string
              map: Record<string, string[]>
            }
          | undefined
      }[]
      skills: string[]
      starters: string[]
      tags: string[]
      permission: string
      extraArgs: string[]
      enabled: boolean
      common: boolean
      canDelegate: boolean
      canPlan: boolean
      runIn: 'any' | 'parent'
      when: string
      modes: ('inline' | 'subtask')[]
      independent: boolean
      mounts: {
        agentId: string
        mode: 'parent' | 'inline' | 'subtask' | 'auto'
        preload: boolean
        rule: string
        params: Record<string, string | number | boolean | string[]>
      }[]
      inlineEdit: 'off' | 'tiny'
      capsSet: boolean
      origin: string
      id: string
      createdAt: string
      updatedAt: string
      kind?: 'basic' | 'advanced' | undefined
      mountsCustom?: boolean | undefined
      upgrades?: string[] | undefined
    }[]
    testSteps: {
      name: string
      command: string
      env: 'auto' | 'wsl' | 'powershell' | 'cmd' | 'bash'
      cwd: string
      when: string
      appliesTo: string[]
      scope: 'parent' | 'always' | 'changed'
      timeoutSec: number
      note: string
      enabled: boolean
      merge: boolean
      quick: boolean
      id: string
    }[]
    platform: NodeJS.Platform
    wslDistro: string
  }
  trackUserToChild: (child: Task, text: string) => Promise<void>
  wakeConv: (
    id: string,
    text: string,
    extra?: Pick<
      import('../../shared/schema.ts').TaskMessage,
      'panel' | 'peer' | 'child' | 'worktree' | 'summaryCards'
    >,
  ) => Promise<import('../../shared/schema.ts').DeliveryHow>
  wakeTask: (
    id: string,
    from: Task,
    text: string,
    meta?: {
      panel?: import('../../shared/schema.ts').TaskMessage['panel']
      child?: {
        id: string
        title: string
        state: import('../../shared/task.ts').ConvState
      }
      peer?: PeerFrom
    },
  ) => Promise<boolean>
  /** 对话的运行时状态（server/tasks/live.ts）：状态、CLI 存活、后台命令、名下子对话计数 */
  liveOf: (task: Task) => Promise<import('../../shared/live/task-live.ts').TaskLive>
  /** 交给界面的任务：记录加上 live（这一版旧的运行时字段也照样叠上） */
  withLive: (task: Task) => Promise<import('./live.ts').TaskWithLive>
  /** 顶层对话一轮结束后排一次经验学习（server/experience-learn.ts） */
  learnExperience: (taskId: string) => Promise<void>
  /** 对话这一轮失败收尾后：额度用完 / 被限流时按设置换备用模型或等到点继续（server/tasks/quota-resume.ts） */
  quotaAfterFail: (taskId: string) => Promise<void>
  workflowCatalog: (
    project: Project,
    all: Workflow[],
    fallback?: Workflow,
  ) => {
    id: string
    name: string
    description: string
    steps: string[]
  }[]
  worktreeHome: (tk: Task, project: Project) => Promise<string>
  worktreeStatusOf: typeof worktreeStatus
  /** 工作流运行（server/tasks/flow-runs.ts）：父对话的运行工具、运行回信、随父对话暂停 / 继续 */
  flowRuns: ReturnType<typeof import('./flow-runs.ts').createFlowRuns>
}
