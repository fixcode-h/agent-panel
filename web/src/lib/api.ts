import { takeLive, takeLives } from './live/store'
import type { ShellReport } from '@shared/shells'
import type { BugBrief } from '@shared/bug-overview'
import type { FlowBrief } from '@shared/agent-stats'
import type { SharedDirInfo } from '@shared/shared-dir'
import type { SpeedRow } from '@shared/api-speed'
import { trackedFetch } from './connection'
import { summaryApi } from './api-summary'
import { stylesApi } from './api-styles'
import { pathsApi } from './api-paths'
import { messagesApi } from './api-messages'
import { remoteApi } from './api-remote'
import type { CollabEvent } from '@shared/collab-timeline'
import type { LifeReport } from '@shared/lifecycle'
import type { TaskExport } from '@shared/task-export'
import type { ComfyQueueState, ComfyWorkflow, LocalJob, LocalStatus } from '@shared/local-image'
import type { ComfyChain } from '@shared/comfy-chain'
import type { SpeechStatus } from '@shared/speech'
import type { TtsStatus } from '@shared/tts'
import type { ComfyTemplateDetail, ComfyTemplateMeta, TemplateAsset } from '@shared/comfy-templates'
import type { InstalledPackage } from '@shared/cli-spec'
import type { ProjectSuggestion } from '@shared/project-scan'
import type {
  SessionInfo,
  Attachment,
  TaskRequest,
  CliInstallJob,
  CliLimits,
  CliSkill,
  SlashCommand,
  CliAccounts,
  LoginJob,
  ProviderAuthCheck,
  CliModels,
  CliUpdate,
  AgentInput,
  Category,
  TagInput,
  CliStatus,
  DirBranches,
  DirInfo,
  DirListing,
  Project,
  ProjectCategoryInput,
  ProjectInput,
  GlobalLesson,
  ProjectLesson,
  Settings,
  NewTaskInput,
  Task,
  TaskPatch,
  TaskSeenResult,
  WorkflowInput,
  CleanProcessesResult,
  KillProcessResult,
  ProcessSuggestResult,
  TaskMemoryHistory,
  TaskMemoryAnalysis,
  TaskProcesses,
  TaskJobView,
} from '@shared/schema'
import type { ChildHold, TrashRow } from '@shared/task'
import type { SearchHit } from '@shared/task-search'
import type { Schedule, ScheduleInput } from '@shared/schedule'
import type { RunUsage } from '@shared/run-usage'
import type { DiagnosisDecision } from '@shared/bug-diagnosis'
import type { PatchResult, PatchStatus } from '@shared/bug-patch'
import type { LogFetchResult, LogStartResult, LogWatchStatus } from '@shared/bug-log-watch'
import type { StatsTotal } from '@shared/task-export'
import type { AssistInput, AssistJob, Proposal } from '@shared/assist'
import type { LessonReviewItem } from '@shared/lesson-review'
import type { ContentSearch, DirLevel, FileContent, FileDiff, FileTree, NameSearch } from '@shared/files'
import type {
  DeployConfig,
  DeployResult,
  DeployRun,
  DeployState,
  GlobalDocOptimize,
  SkillUpdates,
} from '@shared/deploy'
import type { ApiConfig, ApiProtocol, DetectedApi } from '@shared/accounts'
import type { ApiBalance } from '@shared/api-balance'
import type { ModelCatalogEntry, ModelCatalogInfo, ModelLookupJob } from '@shared/model-catalog'
import type { IntegrationInstallJob, IntegrationLoginJob, IntegrationView } from '@shared/integrations'
import type { FixInput, FixStart } from '@shared/fix'
import type { FixApplyItem, FixApplyResult } from '@shared/diagnosis'
import type { ProjectMcpImportResult, ProjectMcpOverview } from '@shared/project-mcp'
import type {
  BundledSkill,
  LibraryCli,
  LibraryEntryContent,
  LibraryFile,
  LibraryItem,
  McpOverview,
  McpServer,
  McpTestResult,
} from '@shared/library'
import type { ProjectSkillsView } from '@shared/project-skills'
import type { ProjectProposal } from '@shared/project-init'
import type { DocFile, DocJob, DocOptimizeInput, ProjectDoc, ProjectDocs } from '@shared/docs'
import type { DocGroupView } from '@shared/doc-root'
import type { CleanupReport, DataKind, DataUsage, MemoryUsage, WorktreeCleanup } from '@shared/data'
import type { UsageGrain, UsageGroup, UsageReport } from '@shared/usage'
import type { AppReleases, AppUpdateBusy, AppUpdateJob, InterruptedTasks } from '@shared/version'
import { t } from '@shared/i18n'
import { catalogContract } from '@shared/api-contract/catalog'
import { tasksContract } from '@shared/api-contract/tasks'
import { call } from './api/call'

/** 对话页打开时的那一份（带分页信息），定义在契约里 */
export type { TaskPage } from '@shared/api-contract/tasks'

/** 交给父对话决定时，父对话到底叫起来没有 */
export type ChildAskNudge = { ok: true; how: string } | { ok: false; error: string }

/** 状态诊断文件的下载地址（完整日志、去掉密钥） */
export const lifecycleDownloadUrl = (id: string) => `/api/tasks/${id}/lifecycle/download`

/** 非 2xx 的响应转成错误：响应体挂到错误上，有些接口（例如更新撞上「已经在更新」）会在里面带上要继续处理的信息 */
export async function failure(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}))
  // 外网打开的面板登录失效了（改了密码、被踢下线、过期）：服务端回 401 并带 login，去登录页，登完回到这一页
  if (res.status === 401 && body?.login === '/login')
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`
  const err = new Error(body.error ?? t('请求失败（{status}）', { status: res.status })) as Error & {
    status?: number
    body?: unknown
  }
  err.status = res.status
  err.body = body
  throw err
}

/**
 * 回来的任务（单个或列表）带着 live（运行时状态）：取下来放进 live/store.ts，记录本身照常交给调用方。
 * 任务记录和运行时状态分开存，组件读状态只经 useLive（见 web/src/lib/live/store.ts）
 */
function withoutLive<T>(x: T): T {
  if (Array.isArray(x)) return (x.length && isTaskLike(x[0]) ? takeLives(x) : x) as T
  return (isTaskLike(x) ? takeLive(x) : x) as T
}
const isTaskLike = (x: unknown): x is { id: string; live?: unknown } =>
  !!x && typeof x === 'object' && 'live' in x && typeof (x as { id?: unknown }).id === 'string'

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // 在线演示版没有后端，请求交给浏览器里的模拟实现
  if (import.meta.env.VITE_DEMO) {
    const { handle } = await import('./demo-backend')
    const out = await handle(init?.method ?? 'GET', url, init?.body ? JSON.parse(init.body as string) : undefined)
    return withoutLive(out as T)
  }
  const res = await trackedFetch(`/api${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) await failure(res)
  return res.status === 204 ? (undefined as T) : withoutLive((await res.json()) as T)
}

/** 任务列表上次拿到的 ETag：数据没变时服务端回 304，列表不用重新赋值（侧栏不跟着重渲染） */
let tasksEtag = ''

/**
 * 任务列表：有任务在跑时每 2.5 秒拉一次，带上上次的 ETag。
 * 返回 null 表示服务端说「没变」（304），调用方保持现有列表不动
 */
const allTasks = async (): Promise<Task[] | null> => {
  // 演示版没有后端，也没有 ETag，直接回全量
  if (import.meta.env.VITE_DEMO) return request<Task[]>('/tasks')
  const res = await trackedFetch('/api/tasks', { headers: tasksEtag ? { 'If-None-Match': tasksEtag } : {} })
  if (res.status === 304) return null
  if (!res.ok) await failure(res)
  const tag = res.headers.get('ETag')
  if (tag) tasksEtag = tag
  return takeLives((await res.json()) as Task[])
}

/** 一个对话在磁盘上占多少（任务文件 + 对话文件） */
export interface TaskDiskItem {
  id: string
  title: string
  projectId: string
  parentTaskId: string
  updatedAt: string
  archived: boolean
  working: boolean
  bytes: number
}

/** 设置「数据」里的保活会话列表（server/tasks.ts 的 keepAliveList） */
export interface KeepAliveItem {
  id: string
  title: string
  projectId: string
  parentTaskId: string
  cli: string
  /** 正开着这个对话的页面：释放全部时不动它 */
  viewing: boolean
  /** 这一轮回复完的时间 */
  since: string
  /** 进程（含子进程）的内存，读不到时为空 */
  rss: number | null
}

/** Chat 的「关于我」和记忆（和 server/chat-memory.ts 的 ChatMemory 一样） */
export type ChatMemoryView = { about: string; items: { id: string; text: string; at: string }[] }

export const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })

/** 一个独立分支（git worktree）和它在 git 里的实际情况 */
export interface WorktreeItem {
  taskId: string
  title: string
  /** 对话的创建时间：列表按它排序，父对话永远在第一位 */
  createdAt: string
  /** 是名下的子对话的（不是对话自己的） */
  child: boolean
  /** 那个对话正在动手 */
  working: boolean
  branch: string
  /** 从哪个分支开出、要合回哪个分支 */
  baseBranch: string
  path: string
  state: 'active' | 'merged' | 'discarded'
  note: string
  /** 合回去的目录 */
  home: string
  exists: boolean
  /** 原分支里还没有的提交数 */
  ahead: number
  /** 没提交的文件数 */
  dirty: number
  /** 改动都已经在原分支里了 */
  merged: boolean
  /** 子对话还没彻底完成、所以独立分支还留着的原因（合回去了才有） */
  holds?: ChildHold[]
}

/** 用户加的 CLI 配置：原文（页面拿去注册）、读不进来的原因、所在目录 */
export interface UserClis {
  specs: unknown[]
  errors: string[]
  dir: string
}

export const api = {
  settings: () => call(catalogContract.settings),
  saveSettings: (s: Settings) => call(catalogContract.saveSettings, { body: s }),
  shells: (fresh = false) => request<ShellReport>(`/shells${fresh ? '?fresh=1' : ''}`),

  /** 外部 CLI 的授权：检测、浏览器授权、token 授权、退出 */
  integrations: (refresh = false) => request<IntegrationView[]>(`/integrations${refresh ? '?refresh=1' : ''}`),
  integrationLogin: (id: string) => request<IntegrationLoginJob>(`/integrations/${id}/login`, json('POST', {})),
  integrationLoginStatus: (id: string) => request<IntegrationLoginJob | null>(`/integrations/${id}/login`),
  integrationToken: (id: string, token: string) =>
    request<IntegrationView>(`/integrations/${id}/login/token`, json('POST', { token })),
  integrationCancel: (id: string) => request<{ ok: true }>(`/integrations/${id}/login`, { method: 'DELETE' }),
  integrationInstall: (id: string) => request<IntegrationInstallJob>(`/integrations/${id}/install`, json('POST', {})),
  integrationInstallStatus: (id: string) => request<IntegrationInstallJob | null>(`/integrations/${id}/install`),
  integrationLogout: (id: string) => request<IntegrationView>(`/integrations/${id}/logout`, json('POST', {})),

  localImage: () => request<LocalStatus>('/local-image/status'),
  localImageQueue: () => request<ComfyQueueState>('/local-image/queue'),
  localImageAction: (action: 'install' | 'cancel' | 'start' | 'stop' | 'detect') =>
    request<LocalStatus>(`/local-image/${action}`, { method: 'POST' }),
  localModel: (id: string, action: 'download' | 'remove') =>
    request<LocalStatus>(`/local-image/models/${id}${action === 'download' ? '/download' : ''}`, {
      method: action === 'download' ? 'POST' : 'DELETE',
    }),

  /** 本机语音输入：识别库和模型的下载状态（shared/speech.ts） */
  speech: () => request<SpeechStatus>('/speech/status'),
  speechCancel: () => request<SpeechStatus>('/speech/cancel', { method: 'POST' }),
  speechModel: (id: string, action: 'download' | 'remove') =>
    request<SpeechStatus>(`/speech/models/${id}${action === 'download' ? '/download' : ''}`, {
      method: action === 'download' ? 'POST' : 'DELETE',
    }),
  /** 一段 16kHz 单声道 16 位 PCM（base64）转成文字 */
  transcribe: (audio: string) => request<{ text: string }>('/speech/transcribe', json('POST', { audio })),

  /** 本机语音朗读：开源 Kokoro 模型的下载状态（shared/tts.ts），和语音输入分开 */
  tts: () => request<TtsStatus>('/tts/status'),
  ttsCancel: () => request<TtsStatus>('/tts/cancel', { method: 'POST' }),
  ttsModel: (id: string, action: 'download' | 'remove') =>
    request<TtsStatus>(`/tts/models/${id}${action === 'download' ? '/download' : ''}`, {
      method: action === 'download' ? 'POST' : 'DELETE',
    }),
  /** 把一段文字念成 WAV；音色、语速不传用设置里的（试听传还没保存的值）。演示版没有本机模型 */
  ttsSpeak: async (
    body: { text: string; voice?: number; speed?: number; model?: string },
    signal?: AbortSignal,
  ): Promise<Blob> => {
    if (import.meta.env.VITE_DEMO) throw new Error(t('在线演示没有本机朗读模型，请在设置 → 语音朗读里改用浏览器语音'))
    const res = await fetch('/api/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) await failure(res)
    return res.blob()
  },

  comfyWorkflows: () => request<{ list: ComfyWorkflow[]; ready: string[] }>('/local-image/workflows'),
  /** 工作流链：存下来的链 + 可用的工作流（面板里选段要用） */
  comfyChains: () =>
    request<{ list: ComfyChain[]; workflows: ComfyWorkflow[]; ready: string[] }>('/local-image/chains'),
  saveComfyChain: (chain: ComfyChain) =>
    request<{ chain: ComfyChain; list: ComfyChain[] }>(
      `/local-image/chains/${encodeURIComponent(chain.id)}`,
      json('PUT', chain),
    ),
  deleteComfyChain: (id: string) =>
    request<{ list: ComfyChain[] }>(`/local-image/chains/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 试跑：传链和一张原图（data URL），返回输出图（data URL） */
  runComfyChain: (
    chain: ComfyChain,
    image?: string,
    prompt?: string,
    /** 出图尺寸和张数（ComfyUI 页的试生成用）；不传是 1024² 一张 */
    out?: { width: number; height: number; count: number },
  ) =>
    request<{ images: string[] }>(
      `/local-image/chains/${encodeURIComponent(chain.id)}/run`,
      json('POST', { chain, image, prompt, ...out }),
    ),
  comfyTemplates: () =>
    request<{ templates: ComfyTemplateMeta[]; updatedAt: string; cached: boolean }>('/local-image/templates'),
  refreshComfyTemplates: () =>
    request<{ templates: ComfyTemplateMeta[]; updatedAt: string; cached: boolean }>('/local-image/templates/refresh', {
      method: 'POST',
    }),
  comfyTemplate: (name: string) =>
    request<ComfyTemplateDetail & { preview?: ComfyWorkflow['graph'] }>(
      `/local-image/templates/${encodeURIComponent(name)}`,
    ),
  addComfyTemplate: (name: string, kind: 'game' | 'web') =>
    request<ComfyWorkflow>(`/local-image/templates/${encodeURIComponent(name)}/add`, json('POST', { kind })),
  downloadComfyTemplate: (name: string) =>
    request<{ job: LocalJob; files: TemplateAsset[]; skipped: number }>(
      `/local-image/templates/${encodeURIComponent(name)}/download`,
      json('POST', {}),
    ),
  saveComfyWorkflow: (w: ComfyWorkflow) =>
    request<ComfyWorkflow>(`/local-image/workflows/${encodeURIComponent(w.id)}`, json('PUT', w)),
  deleteComfyWorkflow: (id: string) =>
    request<{ ok: boolean }>(`/local-image/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assistComfyWorkflow: (body: { kind: 'game' | 'web'; instruction: string; base?: ComfyWorkflow }) =>
    request<{ workflow: ComfyWorkflow; note: string }>('/local-image/workflows/assist', json('POST', body)),
  /** 面板 → ComfyUI：写进它的 userdata/workflows，在 ComfyUI 网页的工作流侧栏里打开 */
  importComfyWorkflow: (id: string) =>
    request<{ name: string; filename: string; url: string }>(
      `/local-image/workflows/${encodeURIComponent(id)}/import`,
      { method: 'POST' },
    ),

  clis: (refresh = false) => request<CliStatus[]>(`/clis${refresh ? '?refresh=1' : ''}`),
  cliAction: (id: string, action: 'install' | 'uninstall') =>
    request<CliInstallJob>(`/clis/${id}/${action}`, { method: 'POST' }),
  cliJob: (jobId: string) => request<CliInstallJob>(`/clis/jobs/${jobId}`),
  cliUpdate: (id: string, refresh = false) => request<CliUpdate>(`/clis/${id}/update${refresh ? '?refresh=1' : ''}`),
  cliJobs: () => request<CliInstallJob[]>('/clis/jobs'),
  accounts: () => request<CliAccounts[]>('/accounts'),
  detectedApis: () => request<DetectedApi[]>('/accounts/detected-apis'),
  loginStart: (cli: string) => request<LoginJob>(`/accounts/${cli}/login`, json('POST', {})),
  loginStatus: (cli: string) => request<LoginJob | null>(`/accounts/${cli}/login`),
  checkProviders: (cli: string) => request<ProviderAuthCheck[]>(`/accounts/${cli}/check`),
  loginInput: (cli: string, text: string) =>
    request<{ ok: true }>(`/accounts/${cli}/login/input`, json('POST', { text })),
  loginCancel: (cli: string) => request<{ ok: true }>(`/accounts/${cli}/login`, { method: 'DELETE' }),
  saveAccount: (cli: string, name = '') => request<CliAccounts>(`/accounts/${cli}/save`, json('POST', { name })),
  switchAccount: (cli: string, id: string) => request<CliAccounts>(`/accounts/${cli}/switch`, json('POST', { id })),
  logoutAccount: (cli: string) => request<CliAccounts>(`/accounts/${cli}/logout`, json('POST', {})),
  renameAccount: (cli: string, id: string, name: string) =>
    request<CliAccounts>(`/accounts/${cli}/accounts/${id}`, json('PATCH', { name })),
  deleteAccount: (cli: string, id: string) =>
    request<CliAccounts>(`/accounts/${cli}/accounts/${id}`, { method: 'DELETE' }),
  apiModels: (a: Pick<ApiConfig, 'name' | 'protocol' | 'baseUrl' | 'apiKey' | 'authHeader'>) =>
    request<{ models: string[] }>('/accounts/api-models', json('POST', a)),
  /** 用一个模型真的发一次最小请求，确认这个模型是通的（服务端带密钥请求，错误原文透传） */
  probeApiModel: (a: Pick<ApiConfig, 'name' | 'protocol' | 'baseUrl' | 'apiKey' | 'authHeader'> & { model: string }) =>
    request<{ model: string }>('/accounts/api-probe', json('POST', a)),
  /** 测速：各协议一小一大两个流式请求的首包和总耗时（服务端带密钥请求） */
  apiSpeed: (a: ApiConfig, model: string) =>
    request<{ rows: SpeedRow[] }>('/accounts/api-speed', json('POST', { api: a, model })),
  /** 查 API 账户余额（服务端带上密钥去请求，页面拿不到密钥也不直连第三方） */
  apiBalance: (a: Pick<ApiConfig, 'name' | 'apiKey'>) => request<ApiBalance>('/accounts/api-balance', json('POST', a)),
  applyApi: (id: string) => request<{ clis: string[] }>(`/accounts/apis/${id}/apply`, json('POST', {})),
  /** 把这个 Agent 选的 API（地址、密钥、模型）写进它自己的配置文件；apiId / apiProtocol 是页面上看到的，和已保存的对不上时服务端拒绝 */
  applyCliApi: (cli: string, sel: { apiId: string; apiProtocol: string }) =>
    request<{ ok: true }>(`/accounts/clis/${cli}/apply-api`, json('POST', sel)),
  /** mode 给出时按这种登录方式读（设置页切换后还没保存也能先读到） */
  cliModels: (
    id: string,
    refresh = false,
    mode?: { authMode: 'account' | 'api'; apiId?: string; apiProtocol?: string },
  ) => {
    const q = new URLSearchParams()
    if (refresh) q.set('refresh', '1')
    if (mode) q.set('auth', mode.authMode)
    if (mode?.authMode === 'api') q.set('api', mode.apiId ?? '')
    if (mode?.authMode === 'api' && mode.apiProtocol) q.set('protocol', mode.apiProtocol)
    const qs = q.toString()
    return request<CliModels>(`/clis/${id}/models${qs ? `?${qs}` : ''}`)
  },
  /** 模型目录：内置的加上用户补充的 */
  modelCatalog: () => request<ModelCatalogInfo>('/model-catalog'),
  /** Chat 的「关于我」和跨对话记忆（server/chat-memory.ts） */
  chatMemory: () => request<ChatMemoryView>('/chat-memory'),
  saveChatAbout: (about: string) => request<ChatMemoryView>('/chat-memory/about', json('PUT', { about })),
  addChatMemory: (text: string) => request<ChatMemoryView>('/chat-memory/items', json('POST', { text })),
  forgetChatMemory: (id: string) => request<ChatMemoryView>(`/chat-memory/items/${id}`, { method: 'DELETE' }),
  /** 给模型目录里的一个模型填单价（美元 / 百万 token）；null 清掉 */
  setModelPrice: (vendor: string, id: string, price: ModelCatalogEntry['price'] | null) =>
    request<{ entries: ModelCatalogEntry[] }>('/model-catalog/price', json('PUT', { vendor, id, price })),
  lookupModel: (body: { model: string; protocol?: ApiProtocol; cli?: string }) =>
    request<ModelLookupJob>('/model-catalog/lookup', json('POST', body)),
  modelLookup: (id: string) => request<ModelLookupJob>(`/model-catalog/lookup/${id}`),
  stopModelLookup: (id: string) => request<ModelLookupJob>(`/model-catalog/lookup/${id}/stop`, { method: 'POST' }),
  cliLimits: (id: string) => request<CliLimits | null>(`/clis/${id}/limits`),
  /** 用户在数据目录 config/clis/ 里加的 CLI 配置 */
  cliSpecs: () => request<UserClis>('/clis/specs'),
  reloadCliSpecs: () => request<UserClis>('/clis/specs/reload', json('POST', {})),
  revealCliSpecs: () => request<{ ok: boolean; dir: string }>('/clis/specs/reveal', json('POST', {})),
  cliCommands: (id: string, projectId = '') =>
    request<SlashCommand[]>(`/clis/${id}/commands${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  /** own：只要 CLI 自己的 Skill，不含 ~/.agents/skills 里共用的 */
  cliSkills: (id: string, projectId = '', own = false) =>
    request<CliSkill[]>(
      `/clis/${id}/skills?${new URLSearchParams({ ...(projectId && { projectId }), ...(own && { own: '1' }) })}`,
    ),

  /** CLI 自己的扩展包（定义里的 packages） */
  cliPackages: (id: string) => request<InstalledPackage[]>(`/clis/${id}/packages`),
  cliPackageAction: (id: string, action: 'install' | 'remove' | 'update' | 'updateAll', source = '') =>
    request<{ ok: boolean; output: string; packages: InstalledPackage[] }>(
      `/clis/${id}/packages`,
      json('POST', { action, source }),
    ),

  /** Skills / 命令库 */
  library: (kind: 'skill' | 'command') =>
    request<{ clis: LibraryCli[]; items: LibraryItem[] }>(`/library?kind=${kind}`),
  bundledSkills: () => request<{ items: BundledSkill[] }>('/library/bundled'),
  /** 自带 Skill 的文件内容（只读）：path 传空读 SKILL.md，其余读技能目录里的附加文件 */
  bundledEntry: (name: string, path: string) =>
    request<LibraryEntryContent>(`/library/bundled/entry?${new URLSearchParams({ name, path })}`),
  installBundled: (b: { names: string[]; clis: string[]; overwrite: boolean }) =>
    request<{ done: string[]; skipped: string[] }>('/library/bundled/install', json('POST', b)),
  libraryFile: (cli: string, kind: 'skill' | 'command', name: string) =>
    request<LibraryFile>(`/library/file?cli=${cli}&kind=${kind}&name=${encodeURIComponent(name)}`),
  saveLibraryFile: (b: { cli: string; kind: 'skill' | 'command'; name: string; content: string; create?: boolean }) =>
    request<{ ok: boolean }>('/library/file', json('PUT', b)),
  deleteLibraryFile: (cli: string, kind: 'skill' | 'command', name: string) =>
    request<{ ok: boolean }>(`/library/file?cli=${cli}&kind=${kind}&name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  copyLibraryItem: (b: { cli: string; kind: 'skill' | 'command'; name: string; to: string[]; overwrite?: boolean }) =>
    request<{ done: string[]; skipped: string[] }>('/library/copy', json('POST', b)),
  /** Skill 文件夹里的单个附加文件（命令没有附加文件） */
  libraryEntry: (b: { cli: string; kind: 'skill' | 'command'; name: string; path: string }) =>
    request<LibraryEntryContent>(`/library/entry?${new URLSearchParams(b)}`),
  saveLibraryEntry: (b: {
    cli: string
    kind: 'skill' | 'command'
    name: string
    path: string
    content: string
    create?: boolean
  }) => request<{ ok: boolean }>('/library/entry', json('PUT', b)),
  deleteLibraryEntry: (b: { cli: string; kind: 'skill' | 'command'; name: string; path: string }) =>
    request<{ ok: boolean }>(`/library/entry?${new URLSearchParams(b)}`, { method: 'DELETE' }),
  renameLibraryEntry: (b: {
    cli: string
    kind: 'skill' | 'command'
    name: string
    from: string
    to: string
    overwrite?: boolean
  }) => request<{ ok: boolean }>('/library/entry/rename', json('POST', b)),
  mkdirLibraryEntry: (b: { cli: string; kind: 'skill' | 'command'; name: string; path: string }) =>
    request<{ ok: boolean }>('/library/entry/mkdir', json('POST', b)),
  /** 项目设置里的 Skill 分节：项目目录下的技能 */
  projectSkills: (projectId: string) =>
    request<ProjectSkillsView>(`/project-skills?projectId=${encodeURIComponent(projectId)}`),
  projectSkillFile: (projectId: string, repo: string, name: string) =>
    request<LibraryFile>(`/project-skills/file?${new URLSearchParams({ projectId, repo, name })}`),
  saveProjectSkill: (b: { projectId: string; repo: string; name: string; content: string }) =>
    request<{ ok: boolean; dir: string }>('/project-skills/file', json('PUT', b)),
  createProjectSkill: (b: { projectId: string; repo: string; name: string; description?: string }) =>
    request<{ dir: string }>('/project-skills', json('POST', b)),
  deleteProjectSkill: (projectId: string, repo: string, name: string) =>
    request<{ ok: boolean }>(`/project-skills/file?${new URLSearchParams({ projectId, repo, name })}`, {
      method: 'DELETE',
    }),
  /** MCP 工具 */
  mcpTools: () => request<McpOverview>('/mcp-tools'),
  saveMcpTool: (server: McpServer, clis: string[]) =>
    request<McpOverview>(`/mcp-tools/${encodeURIComponent(server.name)}`, json('PUT', { server, clis })),
  deleteMcpTool: (name: string) => request<McpOverview>(`/mcp-tools/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  testMcpTool: (server: McpServer) => request<McpTestResult>('/mcp-tools/test', json('POST', server)),
  /** 项目设置里的 MCP：按项目读，项目目录里识别到的和面板管理的一起返回 */
  projectMcp: (projectId: string) => request<ProjectMcpOverview>(`/project-mcp?projectId=${projectId}`),
  saveProjectMcp: (projectId: string, server: McpServer, clis: string[]) =>
    request<ProjectMcpOverview>(
      `/project-mcp/${encodeURIComponent(server.name)}?projectId=${projectId}`,
      json('PUT', { server, clis }),
    ),
  deleteProjectMcp: (projectId: string, name: string) =>
    request<ProjectMcpOverview>(`/project-mcp/${encodeURIComponent(name)}?projectId=${projectId}`, {
      method: 'DELETE',
    }),
  testProjectMcp: (server: McpServer) => request<McpTestResult>('/project-mcp/test', json('POST', server)),
  importProjectMcp: (projectId: string, items: { file: string; name: string; clis?: string[] }[]) =>
    request<ProjectMcpImportResult>(`/project-mcp/import?projectId=${projectId}`, json('POST', { items })),

  appVersion: () => request<{ current: string; packaged: boolean; previous?: string }>('/app/version'),
  /** refresh：马上问 GitHub；cached：只读上次检查存下的列表，不联网 */
  appReleases: (mode?: 'refresh' | 'cached') =>
    request<AppReleases>(`/app/releases${mode === 'refresh' ? '?refresh=1' : mode === 'cached' ? '?cached=1' : ''}`),
  appInstall: (tag: string) => request<AppUpdateJob>('/app/install', json('POST', { tag })),
  appInstallJob: (id: string) => request<AppUpdateJob>(`/app/install/${id}`),
  /** 正在跑的那次更新；没有时是 null */
  appInstallCurrent: () => request<AppUpdateBusy | null>('/app/install-current'),
  appForceInstall: (id: string) => request<AppUpdateJob>(`/app/install/${id}/force`, json('POST', {})),
  appRollback: () => request<{ version: string }>('/app/rollback', json('POST', {})),
  /** 被上次「强制更新」打断的任务：新版本启动后问用户要不要继续 */
  appInterrupted: () => request<InterruptedTasks>('/app/interrupted'),
  /** 处理过了：保留记录，但不再自动弹 */
  appInterruptedAck: () => request<InterruptedTasks>('/app/interrupted/ack', json('POST', {})),
  /** 被上次面板退出 / 重启打断的顶层对话：首页问一次要不要全部继续 */
  appRestartInterrupted: () => request<InterruptedTasks>('/app/restart-interrupted'),
  appRestartInterruptedAck: () => request<InterruptedTasks>('/app/restart-interrupted/ack', json('POST', {})),

  // 下面这批按契约调（shared/api-contract/catalog.ts）：地址、方法和返回类型都从契约来
  categories: () => call(catalogContract.categories),
  createCategory: (name: string, scope: Category['scope'] = 'agent') =>
    call(catalogContract.createCategory, { body: { name, scope } }),
  renameCategory: (id: string, name: string) =>
    call(catalogContract.renameCategory, { params: { id }, body: { name } }),
  deleteCategory: (id: string) => call(catalogContract.deleteCategory, { params: { id } }),

  tags: () => call(catalogContract.tags),
  createTag: (input: TagInput) => call(catalogContract.createTag, { body: input }),
  updateTag: (id: string, input: TagInput) => call(catalogContract.updateTag, { params: { id }, body: input }),
  deleteTag: (id: string) => call(catalogContract.deleteTag, { params: { id } }),

  agents: () => call(catalogContract.agents),
  createAgent: (input: AgentInput) => call(catalogContract.createAgent, { body: input }),
  updateAgent: (id: string, input: AgentInput) => call(catalogContract.updateAgent, { params: { id }, body: input }),
  deleteAgent: (id: string) => call(catalogContract.deleteAgent, { params: { id } }),

  workflows: () => call(catalogContract.workflows),
  createWorkflow: (input: WorkflowInput) => call(catalogContract.createWorkflow, { body: input }),
  updateWorkflow: (id: string, input: WorkflowInput) =>
    call(catalogContract.updateWorkflow, { params: { id }, body: input }),
  deleteWorkflow: (id: string) => call(catalogContract.deleteWorkflow, { params: { id } }),

  projectCategories: () => call(catalogContract.projectCategories),
  createProjectCategory: (input: ProjectCategoryInput) => call(catalogContract.createProjectCategory, { body: input }),
  updateProjectCategory: (id: string, input: ProjectCategoryInput) =>
    call(catalogContract.updateProjectCategory, { params: { id }, body: input }),
  deleteProjectCategory: (id: string) => call(catalogContract.deleteProjectCategory, { params: { id } }),

  projects: () => call(catalogContract.projects),
  /** 新建项目时的 AI 分析：只读扫描本地目录，给出填好一半的表单 */
  analyzeProject: (path: string) => request<ProjectSuggestion>('/projects/analyze', json('POST', { path })),
  createProject: (input: ProjectInput) => call(catalogContract.createProject, { body: input }),
  updateProject: (id: string, input: ProjectInput, expectedUpdatedAt?: string) =>
    request<Project>(
      `/projects/${id}`,
      json('PUT', { ...input, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) }),
    ),
  /**
   * 只更新「AI 初始化」的结果：服务端自己读最新项目再合并，不会把用户这期间应用的推荐覆盖回旧值。
   * 初始化对话跑完才交回结果，传整份项目过去时它已经过期了。
   */
  saveProjectInitResult: (id: string, input: { initResult: ProjectProposal }) =>
    request<Project>(`/projects/${id}/init-result`, json('PUT', input)),
  /** 记一条项目教训（同名的会更新），返回更新后的项目 */
  addProjectLesson: (id: string, lesson: Partial<ProjectLesson> & { title: string }) =>
    request<Project>(`/projects/${id}/lessons`, json('POST', lesson)),
  /** 应用 AI 评审的一条建议，返回更新后的项目 */
  applyLessonReview: (id: string, item: LessonReviewItem) =>
    request<Project>(`/projects/${id}/lessons/review`, json('POST', { item })),
  globalLessons: () => request<GlobalLesson[]>('/global-lessons'),
  /** 全局教训只在用户确认后整份保存，confirmed 由确认按钮带上 */
  saveGlobalLessons: (lessons: GlobalLesson[]) =>
    request<GlobalLesson[]>('/global-lessons', json('PUT', { lessons, confirmed: true })),
  // 侧栏拖拽后的顺序：传全部项目的 id，服务端重新编号
  orderProjects: (ids: string[]) => call(catalogContract.orderProjects, { body: ids }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  /** 项目是不是 agent-panel 自己的源代码（AI 分析结果里多一个「补充进源代码」） */
  panelSource: (id: string) => request<{ panelSource: boolean }>(`/projects/${id}/panel-source`),

  allTasks,
  tasks: (projectId: string) => call(tasksContract.list, { query: { projectId } }),
  // 只拼真正给了的参数（urlOf 不带空值）：传空对象时不能拼出一个结尾的「?」
  task: (id: string, opts?: { limit?: number; before?: string }) =>
    call(tasksContract.page, { params: { id }, query: { limit: opts?.limit || undefined, before: opts?.before } }),
  /**
   * 一条后台命令的当前输出：界面上点命令行那一行标题打开的终端窗口按它轮询。
   * 命令结束后也读得到最终输出（用户可能过一阵才点开）
   */
  taskJob: (taskId: string, jobId: string) =>
    request<TaskJobView>(`/tasks/${taskId}/jobs/${encodeURIComponent(jobId)}`),
  /** 和实时推送的整份一样：更早的长工具输出只给开头（见 shared/task.ts 的 liteMessages） */
  taskLite: (id: string) => request<Task>(`/tasks/${id}?lite=1`),
  /** 总览页 Bug 视图：所有用户报的 Bug 的精简行（含子对话，见 shared/bug-overview.ts） */
  taskBugs: () => request<BugBrief[]>('/tasks/bugs'),
  /** 总览页流程视图：所有 Agent 模式对话的流程数据（shared/agent-flow-briefs.ts） */
  taskFlow: () => request<FlowBrief[]>('/tasks/flow'),
  /** 每个对话的磁盘占用 */
  taskDisk: () => request<TaskDiskItem[]>('/tasks/disk'),
  /** 保活中的会话（回复完 CLI 还留着等下一句）和各自进程的内存 */
  keepAlive: () => request<KeepAliveItem[]>('/tasks/keepalive'),
  /** 释放保活的会话：不给 ids 时放掉所有没开着页面的 */
  releaseKeepAlive: (ids?: string[]) =>
    request<{ released: string[] }>('/tasks/keepalive/release', json('POST', ids ? { ids } : {})),
  /** 推送里省掉的工具输出全文 */
  toolOutput: (id: string, msg: string, i: number) =>
    request<{ output: string }>(`/tasks/${id}/tool-output?msg=${encodeURIComponent(msg)}&i=${i}`),
  /** 整个运行的用量：父对话 + 所有子对话（含多层）+ 派出的子任务，带实时速度 */
  taskRunUsage: (id: string) => request<RunUsage>(`/tasks/${id}/run-usage`),
  /** 子对话（含多层）的统计合计：导出和 AI 分析时把它们的成本也算进去 */
  taskChildrenStats: (id: string) => request<StatsTotal>(`/tasks/${id}/children-stats`),
  /** 这个对话及附属（子对话、子任务、工作流起的）的进程和 CLI 内存合计；面板自身内存单独给、不计入，下拉展开时才调 */
  taskProcesses: (id: string) => request<TaskProcesses>(`/tasks/${id}/processes`),
  killTaskProcess: (id: string, pid: number) =>
    request<KillProcessResult>(`/tasks/${id}/processes/${pid}/kill`, json('POST', {})),
  /** 清理无效进程：pids 是用户在确认列表里勾选的，空表示清这个对话的全部残留 */
  cleanTaskProcesses: (id: string, pids: number[]) =>
    request<CleanProcessesResult>(`/tasks/${id}/processes/clean`, json('POST', { pids })),
  /** 所有对话里留下的 CLI 进程（任务不在跑、进程还活着）：设置里一处看全 */
  staleProcesses: () =>
    request<{
      processes: {
        pid: number
        command: string
        ownerTaskId: string
        ownerTitle: string
        startedAt: number
        rss: number | null
      }[]
      unavailable: string
    }>('/tasks/stale-processes'),
  cleanStaleProcesses: (pids: number[]) =>
    request<CleanProcessesResult>('/tasks/stale-processes/clean', json('POST', { pids })),
  /** AI 清理建议：只给建议，确认后前端再调 cleanTaskProcesses */
  suggestTaskProcesses: (id: string) =>
    request<ProcessSuggestResult>(`/tasks/${id}/processes/suggest`, json('POST', {})),
  /** 内存曲线的历史采样点 */
  taskMemory: (id: string, from?: number, to?: number) => {
    const q = new URLSearchParams()
    if (from) q.set('from', String(from))
    if (to) q.set('to', String(to))
    const qs = q.toString()
    return request<TaskMemoryHistory>(`/tasks/${id}/memory${qs ? `?${qs}` : ''}`)
  },
  /** 会话内存的 AI 分析报告：点「AI 分析」时现算，交给本机 CLI 体检 */
  taskMemoryAnalysis: (id: string) => request<TaskMemoryAnalysis>(`/tasks/${id}/memory-analysis`),
  /** 子对话栏：一行的字段由正式后端和演示后端共用的 shared/children/row.ts 拼 */
  taskChildren: (id: string) => call(tasksContract.children, { params: { id } }),
  stopChildren: (id: string) => call(tasksContract.stopChildren, { params: { id }, body: {} }),
  /** 终止对话派出的一个子任务：还在跑的结束，排队的不再开始，按「已终止」交回给对话 */
  stopSubtask: (id: string, step: string) => request<Task>(`/tasks/${id}/subtasks/stop`, json('POST', { step })),
  /** 终止对话里 start_plan 正在跑的工作流：只停这次运行，对话收到结果后自己决定改动留不留 */
  stopRun: (id: string) => request<Task>(`/tasks/${id}/runs/stop`, json('POST', {})),
  createTask: (input: NewTaskInput) => call(tasksContract.create, { body: input }),
  /** 定时计划：到点由面板自己新建对话，存到数据目录的 config/schedules.json */
  schedules: () => call(catalogContract.schedules),
  createSchedule: (input: ScheduleInput) => call(catalogContract.createSchedule, { body: input }),
  updateSchedule: (id: string, input: ScheduleInput) =>
    call(catalogContract.updateSchedule, { params: { id }, body: input }),
  deleteSchedule: (id: string) => call(catalogContract.deleteSchedule, { params: { id } }),
  /** 立即执行一条计划（不改排期）：返回更新后的计划和启动的对话 */
  runSchedule: (id: string) =>
    request<{ schedule: Schedule; taskId: string }>(`/schedules/${id}/run`, { method: 'POST' }),
  /** 导入别人导出的任务（连同包里的子对话），只读；projectId 为空放进聊天。返回父任务在前 */
  importTask: (projectId: string, bundle: unknown) =>
    request<Task[]>('/tasks/import', json('POST', { projectId, bundle })),
  /** 导出任务连同它分出的子对话：服务端整理成一个包，超过体积上限时直接报错 */
  taskExport: (id: string, app = '') =>
    request<{ bundle: TaskExport; bytes: number }>(`/tasks/${id}/export?app=${encodeURIComponent(app)}`),
  /** 对话页还开着：CLI 才能停在等下一句的工具上，切走后一分钟才结束 */
  setPresence: (id: string, viewerId: string, active: boolean) =>
    request<void>(`/tasks/${id}/presence`, json('POST', { viewerId, active })),
  /** 用户打开了这个对话：侧栏的橙点消失，服务端可以按宽限期回收 CLI 了。只回「看到哪」，整份对话不再传回来 */
  markTaskSeen: (id: string) => request<TaskSeenResult>(`/tasks/${id}/seen`, json('POST', {})),
  /** 打开旧对话时在后台用 --resume 启动，先停在等下一句上 */
  prewarmTask: (id: string) => request<Task>(`/tasks/${id}/prewarm`, { method: 'POST' }),
  /** 撤回到某条消息：返回撤回后的任务和被撤回的那条内容 */
  /** files：连同被撤掉那几轮改的文件一起撤；撤不干净时 ok 为 false，什么都没动 */
  rewindTask: (id: string, messageId: string, files = false) =>
    request<
      | { ok: true; task: Task; text: string; attachments: Attachment[] }
      | { ok: false; conflicts: { path: string; reason: string }[] }
    >(`/tasks/${id}/rewind`, json('POST', { messageId, files })),
  forkTask: (id: string, messageId: string) => request<Task>(`/tasks/${id}/fork`, json('POST', { messageId })),
  compactTask: (id: string) => request<Task>(`/tasks/${id}/compact`, json('POST', {})),
  reviewTask: (id: string, base = '') => request<Task>(`/tasks/${id}/review`, json('POST', base ? { base } : {})),
  /** 结束工作流：没完成的节点不再执行 */
  endFlow: (id: string) => request<Task>(`/tasks/${id}/end-flow`, json('POST', {})),
  upload: (input: { name: string; mime: string; data: string }) => request<Attachment>('/uploads', json('POST', input)),
  /** 在面板所在的本机弹出系统的文件选择框，返回选中文件的绝对路径（取消时为空） */
  pickFiles: () => request<{ files: Attachment[] }>('/uploads/pick', json('POST', {})),
  /** 粘贴进输入框的路径：哪些是本机真实存在的文件（from 是粘贴时写的原样） */
  resolvePaths: (paths: string[]) =>
    request<{ files: (Attachment & { from: string })[] }>('/uploads/resolve', json('POST', { paths })),
  /** 用系统默认程序打开附件（可执行文件改成在文件夹里显示），reveal 时直接在文件夹里显示 */
  openLocalFile: (path: string, reveal = false) =>
    request<{ ok: boolean; revealed: boolean }>('/uploads/open', json('POST', { path, reveal })),
  /** 粘贴、拖进来的大文件：按名字、大小、修改时间在本机找回原路径（index 对应传入的第几个，找不到的不在里面） */
  locateFiles: (files: { name: string; size: number; mtime?: number }[], opts: { loose?: boolean } = {}) =>
    request<{ files: (Attachment & { index: number })[] }>('/uploads/locate', json('POST', { files, ...opts })),
  /** 小文件后台拷贝一份到数据目录：只接受 pick / resolve / locate 返回过的路径，拷不了的不在结果里 */
  copyPaths: (paths: string[]) =>
    request<{ files: (Attachment & { from: string })[] }>('/uploads/copy', json('POST', { paths })),
  /** 输入框里删掉还没发出去的附件：把拷出来的副本删掉，不留孤儿 */
  discardPaths: (paths: string[]) => request<{ ok: boolean }>('/uploads/discard', json('POST', { paths })),
  /** 附件、粘贴引用的本机文件：读文字内容，点文件卡片时看 */
  localFile: (path: string) =>
    request<FileContent & { dir: string }>(`/uploads/raw/file?path=${encodeURIComponent(path)}`),
  /** 引入会话：把任务的对话整理成一份附件 */
  taskTranscript: (id: string) => request<Attachment>(`/tasks/${id}/transcript`, json('POST', {})),
  projectFiles: (projectId: string, q: string) =>
    request<string[]>(`/projects/${projectId}/files?q=${encodeURIComponent(q)}`),
  /** 文件浏览页：项目的目录、分支和是不是 git 仓库（文件按层读） */
  fileTree: (projectId: string) => request<FileTree>(`/project-files/${projectId}`),
  /** 列一层：展开目录时读它的直接子项；refresh 时不用缓存的状态 */
  fileLevel: (projectId: string, path: string, refresh = false) =>
    request<DirLevel>(
      `/project-files/${projectId}/list?path=${encodeURIComponent(path)}${refresh ? '&refresh=1' : ''}`,
    ),
  /** 按文件名搜索：服务端搜，还没展开的深层文件也能找到 */
  searchFileNames: (projectId: string, q: string) =>
    request<NameSearch>(`/project-files/${projectId}/search?mode=name&q=${encodeURIComponent(q)}`),
  /** 按文件内容搜索 */
  searchFileContent: (projectId: string, q: string) =>
    request<ContentSearch>(`/project-files/${projectId}/search?mode=content&q=${encodeURIComponent(q)}`),
  /** 在系统的文件管理器里打开文件或目录；不传路径时打开项目目录 */
  revealProjectFile: (projectId: string, path = '') =>
    request<{ ok: boolean; dir: string }>(`/project-files/${projectId}/reveal?path=${encodeURIComponent(path)}`, {
      method: 'POST',
    }),
  projectFile: (projectId: string, path: string) =>
    request<FileContent>(`/project-files/${projectId}/content?path=${encodeURIComponent(path)}`),
  /** 保存文件内容：编码和换行按项目设置，原文件是 CRLF 时按原样回写 */
  writeProjectFile: (projectId: string, path: string, content: string, mtime?: string) =>
    request<{ path: string; size: number }>(
      `/project-files/${projectId}/content`,
      json('PUT', { path, content, mtime }),
    ),
  /** 在目录里新建文件；同名时后端拒绝，不会覆盖 */
  createProjectFile: (projectId: string, dir: string, name: string, content = '') =>
    request<{ path: string; size: number }>(`/project-files/${projectId}/new`, json('POST', { dir, name, content })),
  /**
   * 把一段内容存进项目（Chat 右栏的「存到项目」）：dir 是项目里的相对目录，缺的中间目录一并建好；
   * 同名文件只有 overwrite 才改写，否则后端拒绝
   */
  saveProjectFile: (projectId: string, dir: string, name: string, content: string, overwrite: boolean) =>
    request<{ path: string; size: number }>(
      `/project-files/${projectId}/new`,
      json('POST', { dir, name, content, parents: true, overwrite }),
    ),
  /** 新建目录；同名时后端拒绝 */
  createProjectDir: (projectId: string, dir: string, name: string) =>
    request<{ path: string }>(`/project-files/${projectId}/mkdir`, json('POST', { dir, name })),
  /** 改名；目标已存在时后端拒绝 */
  renameProjectFile: (projectId: string, path: string, name: string) =>
    request<{ path: string }>(`/project-files/${projectId}/rename`, json('POST', { path, name })),
  /** 删除：文件直接删，目录必须为空 */
  deleteProjectFile: (projectId: string, path: string) =>
    request<{ ok: true }>(`/project-files/${projectId}/delete`, json('POST', { path })),
  /** 和 git 比一个文件的差异；不是 git 仓库或文件还没提交过时 git 为 false */
  projectFileDiff: (projectId: string, path: string) =>
    request<FileDiff>(`/project-files/${projectId}/diff?path=${encodeURIComponent(path)}`),
  /** 项目里的图片：按原图查看（给 <img> 用，没有走 request，路径要自己带上 /api） */
  projectFileRaw: (projectId: string, path: string) =>
    `/api/project-files/${projectId}/raw?path=${encodeURIComponent(path)}`,
  stopTask: (id: string, force = false) =>
    request<Task>(`/tasks/${id}/stop${force ? '?force=1' : ''}`, { method: 'POST' }),
  resumeTask: (id: string, latest = false) => request<Task>(`/tasks/${id}/resume`, json('POST', { latest })),
  taskCollab: (id: string) => request<{ rootId: string; events: CollabEvent[] }>(`/tasks/${id}/collab`),
  /** 状态诊断：这棵对话树每个节点的 CLI 生命周期（见 shared/lifecycle.ts） */
  taskLifecycle: (id: string) => request<LifeReport>(`/tasks/${id}/lifecycle`),
  /** 生成诊断文件并放进系统剪贴板；copied 为 false 时只拿到路径 */
  lifecycleFile: (id: string) =>
    request<{ path: string; copied: boolean }>(`/tasks/${id}/lifecycle/file`, json('POST', {})),
  /** 「AI 分析」选中节点：服务端写好诊断文件、整理成 AI 处理的输入（见 server/tasks/lifecycle-ai.ts） */
  lifecycleAnalysis: (id: string, node: string) =>
    request<{ title: string; topic: string; ask: string; error: string; output: string; context: string; cwd: string }>(
      `/tasks/${id}/lifecycle/analysis`,
      json('POST', { node }),
    ),
  /** 在文件管理器里打开诊断文件所在的目录 */
  lifecycleReveal: (id: string) => request<{ ok: boolean }>(`/tasks/${id}/lifecycle/reveal`, json('POST', {})),
  taskSession: (id: string, cli: string) => request<SessionInfo>(`/tasks/${id}/session?cli=${encodeURIComponent(cli)}`),
  taskDiff: (id: string, path: string) =>
    request<{ path: string; dir: string; diff: string; git: boolean; before: boolean }>(
      `/tasks/${id}/diff?path=${encodeURIComponent(path)}`,
    ),
  /** 一轮改动里一个文件的差异（总结下面的改动卡片） */
  turnDiff: (id: string, msg: string, path: string) =>
    request<{ path: string; diff: string }>(
      `/tasks/${id}/turn-diff?msg=${encodeURIComponent(msg)}&path=${encodeURIComponent(path)}`,
    ),
  /** 撤销一轮的改动：有文件撤不干净时 ok 为 false，列出冲突的文件，一个都没动 */
  convDiff: (id: string, path: string) =>
    request<{ path: string; diff: string }>(`/tasks/${id}/conv-diff?path=${encodeURIComponent(path)}`),
  convRevert: (id: string) =>
    request<{ ok: true; task: Task; files: string[] } | { ok: false; conflicts: { path: string; reason: string }[] }>(
      `/tasks/${id}/conv-revert`,
      json('POST', {}),
    ),
  turnRevert: (id: string, msg: string) =>
    request<{ ok: true; task: Task; files: string[] } | { ok: false; conflicts: { path: string; reason: string }[] }>(
      `/tasks/${id}/turn-revert`,
      json('POST', { msg }),
    ),
  taskFile: (id: string, path: string) =>
    request<
      FileContent & {
        dir: string
        /** 任务目录里的文件能在弹窗里改；附件、项目外的文件只读 */
        editable?: boolean
      }
    >(`/tasks/${id}/file?path=${encodeURIComponent(path)}`),
  /** 文件弹窗里保存：只能写任务目录里已有的文件，编码和换行按项目设置 */
  writeTaskFile: (id: string, path: string, content: string, mtime?: string) =>
    request<{ path: string; size: number }>(`/tasks/${id}/file`, json('PUT', { path, content, mtime })),
  /** 文件弹窗的「查看改动」：任务目录里的文件和 git 的 HEAD 比 */
  taskFileDiff: (id: string, path: string) =>
    request<FileDiff>(`/tasks/${id}/file/diff?path=${encodeURIComponent(path)}`),
  /** 排查结论的「应用这 N 处修改」：在被分析对话的目录里逐条按原文替换，每条给出结果 */
  applyFixes: (id: string, fixes: FixApplyItem[]) =>
    request<{ dir: string; results: FixApplyResult[] }>(`/tasks/${id}/apply-fixes`, json('POST', { fixes })),
  /** 任务目录里的图片：读到的文件是图片时按原图查看（同样给 <img> 用，路径自己带 /api） */
  taskFileRaw: (id: string, path: string) => `/api/tasks/${id}/file/raw?path=${encodeURIComponent(path)}`,
  /** 任务页右栏的根信息：任务工作目录（独立分支时是 worktree）的目录和分支 */
  taskFiles: (id: string) => request<FileTree>(`/tasks/${id}/files`),
  /** 任务目录里列一层 */
  taskFileLevel: (id: string, path: string, refresh = false) =>
    request<DirLevel>(`/tasks/${id}/files/list?path=${encodeURIComponent(path)}${refresh ? '&refresh=1' : ''}`),
  /** 任务目录里按文件名搜索 */
  searchTaskFileNames: (id: string, q: string) =>
    request<NameSearch>(`/tasks/${id}/files/search?mode=name&q=${encodeURIComponent(q)}`),
  /** 任务目录里按文件内容搜索 */
  searchTaskFiles: (id: string, q: string) =>
    request<ContentSearch>(`/tasks/${id}/files/search?mode=content&q=${encodeURIComponent(q)}`),
  /** 在系统的文件管理器里打开这个文件所在的文件夹并选中它；不传路径时打开任务目录 */
  revealTaskFile: (id: string, path = '') =>
    request<{ ok: boolean; dir: string }>(`/tasks/${id}/reveal`, json('POST', { path })),
  revertFile: (id: string, path: string) => request<Task>(`/tasks/${id}/revert`, json('POST', { path })),
  /** 同一个目录里正在改文件的别的对话（输入框上方的提醒，见 shared/shared-dir.ts） */
  sharedDir: (id: string) => request<SharedDirInfo>(`/tasks/${id}/shared-dir`),
  /** 这个对话开独立分支：下一句起在分支的目录里做 */
  isolateTask: (id: string) => request<Task>(`/tasks/${id}/isolate`, json('POST', {})),
  /** 这个对话和它名下子对话的独立分支，带上是否已经合回原分支 */
  taskWorktrees: (id: string) => request<{ items: WorktreeItem[] }>(`/tasks/${id}/worktrees`),
  /** 把独立分支合回原分支；分支和目录保留。冲突时错误的 body 带 conflict */
  mergeWorktree: (id: string) => request<{ task: Task; into: string }>(`/tasks/${id}/worktree/merge`, json('POST', {})),
  /** 删除独立分支（连目录一起） */
  discardWorktree: (id: string) => request<Task>(`/tasks/${id}/worktree/discard`, json('POST', {})),
  /** 诊断报告（ADR 0045）：确认方案或带着标注退回；返回交给子对话的话，页面再作为消息发给它 */
  decideDiagnosis: (
    id: string,
    version: number,
    // cancel：这次不修，计划标完成，返回的 message 为空（不用发给子对话）
    body: DiagnosisDecision,
  ) => request<{ task: Task; message: string }>(`/tasks/${id}/diagnosis/${version}`, json('POST', body)),
  /** 点「取消修复」前：面板只读地查出代码里的临时日志、这个对话新建的文件（确认框里列出来） */
  cleanupPreview: (id: string) =>
    request<{ found: { file: string; line: number; text: string }[]; created: string[]; isolated: boolean }>(
      `/tasks/${id}/diagnosis-cleanup`,
    ),
  /** 临时日志没删干净：retry 让它再删一次（返回交给它的话），finish 不再删、直接关闭报告 */
  cleanupAction: (id: string, action: 'retry' | 'finish') =>
    request<{ task: Task; message: string }>(`/tasks/${id}/diagnosis-cleanup`, json('POST', { action })),
  /** 排查补丁（分析稿 B1）：独立分支里的临时日志 / 修复有没有放在你的工作区里；不是 Git 独立分支的对话 eligible 为 false */
  patchStatus: (id: string) => request<PatchStatus>(`/tasks/${id}/diagnosis-patch`),
  /** apply 放到工作区、restore 还原、forget 我自己处理（不再记）；ok 为 false 时什么都没动，reason 是说明 */
  patchAction: (id: string, action: 'apply' | 'restore' | 'forget') =>
    request<PatchResult>(`/tasks/${id}/diagnosis-patch`, json('POST', { action })),
  /** 面板自己取日志（分析稿 B3）：之前点没点过「开始复现」 */
  logWatchStatus: (id: string) => request<LogWatchStatus>(`/tasks/${id}/diagnosis-log`),
  /** start 记下日志文件现在多大，fetch 取新增的部分；confirm：报告里写的文件在项目目录外面，用户点了确认 */
  logWatch: <A extends 'start' | 'fetch'>(id: string, action: A, confirm = false) =>
    request<A extends 'start' ? LogStartResult : LogFetchResult>(
      `/tasks/${id}/diagnosis-log`,
      json('POST', { action, confirm }),
    ),
  answerRequest: (
    id: string,
    rid: string,
    body: { allow: boolean; answer?: string; answers?: string[]; always?: boolean; ask?: boolean },
  ) => request<Task>(`/tasks/${id}/requests/${rid}`, json('POST', body)),
  /** 父对话名下的工作流运行（不进对话列表）；delegateRun：节点确认交给父对话决定 */
  flowRuns: (ownerId: string) => request<Task[]>(`/tasks?owner=${encodeURIComponent(ownerId)}`),
  delegateRun: (id: string) => request<{ ok: boolean; info: string }>(`/tasks/${id}/delegate`, json('POST', {})),
  /**
   * 子对话请父对话决定的提问：直接回答（交给子对话），或者交给父对话的 AI 决定。
   * nudge 说明父对话叫起来了没有：没叫起来时卡片上要把原因显示给用户，不能只当成功处理
   */
  answerChildAsk: (id: string, mid: string, body: { answer: string; delegate: boolean }) =>
    request<{ task: Task; nudge?: ChildAskNudge }>(`/tasks/${id}/child-asks/${mid}`, json('POST', body)),
  /** 子对话请用户决定的提问，用户点了关闭：都不回答，子对话终止 */
  closeParentAsks: (id: string) => request<Task>(`/tasks/${id}/parent-asks/close`, { method: 'POST' }),
  setTaskAskUser: (id: string, askUser: boolean) => request<Task>(`/tasks/${id}`, json('PATCH', { askUser })),
  /** 父对话右键菜单的「子对话也提问」：applyExisting 表示已创建的子对话也一起打开 */
  setTaskChildAskUser: (id: string, childAskUser: boolean, applyExisting: boolean) =>
    request<Task>(`/tasks/${id}`, json('PATCH', { childAskUser, applyChildAsk: applyExisting })),
  /** 任务页以外的会话（UI 设计、AI 创建…）在等用户的审批和提问 */
  asks: (scope: string) => request<TaskRequest[]>(`/asks?scope=${encodeURIComponent(scope)}`),
  answerAsk: (id: string, body: { allow: boolean; answer?: string; answers?: string[] }) =>
    request<{ ok: true }>(`/asks/${id}`, json('POST', body)),
  /** 提问窗口的关闭：这个问题不回答，这次会话终止 */
  closeAsk: (id: string) => request<{ ok: true }>(`/asks/${id}/close`, { method: 'POST' }),
  setAskUser: (scope: string, askUser: boolean) => request<{ ok: true }>('/asks/flag', json('PUT', { scope, askUser })),
  /** 父对话的设置：目标、全局规则、子对话的执行配置 */
  updateConversation: (id: string, patch: Pick<TaskPatch, 'goal' | 'rules' | 'childRun' | 'title'>) =>
    request<Task>(`/tasks/${id}`, json('PATCH', patch)),
  renameTask: (id: string, title: string) => request<Task>(`/tasks/${id}`, json('PATCH', { title })),
  archiveTask: (id: string, archived: boolean) => request<Task>(`/tasks/${id}`, json('PATCH', { archived })),
  /**
   * 侧栏、列表用的版本：只回摘要（不带对话），改个名、归档、暂停不用把整段对话传过来。
   * 任务页要完整任务，用上面那些
   */
  renameTaskSummary: (id: string, title: string) => request<Task>(`/tasks/${id}?summary=1`, json('PATCH', { title })),
  archiveTaskSummary: (id: string, archived: boolean) =>
    request<Task>(`/tasks/${id}?summary=1`, json('PATCH', { archived })),
  /** 聊天置顶 / 取消置顶：只是标记，侧栏聊天列表最上面单独一组 */
  pinTaskSummary: (id: string, pinned: boolean) => request<Task>(`/tasks/${id}?summary=1`, json('PATCH', { pinned })),
  stopTaskSummary: (id: string) => request<Task>(`/tasks/${id}/stop?summary=1`, { method: 'POST' }),
  /** 对话菜单「激活 Agent」：不发消息，先用 --resume 把 CLI 拉起来停在等下一句上 */
  activateAgentSummary: (id: string) => request<Task>(`/tasks/${id}/agent/activate?summary=1`, json('POST', {})),
  /** 对话菜单「关闭 Agent」：结束 CLI 进程释放资源，对话留着，下一条消息续接会话 */
  closeAgentSummary: (id: string) => request<Task>(`/tasks/${id}/agent/close?summary=1`, json('POST', {})),
  resumeTaskSummary: (id: string) => request<Task>(`/tasks/${id}/resume?summary=1`, json('POST', { latest: false })),
  discardWorktreeSummary: (id: string) => request<Task>(`/tasks/${id}/worktree/discard?summary=1`, json('POST', {})),
  /** 子对话的「解决」标记：只改标记，不停 CLI、不影响父对话 */
  resolveTask: (id: string, resolved: boolean) => request<Task>(`/tasks/${id}`, json('PATCH', { resolved })),
  setChatRun: (id: string, run: { cli: string; model: string; effort: string }) =>
    request<Task>(`/tasks/${id}`, json('PATCH', run)),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
  /** 回收站：进回收站还没到期的对话（删掉的对话不丢，7 天内能恢复） */
  trash: () => request<TrashRow[]>('/tasks/trash'),
  /** 从回收站恢复；worktreeCleared 表示独立分支目录已经没了，恢复后要重新执行 */
  restoreTask: (id: string) => request<{ worktreeCleared: boolean }>(`/tasks/${id}/restore`, { method: 'POST' }),
  /** 删掉的角色、工作流、项目（对话的回收站在上面）：保留期和对话一样 */
  itemTrash: () =>
    request<
      {
        kind: 'agent' | 'workflow' | 'project'
        id: string
        name: string
        deletedAt: string
        tasks: number
        leftDays: number
      }[]
    >('/trash/items'),
  restoreItem: (kind: string, id: string) =>
    request<{ ok: true; tasks: number }>(`/trash/items/${kind}/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  purgeItem: (kind: string, id: string) =>
    request<void>(`/trash/items/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 永久删除：不进回收站，内容直接清掉（界面先让用户二次确认） */
  permanentDeleteTask: (id: string) => request<void>(`/tasks/${id}/permanent`, { method: 'DELETE' }),
  /** 搜对话正文：只回命中片段和定位信息，不回整条消息（口径见 shared/task-search.ts） */
  searchTasks: (q: string, limit?: number) =>
    request<{ hits: SearchHit[]; scanned: number; more: boolean }>(
      `/tasks/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`,
    ),

  assist: (input: AssistInput) => request<AssistJob>('/assist', json('POST', input)),
  assistJob: (id: string) => request<AssistJob>(`/assist/${id}`),
  /** 在项目对话里做的生成：第一句话由服务端按现有数据拼好 */
  assistPrompt: (input: Omit<AssistInput, 'cli' | 'model' | 'effort' | 'askUser' | 'targetId'>) =>
    request<{ prompt: string }>('/assist/prompt', json('POST', input)),
  /** 把对话最后一条回复解析成推荐（格式不对时给出原因） */
  assistResolve: (input: Omit<AssistInput, 'cli' | 'model' | 'effort' | 'askUser' | 'targetId'> & { text: string }) =>
    request<{ proposal?: Proposal; error?: string }>('/assist/resolve', json('POST', input)),
  stopAssist: (id: string) => request<AssistJob>(`/assist/${id}/stop`, { method: 'POST' }),
  /** 执行中插话：ok 为 false 时 CLI 收不下，页面排到下一轮；at 是插进去时已有几条消息 */
  steerAssist: (id: string, text: string) =>
    request<{ ok: boolean; at: number }>(`/assist/${id}/steer`, json('POST', { text })),
  projectDocs: (projectId: string) => request<ProjectDocs>(`/project-docs/${projectId}`),
  saveProjectDoc: (projectId: string, path: DocFile, content: string) =>
    request<ProjectDoc>(`/project-docs/${projectId}`, json('PUT', { path, content })),
  /** P4 / SVN 各分支共用的文档根（文档放在项目外时才有，别的项目是 null） */
  docGroup: (projectId: string) => request<DocGroupView | null>(`/project-docs/${projectId}/doc-group`),
  setDocGroupRoot: (projectId: string, root: string) =>
    request<DocGroupView>(`/project-docs/${projectId}/doc-group`, json('PUT', { root })),
  optimizeDoc: (projectId: string, input: DocOptimizeInput) =>
    request<DocJob>(`/project-docs/${projectId}/optimize`, json('POST', input)),
  deployState: () => request<DeployState>('/deploy'),
  skillUpdates: () => request<SkillUpdates>('/deploy/updates'),
  saveDeploy: (c: DeployConfig) => request<DeployState>('/deploy', json('PUT', c)),
  runDeploy: (r: DeployRun) => request<{ result: DeployResult; state: DeployState }>('/deploy/run', json('POST', r)),
  optimizeGlobalDoc: (input: GlobalDocOptimize) => request<DocJob>('/deploy/optimize', json('POST', input)),
  docJob: (id: string) => request<DocJob>(`/doc-jobs/${id}`),
  aiFix: (input: Partial<FixInput> & { title: string }) => request<FixStart>('/ai-fix', json('POST', input)),
  stopDocJob: (id: string) => request<DocJob>(`/doc-jobs/${id}/stop`, { method: 'POST' }),

  inspectDir: (path: string) => request<DirInfo>(`/fs/inspect?path=${encodeURIComponent(path)}`),
  // 目录的版本控制类型（'git' / 'p4' / 'svn' / 'none'）：判断只在 Git 项目生效的设置项
  dirVcs: (path: string) =>
    request<{ vcs: 'git' | 'p4' | 'svn' | 'none'; root: string }>(`/fs/vcs?path=${encodeURIComponent(path)}`),
  dirBranches: (path: string) => request<DirBranches>(`/fs/branches?path=${encodeURIComponent(path)}`),
  checkoutBranch: (path: string, branch: string) => request<DirInfo>('/fs/checkout', json('POST', { path, branch })),
  listDir: (path: string) => request<DirListing>(`/fs/list?path=${encodeURIComponent(path)}`),
  makeDir: (parent: string, name: string) => request<{ path: string }>('/fs/mkdir', json('POST', { parent, name })),
  dataUsage: () => request<DataUsage>('/data'),
  /** 只取内存采样（最新一个 + 序列 + 面板规模）：内存曲线按采样间隔刷新用它，不遍历数据目录 */
  memoryUsage: () => request<MemoryUsage>('/data/memory'),
  revealData: () => request<{ ok: boolean; dir: string }>('/data/reveal', json('POST', {})),
  revealLogs: () => request<{ ok: boolean; dir: string }>('/data/reveal-logs', json('POST', {})),
  clearData: (kind: DataKind) => request<{ ok: boolean }>('/data/clear', json('POST', { kind })),
  /** 清理面板：对话工作目录 Top N + 构建产物（逐个目录 stat，比 /data 重，但不扫独立分支） */
  cleanupReport: () => request<CleanupReport>('/data/cleanup'),
  /** 独立分支的占用和可清清单：要跑 git 判定、递归四 GB，只在用户点「检查」时取 */
  worktreeCleanup: () => request<WorktreeCleanup>('/data/cleanup/worktrees'),
  /** 清一个对话的工作目录：只删目录内容，对话记录还在，下次执行时重建 */
  clearChatWorkspace: (id: string) =>
    request<{ ok: boolean; bytes: number }>('/data/cleanup/chat', json('POST', { id })),
  clearStaleWorktrees: () =>
    request<{ ok: boolean; removed: number; failed: number; bytes: number }>(
      '/data/cleanup/worktrees',
      json('POST', {}),
    ),
  clearBuildOutputs: () => request<{ ok: boolean; bytes: number }>('/data/cleanup/builds', json('POST', {})),
  exportData: (kinds: DataKind[]) => request<unknown>(`/data/export?kinds=${kinds.join(',')}`),
  importData: (backup: unknown) =>
    request<{ ok: boolean; kinds: DataKind[]; files: number }>('/data/import', json('POST', backup)),
  /** 设置里的用量统计：按天 / 周 / 月聚合各轮执行的 token（也可以按项目 / 对话分组；聚合在服务端做） */
  tokenUsage: (q: { grain: UsageGrain; count: number; groupBy?: UsageGroup }) =>
    request<UsageReport>(`/usage?grain=${q.grain}&count=${q.count}${q.groupBy ? `&groupBy=${q.groupBy}` : ''}`),
  // 风格库、浏览器扩展（api-styles.ts）
  ...stylesApi,
  revealProject: (projectId: string) =>
    request<{ ok: boolean; dir: string }>('/fs/reveal', json('POST', { projectId })),
  // 工作总结、候选教训草稿（api-summary.ts）
  ...summaryApi,
  ...pathsApi,
  ...messagesApi,
  ...remoteApi,
}
