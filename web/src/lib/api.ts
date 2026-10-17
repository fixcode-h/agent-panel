import type {
  Attachment,
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
import type { DocFile, DocJob, DocOptimizeInput, ProjectDoc, ProjectDocs } from '@shared/docs'
import type { DataKind, DataUsage } from '@shared/data'
import type { AppReleases, AppUpdateJob } from '@shared/version'
import { t } from '@shared/i18n'

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
  dataUsage: () => request<DataUsage>('/data'),
  revealData: () => request<{ ok: boolean }>('/data/reveal', json('POST', {})),
  revealLogs: () => request<{ ok: boolean }>('/data/reveal-logs', json('POST', {})),
  clearData: (kind: DataKind) => request<{ ok: boolean }>('/data/clear', json('POST', { kind })),
  exportData: (kinds: DataKind[]) => request<unknown>(`/data/export?kinds=${kinds.join(',')}`),
  importData: (backup: unknown) =>
    request<{ ok: boolean; kinds: DataKind[]; files: number }>('/data/import', json('POST', backup)),
  revealProject: (projectId: string) => request<{ ok: boolean }>('/fs/reveal', json('POST', { projectId })),
}
