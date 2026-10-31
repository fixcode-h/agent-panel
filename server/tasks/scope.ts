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
} from '../../shared/schema.ts'
import type { LessonDraft } from '../lessons.ts'
import type { Lister, Live } from './types.ts'
import type { createTaskStore } from '../task-store.ts'
import type { worktreeStatus } from '../exec/worktree.ts'
import type { AlertKind } from '../../shared/schema.ts'
import type { createClaims } from '../claims.ts'

/**
 * tasksApi 闭包里、被 server/tasks/ 下各模块用到的名字（值在 server/tasks.ts 的 scope 对象里，取值时才读）。
 * 模块要用闭包里的新名字时：在这里加一项类型，在 scope 对象（lazyScope）里加一个同名取值函数（let 变量写成 [取值, 写入]）。
 */
export interface TasksScope {
  closeWaiting: (id: string, e: Live) => Promise<void>
  /** 结束对话的 CLI 并等执行位释放，限时内没收完就强制停（见 keepalive.ts） */
  endLive: (id: string, e: Live, reason: import('../../shared/schema.ts').StopReason, graceMs?: number) => Promise<void>
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
  attachOrchestra: (taskId: string, orch: import('../../shared/engine.ts').Orchestra | undefined) => void
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
  buildFor: Map<
    string,
    {
      parent: string
      children: string[]
    }
  >
  chatProject: (dir: string) => Project
  chatWorkspace: (id: string) => Promise<Project>
  /** 一轮结束后按整棵对话树核用量上限；true 表示到了上限、已经停下（见 tasks/budget.ts） */
  checkBudget: (tk: Task) => Promise<boolean>
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
  enforceKeepAlive: (selfId?: string) => Promise<void>
  ensureChildWorktree: (entry: Live, project: Project | null | undefined) => Promise<void>
  expandForWorkflow: (tk: Pick<Task, 'mode' | 'worktree' | 'projectId' | 'id'>, text: string) => Promise<string>
  finishChild: (
    parent: Task,
    childId: string,
  ) => Promise<{
    ok: boolean
    info: string
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
    },
  ) => Promise<Task>
  forwardSpawn: (
    child: Task,
    spec: import('../../shared/engine.ts').HelperSpec,
  ) => {
    ok: boolean
    info: string
    id?: string
  }
  getMeta: (id: string) => Promise<Task | null>
  gitGate: <T>(run: () => Promise<T>) => Promise<T>
  idle: (task: Task) => Task
  integrate: (
    tk: Task,
    parent: Task,
  ) => Promise<{
    ok: boolean
    info: string
  }>
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
  ) => Promise<void>
  notePlanInput: (tk: Task, skip?: boolean, now?: string) => boolean
  nudgePlan: (conv: Task) => Promise<boolean>
  panelAlert: (taskId: string, kind: AlertKind, text: string, error: unknown, level?: 'warn' | 'error') => Promise<void>
  paramsOf: (p: Project, workflowId: string) => Record<string, string | number | boolean | string[]>
  parentRequestBuild: (
    parent: Task,
    project: Project,
    note: string,
    children?: string[],
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
  ready: Promise<void>
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
  settleChildTurn: (child: Task) => void
  settleChildWorktree: (childId: string) => Promise<void>
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
    op?: import('../exec/runner.ts').RealContext['op'],
    resume?: boolean,
    prewarm?: boolean,
  ) => Promise<Task>
  startChild: (sub: Task, message: string, agents: Agent[]) => Promise<void>
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
    extra?: Pick<import('../../shared/schema.ts').TaskMessage, 'panel' | 'peer' | 'child' | 'worktree'>,
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
  ) => Promise<void>
  withJobs: (task: Task) => Task
  withLive: (task: Task) => Promise<Task>
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
}
