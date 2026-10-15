import type {
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
  Workflow,
  WorkflowInput,
} from '@shared/schema'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `请求失败（${res.status}）`)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) })

export const api = {
  clis: (refresh = false) => request<CliStatus[]>(`/clis${refresh ? '?refresh=1' : ''}`),

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

  inspectDir: (path: string) => request<DirInfo>(`/fs/inspect?path=${encodeURIComponent(path)}`),
  listDir: (path: string) => request<DirListing>(`/fs/list?path=${encodeURIComponent(path)}`),
}
