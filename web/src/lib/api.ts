import type { ShellReport } from '@shared/shells'
import type { ComfyWorkflow, LocalStatus } from '@shared/local-image'
import type { InstalledPackage } from '@shared/cli-spec'
import type { ProjectSuggestion } from '@shared/project-scan'
import type {
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
  Agent,
  AgentInput,
  Category,
  Tag,
  TagInput,
  CliStatus,
  DirBranches,
  DirInfo,
  DirListing,
  Project,
  ProjectCategory,
  ProjectCategoryInput,
  ProjectInput,
  GlobalLesson,
  ProjectLesson,
  Settings,
  NewTaskInput,
  Task,
  TaskPatch,
  Workflow,
  WorkflowInput,
} from '@shared/schema'
import type { ChildActivity } from '@shared/task'
import type { RunUsage } from '@shared/run-usage'
import type { AssistInput, AssistJob } from '@shared/assist'
import type { ContentSearch, DirLevel, FileContent, FileDiff, FileTree, NameSearch } from '@shared/files'
import type { DeployConfig, DeployResult, DeployRun, DeployState, GlobalDocOptimize } from '@shared/deploy'
import type { ApiConfig, ApiProtocol, DetectedApi } from '@shared/accounts'
import type { ApiBalance } from '@shared/api-balance'
import type { ModelCatalogInfo, ModelLookupJob } from '@shared/model-catalog'
import type { RemoteAccessStatus } from '@shared/remote'
import type { IntegrationInstallJob, IntegrationLoginJob, IntegrationView } from '@shared/integrations'
import type { FixInput, FixStart } from '@shared/fix'
import type {
  BundledSkill,
  LibraryCli,
  LibraryFile,
  LibraryItem,
  McpOverview,
  McpServer,
  McpTestResult,
} from '@shared/library'
import type {
  BrowserStatus,
  Design,
  DesignChatInput,
  DesignDoc,
  DesignJob,
  DesignMeta,
  DesignProject,
  DesignProjectInput,
  DesignVersion,
  DesignVersionMeta,
  ImageSource,
  NewDesignInput,
  SavedStyle,
  SavedStyleInput,
  ProjectComponents,
  ProjectPrompt,
  PromptAiInput,
} from '@shared/design'
import type { DocFile, DocJob, DocOptimizeInput, ProjectDoc, ProjectDocs } from '@shared/docs'
import type { DataKind, DataUsage, MemoryUsage } from '@shared/data'
import type { UsageGrain, UsageReport } from '@shared/usage'
import type { AppReleases, AppUpdateBusy, AppUpdateJob, InterruptedTasks } from '@shared/version'
import { t } from '@shared/i18n'

/** 设计连同正在进行的 AI 对话 / 生成图片 */
export type DesignFull = Design & { job: DesignJob | null }

/** 设计里图片文件的地址（在线演示里是内存里的 data URL） */
export const designFileUrl = (id: string, file: string) =>
  file.startsWith('data:') ? file : `/api/designs/${id}/files/${file}`
/** 导出下载的地址；在线演示没有后端，由页面自己打包 */
export const designExportUrl = (id: string, format: 'zip' | 'json' | 'react') =>
  `/api/designs/${id}/export?format=${format}`

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // 在线演示版没有后端，请求交给浏览器里的模拟实现
  if (import.meta.env.VITE_DEMO) {
    const { handle } = await import('./demo-backend')
    return handle(init?.method ?? 'GET', url, init?.body ? JSON.parse(init.body as string) : undefined) as Promise<T>
  }
  const res = await fetch(`/api${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    // 把响应体挂到错误上：有些接口（例如更新撞上「已经在更新」）会在里面带上要继续处理的信息
    const err = new Error(body.error ?? t('请求失败（{status}）', { status: res.status })) as Error & {
      status?: number
      body?: unknown
    }
    err.status = res.status
    err.body = body
    throw err
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })

/** 一个独立分支（git worktree）和它在 git 里的实际情况 */
export interface WorktreeItem {
  taskId: string
  title: string
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
}

/** 用户加的 CLI 配置：原文（页面拿去注册）、读不进来的原因、所在目录 */
export interface UserClis {
  specs: unknown[]
  errors: string[]
  dir: string
}

export const api = {
  settings: () => request<Settings>('/settings'),
  saveSettings: (s: Settings) => request<Settings>('/settings', json('PUT', s)),
  shells: (fresh = false) => request<ShellReport>(`/shells${fresh ? '?fresh=1' : ''}`),

  remoteStatus: () => request<RemoteAccessStatus>('/remote/status'),
  remoteCheck: () => request<RemoteAccessStatus>('/remote/check', { method: 'POST' }),
  remoteInstall: () => request<RemoteAccessStatus>('/remote/install', { method: 'POST' }),

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
  localImageAction: (action: 'install' | 'cancel' | 'start' | 'stop' | 'detect') =>
    request<LocalStatus>(`/local-image/${action}`, { method: 'POST' }),
  localModel: (id: string, action: 'download' | 'remove') =>
    request<LocalStatus>(`/local-image/models/${id}${action === 'download' ? '/download' : ''}`, {
      method: action === 'download' ? 'POST' : 'DELETE',
    }),

  comfyWorkflows: () => request<{ list: ComfyWorkflow[]; ready: string[] }>('/local-image/workflows'),
  saveComfyWorkflow: (w: ComfyWorkflow) =>
    request<ComfyWorkflow>(`/local-image/workflows/${encodeURIComponent(w.id)}`, json('PUT', w)),
  deleteComfyWorkflow: (id: string) =>
    request<{ ok: boolean }>(`/local-image/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assistComfyWorkflow: (body: { kind: 'game' | 'web'; instruction: string; base?: ComfyWorkflow }) =>
    request<{ workflow: ComfyWorkflow; note: string }>('/local-image/workflows/assist', json('POST', body)),

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
  /** 查 API 账户余额（服务端带上密钥去请求，页面拿不到密钥也不直连第三方） */
  apiBalance: (a: Pick<ApiConfig, 'name' | 'apiKey'>) => request<ApiBalance>('/accounts/api-balance', json('POST', a)),
  applyApi: (id: string) => request<{ clis: string[] }>(`/accounts/apis/${id}/apply`, json('POST', {})),
  /** mode 给出时按这种登录方式读（设置页切换后还没保存也能先读到） */
  cliModels: (id: string, refresh = false, mode?: { authMode: 'account' | 'api'; apiId?: string }) => {
    const q = new URLSearchParams()
    if (refresh) q.set('refresh', '1')
    if (mode) q.set('auth', mode.authMode)
    if (mode?.authMode === 'api') q.set('api', mode.apiId ?? '')
    const qs = q.toString()
    return request<CliModels>(`/clis/${id}/models${qs ? `?${qs}` : ''}`)
  },
  /** 模型目录：内置的加上用户补充的 */
  modelCatalog: () => request<ModelCatalogInfo>('/model-catalog'),
  lookupModel: (body: { model: string; protocol?: ApiProtocol; cli?: string }) =>
    request<ModelLookupJob>('/model-catalog/lookup', json('POST', body)),
  modelLookup: (id: string) => request<ModelLookupJob>(`/model-catalog/lookup/${id}`),
  stopModelLookup: (id: string) => request<ModelLookupJob>(`/model-catalog/lookup/${id}/stop`, { method: 'POST' }),
  cliLimits: (id: string) => request<CliLimits | null>(`/clis/${id}/limits`),
  /** 用户在数据目录 config/clis/ 里加的 CLI 配置 */
  cliSpecs: () => request<UserClis>('/clis/specs'),
  reloadCliSpecs: () => request<UserClis>('/clis/specs/reload', json('POST', {})),
  revealCliSpecs: () => request<{ ok: boolean }>('/clis/specs/reveal', json('POST', {})),
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
  /** MCP 工具 */
  mcpTools: () => request<McpOverview>('/mcp-tools'),
  saveMcpTool: (server: McpServer, clis: string[]) =>
    request<McpOverview>(`/mcp-tools/${encodeURIComponent(server.name)}`, json('PUT', { server, clis })),
  deleteMcpTool: (name: string) => request<McpOverview>(`/mcp-tools/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  testMcpTool: (server: McpServer) => request<McpTestResult>('/mcp-tools/test', json('POST', server)),

  appVersion: () => request<{ current: string; packaged: boolean; previous?: string }>('/app/version'),
  appReleases: (refresh = false) => request<AppReleases>(`/app/releases${refresh ? '?refresh=1' : ''}`),
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

  categories: () => request<Category[]>('/categories'),
  createCategory: (name: string, scope: Category['scope'] = 'agent') =>
    request<Category>('/categories', json('POST', { name, scope })),
  renameCategory: (id: string, name: string) => request<Category>(`/categories/${id}`, json('PUT', { name })),
  deleteCategory: (id: string) => request<void>(`/categories/${id}`, { method: 'DELETE' }),

  tags: () => request<Tag[]>('/tags'),
  createTag: (input: TagInput) => request<Tag>('/tags', json('POST', input)),
  updateTag: (id: string, input: TagInput) => request<Tag>(`/tags/${id}`, json('PUT', input)),
  deleteTag: (id: string) => request<void>(`/tags/${id}`, { method: 'DELETE' }),

  agents: () => request<Agent[]>('/agents'),
  createAgent: (input: AgentInput) => request<Agent>('/agents', json('POST', input)),
  updateAgent: (id: string, input: AgentInput) => request<Agent>(`/agents/${id}`, json('PUT', input)),
  deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),

  workflows: () => request<Workflow[]>('/workflows'),
  createWorkflow: (input: WorkflowInput) => request<Workflow>('/workflows', json('POST', input)),
  updateWorkflow: (id: string, input: WorkflowInput) => request<Workflow>(`/workflows/${id}`, json('PUT', input)),
  deleteWorkflow: (id: string) => request<void>(`/workflows/${id}`, { method: 'DELETE' }),

  projectCategories: () => request<ProjectCategory[]>('/project-categories'),
  createProjectCategory: (input: ProjectCategoryInput) =>
    request<ProjectCategory>('/project-categories', json('POST', input)),
  updateProjectCategory: (id: string, input: ProjectCategoryInput) =>
    request<ProjectCategory>(`/project-categories/${id}`, json('PUT', input)),
  deleteProjectCategory: (id: string) => request<void>(`/project-categories/${id}`, { method: 'DELETE' }),

  projects: () => request<Project[]>('/projects'),
  /** 新建项目时的 AI 分析：只读扫描本地目录，给出填好一半的表单 */
  analyzeProject: (path: string) => request<ProjectSuggestion>('/projects/analyze', json('POST', { path })),
  createProject: (input: ProjectInput) => request<Project>('/projects', json('POST', input)),
  updateProject: (id: string, input: ProjectInput) => request<Project>(`/projects/${id}`, json('PUT', input)),
  /** 记一条项目教训（同名的会更新），返回更新后的项目 */
  addProjectLesson: (id: string, lesson: Partial<ProjectLesson> & { title: string }) =>
    request<Project>(`/projects/${id}/lessons`, json('POST', lesson)),
  globalLessons: () => request<GlobalLesson[]>('/global-lessons'),
  /** 全局教训只在用户确认后整份保存，confirmed 由确认按钮带上 */
  saveGlobalLessons: (lessons: GlobalLesson[]) =>
    request<GlobalLesson[]>('/global-lessons', json('PUT', { lessons, confirmed: true })),
  // 侧栏拖拽后的顺序：传全部项目的 id，服务端重新编号
  orderProjects: (ids: string[]) => request<Project[]>('/projects/order', json('PUT', ids)),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  /** 项目是不是 agent-panel 自己的源代码（AI 分析结果里多一个「补充进源代码」） */
  panelSource: (id: string) => request<{ panelSource: boolean }>(`/projects/${id}/panel-source`),

  allTasks: () => request<Task[]>('/tasks'),
  tasks: (projectId: string) => request<Task[]>(`/tasks?projectId=${encodeURIComponent(projectId)}`),
  task: (id: string) => request<Task>(`/tasks/${id}`),
  /** 整个运行的用量：父对话 + 所有子对话（含多层）+ 派出的子任务，带实时速度 */
  taskRunUsage: (id: string) => request<RunUsage>(`/tasks/${id}/run-usage`),
  taskChildren: (id: string) =>
    request<
      {
        id: string
        title: string
        status: Task['status']
        summary: string
        working: boolean
        updatedAt: string
        /** 进程还活着（预热、等下一句、正在执行） */
        cliAlive: boolean
        /** 本次开启的时间（最近一轮开始执行），列表按它排序 */
        startedAt: string
        /** 正在等用户确认的请求数 */
        requests?: number
        /** 还没做完的计划进度：有它就不算已完成，界面显示「计划 7/8」 */
        plan?: { done: number; total: number }
        /** 在独立 worktree 里改时的分支 */
        branch?: string
        /** 正在执行时这会儿在做什么 */
        activity?: ChildActivity
        /** 用户标记了「解决」：列表归到「已完成」并带标记 */
        resolved?: boolean
      }[]
    >(`/tasks/${id}/children`),
  stopChildren: (id: string) => request<{ stopped: number }>(`/tasks/${id}/children/stop`, json('POST', {})),
  createTask: (input: NewTaskInput) => request<Task>('/tasks', json('POST', input)),
  /** 导入别人导出的任务（只读）；projectId 为空放进聊天 */
  importTask: (projectId: string, bundle: unknown) =>
    request<Task>('/tasks/import', json('POST', { projectId, bundle })),
  sendMessage: (id: string, text: string, attachments: Attachment[] = [], interrupt = false) =>
    request<Task>(`/tasks/${id}/messages`, json('POST', { text, attachments, interrupt })),
  /** 对话页还开着：CLI 才能停在等下一句的工具上，切走后一分钟才结束 */
  setPresence: (id: string, viewerId: string, active: boolean) =>
    request<void>(`/tasks/${id}/presence`, json('POST', { viewerId, active })),
  /** 用户打开了这个对话：侧栏的橙点消失，服务端可以按宽限期回收 CLI 了 */
  markTaskSeen: (id: string) => request<Task>(`/tasks/${id}/seen`, json('POST', {})),
  /** 打开旧对话时在后台用 --resume 启动，先停在等下一句上 */
  prewarmTask: (id: string) => request<Task>(`/tasks/${id}/prewarm`, { method: 'POST' }),
  /** 撤回到某条消息：返回撤回后的任务和被撤回的那条内容 */
  rewindTask: (id: string, messageId: string) =>
    request<{ task: Task; text: string; attachments: Attachment[] }>(
      `/tasks/${id}/rewind`,
      json('POST', { messageId }),
    ),
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
  locateFiles: (files: { name: string; size: number; mtime?: number }[]) =>
    request<{ files: (Attachment & { index: number })[] }>('/uploads/locate', json('POST', { files })),
  /** 附件、粘贴引用的本机文件：读文字内容，点文件卡片时看 */
  localFile: (path: string) =>
    request<{
      path: string
      dir: string
      exists: boolean
      binary?: boolean
      content: string
      truncated: boolean
    }>(`/uploads/raw/file?path=${encodeURIComponent(path)}`),
  /** 引入会话：把任务或设计的对话整理成一份附件 */
  taskTranscript: (id: string) => request<Attachment>(`/tasks/${id}/transcript`, json('POST', {})),
  designTranscript: (id: string) => request<Attachment>(`/designs/${id}/transcript`, json('POST', {})),
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
  writeProjectFile: (projectId: string, path: string, content: string) =>
    request<{ path: string; size: number }>(`/project-files/${projectId}/content`, json('PUT', { path, content })),
  /** 在目录里新建文件；同名时后端拒绝，不会覆盖 */
  createProjectFile: (projectId: string, dir: string, name: string, content = '') =>
    request<{ path: string; size: number }>(`/project-files/${projectId}/new`, json('POST', { dir, name, content })),
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
  taskDiff: (id: string, path: string) =>
    request<{ path: string; dir: string; diff: string; git: boolean; before: boolean }>(
      `/tasks/${id}/diff?path=${encodeURIComponent(path)}`,
    ),
  taskFile: (id: string, path: string) =>
    request<{
      path: string
      dir: string
      exists: boolean
      binary?: boolean
      content: string
      truncated: boolean
    }>(`/tasks/${id}/file?path=${encodeURIComponent(path)}`),
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
  /** 这个对话和它名下子对话的独立分支，带上是否已经合回原分支 */
  taskWorktrees: (id: string) => request<{ items: WorktreeItem[] }>(`/tasks/${id}/worktrees`),
  /** 把独立分支合回原分支；分支和目录保留。冲突时错误的 body 带 conflict */
  mergeWorktree: (id: string) => request<{ task: Task; into: string }>(`/tasks/${id}/worktree/merge`, json('POST', {})),
  /** 删除独立分支（连目录一起） */
  discardWorktree: (id: string) => request<Task>(`/tasks/${id}/worktree/discard`, json('POST', {})),
  answerRequest: (id: string, rid: string, body: { allow: boolean; answer?: string; answers?: string[] }) =>
    request<Task>(`/tasks/${id}/requests/${rid}`, json('POST', body)),
  /** 子对话请父对话决定的提问：直接回答（交给子对话），或者交给父对话的 AI 决定 */
  answerChildAsk: (id: string, mid: string, body: { answer: string; delegate: boolean }) =>
    request<Task>(`/tasks/${id}/child-asks/${mid}`, json('POST', body)),
  setTaskAskUser: (id: string, askUser: boolean) => request<Task>(`/tasks/${id}`, json('PATCH', { askUser })),
  /** 任务页以外的会话（UI 设计、AI 创建…）在等用户的审批和提问 */
  asks: (scope: string) => request<TaskRequest[]>(`/asks?scope=${encodeURIComponent(scope)}`),
  answerAsk: (id: string, body: { allow: boolean; answer?: string; answers?: string[] }) =>
    request<{ ok: true }>(`/asks/${id}`, json('POST', body)),
  setAskUser: (scope: string, askUser: boolean) => request<{ ok: true }>('/asks/flag', json('PUT', { scope, askUser })),
  /** 父对话的设置：目标、全局规则、子对话的执行配置和并发上限 */
  updateConversation: (id: string, patch: Pick<TaskPatch, 'goal' | 'rules' | 'childRun' | 'childLimit' | 'title'>) =>
    request<Task>(`/tasks/${id}`, json('PATCH', patch)),
  renameTask: (id: string, title: string) => request<Task>(`/tasks/${id}`, json('PATCH', { title })),
  archiveTask: (id: string, archived: boolean) => request<Task>(`/tasks/${id}`, json('PATCH', { archived })),
  /** 子对话的「解决」标记：只改标记，不停 CLI、不影响父对话 */
  resolveTask: (id: string, resolved: boolean) => request<Task>(`/tasks/${id}`, json('PATCH', { resolved })),
  setChatRun: (id: string, run: { cli: string; model: string; effort: string }) =>
    request<Task>(`/tasks/${id}`, json('PATCH', run)),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),

  assist: (input: AssistInput) => request<AssistJob>('/assist', json('POST', input)),
  assistJob: (id: string) => request<AssistJob>(`/assist/${id}`),
  stopAssist: (id: string) => request<AssistJob>(`/assist/${id}/stop`, { method: 'POST' }),
  projectDocs: (projectId: string) => request<ProjectDocs>(`/project-docs/${projectId}`),
  saveProjectDoc: (projectId: string, path: DocFile, content: string) =>
    request<ProjectDoc>(`/project-docs/${projectId}`, json('PUT', { path, content })),
  optimizeDoc: (projectId: string, input: DocOptimizeInput) =>
    request<DocJob>(`/project-docs/${projectId}/optimize`, json('POST', input)),
  deployState: () => request<DeployState>('/deploy'),
  saveDeploy: (c: DeployConfig) => request<DeployState>('/deploy', json('PUT', c)),
  runDeploy: (r: DeployRun) => request<{ result: DeployResult; state: DeployState }>('/deploy/run', json('POST', r)),
  optimizeGlobalDoc: (input: GlobalDocOptimize) => request<DocJob>('/deploy/optimize', json('POST', input)),
  docJob: (id: string) => request<DocJob>(`/doc-jobs/${id}`),
  aiFix: (input: Partial<FixInput> & { title: string }) => request<FixStart>('/ai-fix', json('POST', input)),
  stopDocJob: (id: string) => request<DocJob>(`/doc-jobs/${id}/stop`, { method: 'POST' }),

  inspectDir: (path: string) => request<DirInfo>(`/fs/inspect?path=${encodeURIComponent(path)}`),
  dirBranches: (path: string) => request<DirBranches>(`/fs/branches?path=${encodeURIComponent(path)}`),
  checkoutBranch: (path: string, branch: string) => request<DirInfo>('/fs/checkout', json('POST', { path, branch })),
  listDir: (path: string) => request<DirListing>(`/fs/list?path=${encodeURIComponent(path)}`),
  makeDir: (parent: string, name: string) => request<{ path: string }>('/fs/mkdir', json('POST', { parent, name })),
  dataUsage: () => request<DataUsage>('/data'),
  /** 只取内存采样（最新一个 + 序列 + 面板规模）：内存曲线按采样间隔刷新用它，不遍历数据目录 */
  memoryUsage: () => request<MemoryUsage>('/data/memory'),
  revealData: () => request<{ ok: boolean }>('/data/reveal', json('POST', {})),
  revealLogs: () => request<{ ok: boolean }>('/data/reveal-logs', json('POST', {})),
  clearData: (kind: DataKind) => request<{ ok: boolean }>('/data/clear', json('POST', { kind })),
  exportData: (kinds: DataKind[]) => request<unknown>(`/data/export?kinds=${kinds.join(',')}`),
  importData: (backup: unknown) =>
    request<{ ok: boolean; kinds: DataKind[]; files: number }>('/data/import', json('POST', backup)),
  /** 设置里的用量统计：按天 / 周 / 月聚合各轮执行的 token（聚合在服务端做） */
  tokenUsage: (q: { grain: UsageGrain; count: number }) =>
    request<UsageReport>(`/usage?grain=${q.grain}&count=${q.count}`),
  designs: () => request<DesignMeta[]>('/designs'),
  designProjects: () => request<DesignProject[]>('/designs/projects'),
  createDesignProject: (input: DesignProjectInput) => request<DesignProject>('/designs/projects', json('POST', input)),
  updateDesignProject: (id: string, input: Partial<DesignProjectInput>) =>
    request<DesignProject>(`/designs/projects/${id}`, json('PUT', input)),
  deleteDesignProject: (id: string) => request<void>(`/designs/projects/${id}`, { method: 'DELETE' }),
  design: (id: string) => request<DesignFull>(`/designs/${id}`),
  createDesign: (input: NewDesignInput) => request<Design>('/designs', json('POST', input)),
  saveDesign: (id: string, doc: DesignDoc) => request<DesignFull>(`/designs/${id}`, json('PUT', doc)),
  copyDesign: (id: string, projectId?: string) => request<Design>(`/designs/${id}/copy`, json('POST', { projectId })),
  moveDesign: (id: string, projectId: string) =>
    request<DesignMeta>(`/designs/${id}/move`, json('POST', { projectId })),
  deleteDesign: (id: string) => request<void>(`/designs/${id}`, { method: 'DELETE' }),
  designChat: (id: string, input: DesignChatInput) => request<DesignFull>(`/designs/${id}/chat`, json('POST', input)),
  designConcept: (id: string, action: 'select' | 'approve' | 'remove', conceptId: string) =>
    request<DesignFull>(`/designs/${id}/concept`, json('POST', { action, id: conceptId })),
  uploadConcept: (id: string, data: string) =>
    request<DesignFull>(`/designs/${id}/concept/upload`, json('POST', { data })),
  designCapture: (
    id: string,
    captureId: string,
    body: {
      data?: string
      rects?: { name: string; type: string; x: number; y: number; w: number; h: number }[]
      error?: string
    },
  ) => request<{ ok: boolean }>(`/designs/${id}/capture/${captureId}`, json('POST', body)),
  steerDesign: (id: string, text: string) =>
    request<{ steered: boolean }>(`/designs/${id}/steer`, json('POST', { text })),
  stopDesign: (id: string) => request<DesignJob | null>(`/designs/${id}/stop`, json('POST', {})),
  uploadDesignImage: (id: string, body: { data: string; name?: string; imageId?: string }) =>
    request<DesignFull>(`/designs/${id}/images`, json('POST', body)),
  generateDesignImage: (
    id: string,
    imageId: string,
    body: { source: ImageSource; count: number; prompt?: string; revision?: string },
  ) => request<DesignFull>(`/designs/${id}/images/${imageId}/generate`, json('POST', body)),
  projectComponents: (projectId: string) => request<ProjectComponents[]>(`/designs/projects/${projectId}/components`),
  importComponent: (id: string, body: { from: string; name: string }) =>
    request<DesignFull>(`/designs/${id}/components/import`, json('POST', body)),
  generateDesignImages: (id: string, body: { ids: string[]; source: ImageSource; count: number }) =>
    request<DesignFull>(`/designs/${id}/images/generate`, json('POST', body)),
  designVersions: (id: string) => request<DesignVersionMeta[]>(`/designs/${id}/versions`),
  designVersion: (id: string, vid: string) => request<DesignVersion>(`/designs/${id}/versions/${vid}`),
  saveDesignVersion: (id: string, name: string) =>
    request<DesignVersionMeta>(`/designs/${id}/versions`, json('POST', { name })),
  restoreDesignVersion: (id: string, vid: string) =>
    request<DesignFull>(`/designs/${id}/versions/${vid}/restore`, json('POST', {})),
  deleteDesignVersion: (id: string, vid: string) =>
    request<void>(`/designs/${id}/versions/${vid}`, { method: 'DELETE' }),
  retryDesignImage: (id: string, imageId: string, body: { source: ImageSource; count: number }) =>
    request<DesignFull>(`/designs/${id}/images/${imageId}/retry`, json('POST', body)),
  exportDesignToProject: (id: string) => request<{ dir: string }>(`/designs/${id}/export-to-project`, json('POST', {})),
  browserStatus: () => request<BrowserStatus>('/designs/browser'),
  promptAi: (input: Partial<PromptAiInput>) =>
    request<{ prompts: Omit<ProjectPrompt, 'id' | 'enabled'>[] }>('/designs/prompts/ai', json('POST', input)),
  styles: () => request<SavedStyle[]>('/designs/styles'),
  createStyle: (input: SavedStyleInput) => request<SavedStyle>('/designs/styles', json('POST', input)),
  updateStyle: (id: string, patch: Partial<SavedStyleInput>) =>
    request<SavedStyle>(`/designs/styles/${id}`, json('PUT', patch)),
  deleteStyle: (id: string) => request<void>(`/designs/styles/${id}`, { method: 'DELETE' }),
  /** 让 CLI 总结设计的整体风格（还没存） */
  extractStyle: (designId: string, scope: string) =>
    request<Omit<SavedStyleInput, 'kind'>>(`/designs/${designId}/extract-style`, json('POST', { scope })),
  installExtension: (browser: string) =>
    request<{ dir: string }>('/designs/browser/install', json('POST', { browser })),
  reloadExtension: (browser: string) =>
    request<{ auto: boolean }>('/designs/browser/reload', json('POST', { browser })),
  revealExtension: () => request<{ ok: boolean }>('/designs/browser/reveal', json('POST', {})),
  revealProject: (projectId: string) => request<{ ok: boolean }>('/fs/reveal', json('POST', { projectId })),
}
