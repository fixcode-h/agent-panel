import type {
  Attachment,
  TaskRequest,
  CliInstallJob,
  CliLimits,
  CliSkill,
  CliModels,
  CliUpdate,
  Agent,
  AgentInput,
  Category,
  CliStatus,
  DirInfo,
  DirListing,
  Project,
  ProjectCategory,
  ProjectCategoryInput,
  ProjectInput,
  Settings,
  NewTaskInput,
  Task,
  Workflow,
  WorkflowInput,
} from '@shared/schema'
import type { AssistInput, AssistJob } from '@shared/assist'
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
import type { DataKind, DataUsage } from '@shared/data'
import type { AppReleases, AppUpdateJob } from '@shared/version'
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
    throw new Error(body.error ?? t('请求失败（{status}）', { status: res.status }))
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })

export const api = {
  settings: () => request<Settings>('/settings'),
  saveSettings: (s: Settings) => request<Settings>('/settings', json('PUT', s)),

  clis: (refresh = false) => request<CliStatus[]>(`/clis${refresh ? '?refresh=1' : ''}`),
  cliAction: (id: string, action: 'install' | 'uninstall') =>
    request<CliInstallJob>(`/clis/${id}/${action}`, { method: 'POST' }),
  cliJob: (jobId: string) => request<CliInstallJob>(`/clis/jobs/${jobId}`),
  cliUpdate: (id: string, refresh = false) => request<CliUpdate>(`/clis/${id}/update${refresh ? '?refresh=1' : ''}`),
  cliJobs: () => request<CliInstallJob[]>('/clis/jobs'),
  cliModels: (id: string, refresh = false) => request<CliModels>(`/clis/${id}/models${refresh ? '?refresh=1' : ''}`),
  cliLimits: (id: string) => request<CliLimits | null>(`/clis/${id}/limits`),
  cliSkills: (id: string, projectId = '') =>
    request<CliSkill[]>(`/clis/${id}/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),

  appVersion: () => request<{ current: string; packaged: boolean; previous?: string }>('/app/version'),
  appReleases: (refresh = false) => request<AppReleases>(`/app/releases${refresh ? '?refresh=1' : ''}`),
  appInstall: (tag: string) => request<AppUpdateJob>('/app/install', json('POST', { tag })),
  appInstallJob: (id: string) => request<AppUpdateJob>(`/app/install/${id}`),
  appRollback: () => request<{ version: string }>('/app/rollback', json('POST', {})),

  categories: () => request<Category[]>('/categories'),
  createCategory: (name: string) => request<Category>('/categories', json('POST', { name })),
  renameCategory: (id: string, name: string) => request<Category>(`/categories/${id}`, json('PUT', { name })),
  deleteCategory: (id: string) => request<void>(`/categories/${id}`, { method: 'DELETE' }),

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
  createProject: (input: ProjectInput) => request<Project>('/projects', json('POST', input)),
  updateProject: (id: string, input: ProjectInput) => request<Project>(`/projects/${id}`, json('PUT', input)),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  allTasks: () => request<Task[]>('/tasks'),
  tasks: (projectId: string) => request<Task[]>(`/tasks?projectId=${encodeURIComponent(projectId)}`),
  task: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (input: NewTaskInput) => request<Task>('/tasks', json('POST', input)),
  sendMessage: (id: string, text: string, attachments: Attachment[] = [], interrupt = false, steer = false) =>
    request<Task>(`/tasks/${id}/messages`, json('POST', { text, attachments, interrupt, steer })),
  /** 撤回到某条消息：返回撤回后的任务和被撤回的那条内容 */
  rewindTask: (id: string, messageId: string) =>
    request<{ task: Task; text: string; attachments: Attachment[] }>(
      `/tasks/${id}/rewind`,
      json('POST', { messageId }),
    ),
  forkTask: (id: string, messageId: string) => request<Task>(`/tasks/${id}/fork`, json('POST', { messageId })),
  compactTask: (id: string) => request<Task>(`/tasks/${id}/compact`, json('POST', {})),
  reviewTask: (id: string, base = '') => request<Task>(`/tasks/${id}/review`, json('POST', base ? { base } : {})),
  unqueue: (id: string, qid: string) => request<Task>(`/tasks/${id}/queue/${qid}`, { method: 'DELETE' }),
  upload: (input: { name: string; mime: string; data: string }) => request<Attachment>('/uploads', json('POST', input)),
  projectFiles: (projectId: string, q: string) =>
    request<string[]>(`/projects/${projectId}/files?q=${encodeURIComponent(q)}`),
  stopTask: (id: string) => request<Task>(`/tasks/${id}/stop`, { method: 'POST' }),
  resumeTask: (id: string, latest = false) => request<Task>(`/tasks/${id}/resume`, json('POST', { latest })),
  taskDiff: (id: string, path: string) =>
    request<{ path: string; dir: string; diff: string; git: boolean; before: boolean }>(
      `/tasks/${id}/diff?path=${encodeURIComponent(path)}`,
    ),
  taskFile: (id: string, path: string) =>
    request<{ path: string; dir: string; exists: boolean; binary?: boolean; content: string; truncated: boolean }>(
      `/tasks/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  revertFile: (id: string, path: string) => request<Task>(`/tasks/${id}/revert`, json('POST', { path })),
  /** 独立分支：合并进项目当前的分支，或丢弃 */
  finishWorktree: (id: string, merge: boolean) =>
    request<Task>(`/tasks/${id}/worktree/${merge ? 'merge' : 'discard'}`, json('POST', {})),
  answerRequest: (id: string, rid: string, body: { allow: boolean; answer?: string }) =>
    request<Task>(`/tasks/${id}/requests/${rid}`, json('POST', body)),
  setTaskAskUser: (id: string, askUser: boolean) => request<Task>(`/tasks/${id}`, json('PATCH', { askUser })),
  /** 任务页以外的会话（UI 设计、AI 创建…）在等用户的审批和提问 */
  asks: (scope: string) => request<TaskRequest[]>(`/asks?scope=${encodeURIComponent(scope)}`),
  answerAsk: (id: string, body: { allow: boolean; answer?: string }) =>
    request<{ ok: true }>(`/asks/${id}`, json('POST', body)),
  setAskUser: (scope: string, askUser: boolean) => request<{ ok: true }>('/asks/flag', json('PUT', { scope, askUser })),
  renameTask: (id: string, title: string) => request<Task>(`/tasks/${id}`, json('PATCH', { title })),
  archiveTask: (id: string, archived: boolean) => request<Task>(`/tasks/${id}`, json('PATCH', { archived })),
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
  docJob: (id: string) => request<DocJob>(`/doc-jobs/${id}`),
  stopDocJob: (id: string) => request<DocJob>(`/doc-jobs/${id}/stop`, { method: 'POST' }),

  inspectDir: (path: string) => request<DirInfo>(`/fs/inspect?path=${encodeURIComponent(path)}`),
  listDir: (path: string) => request<DirListing>(`/fs/list?path=${encodeURIComponent(path)}`),
  makeDir: (parent: string, name: string) => request<{ path: string }>('/fs/mkdir', json('POST', { parent, name })),
  dataUsage: () => request<DataUsage>('/data'),
  revealData: () => request<{ ok: boolean }>('/data/reveal', json('POST', {})),
  revealLogs: () => request<{ ok: boolean }>('/data/reveal-logs', json('POST', {})),
  clearData: (kind: DataKind) => request<{ ok: boolean }>('/data/clear', json('POST', { kind })),
  exportData: (kinds: DataKind[]) => request<unknown>(`/data/export?kinds=${kinds.join(',')}`),
  importData: (backup: unknown) =>
    request<{ ok: boolean; kinds: DataKind[]; files: number }>('/data/import', json('POST', backup)),
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
