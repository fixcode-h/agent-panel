import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Agent, Category, CliStatus, Project, ProjectCategory, Settings, Task, Workflow } from '@shared/schema'
import { api } from './api'

interface Data {
  loading: boolean
  agents: Agent[]
  categories: Category[]
  workflows: Workflow[]
  clis: CliStatus[]
  projects: Project[]
  projectCategories: ProjectCategory[]
  settings: Settings | null
  /** 所有项目的任务（侧栏的最近任务、项目工作区共用） */
  tasks: Task[]
  tasksLoaded: boolean
  upsertTask: (t: Task) => void
  removeTask: (id: string) => void
  reloadTasks: () => Promise<void>
  setSettings: (s: Settings) => void
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>
  setProjectCategories: React.Dispatch<React.SetStateAction<ProjectCategory[]>>
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>
  setCategories: React.Dispatch<React.SetStateAction<Category[]>>
  setWorkflows: React.Dispatch<React.SetStateAction<Workflow[]>>
  refreshClis: () => Promise<void>
}

const Ctx = createContext<Data | null>(null)

/** 全局数据：页面之间共享 Agent、分类、工作流和 CLI 检测结果 */
export function DataProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<Agent[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [clis, setClis] = useState<CliStatus[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectCategories, setProjectCategories] = useState<ProjectCategory[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [tasksLoaded, setTasksLoaded] = useState(false)

  const reloadTasks = useCallback(async () => {
    try {
      setTasks(await api.allTasks())
    } finally {
      setTasksLoaded(true)
    }
  }, [])
  useEffect(() => {
    void reloadTasks()
  }, [])
  // 有执行中的任务时定期刷新状态
  const anyRunning = tasks.some((t) => t.status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => void reloadTasks().catch(() => {}), 2500)
    return () => clearInterval(t)
  }, [anyRunning])
  const upsertTask = useCallback(
    (t: Task) =>
      setTasks((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t])),
    [],
  )
  const removeTask = useCallback((id: string) => setTasks((ts) => ts.filter((t) => t.id !== id)), [])

  useEffect(() => {
    Promise.all([
      api.agents(),
      api.categories(),
      api.workflows(),
      api.clis(),
      api.projects(),
      api.projectCategories(),
      api.settings(),
    ])
      .then(([a, c, w, l, p, pc, s]) => {
        setSettings(s)
        setProjects(p)
        setProjectCategories(pc)
        setAgents(a)
        setCategories(c)
        setWorkflows(w)
        setClis(l)
      })
      .catch((e) => toast.error(`加载失败：${(e as Error).message}`))
      .finally(() => setLoading(false))
  }, [])

  const refreshClis = useCallback(async () => {
    setClis(await api.clis(true))
  }, [])

  return (
    <Ctx.Provider
      value={{
        loading,
        agents,
        categories,
        workflows,
        clis,
        projects,
        projectCategories,
        settings,
        tasks,
        tasksLoaded,
        upsertTask,
        removeTask,
        reloadTasks,
        setSettings,
        setAgents,
        setCategories,
        setWorkflows,
        setProjects,
        setProjectCategories,
        refreshClis,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useData() {
  const d = useContext(Ctx)
  if (!d) throw new Error('useData 必须在 DataProvider 内使用')
  return d
}

/** 当前页面和选中项；用于跨页面跳转，例如从 Agent 跳到使用它的工作流 */
export type PageId = 'home' | 'agents' | 'workflows' | 'projects'
export interface Route {
  page: PageId
  id?: string
  /** 二级选择，例如项目里的任务 id、'new'（新建任务）或 'settings'（项目设置） */
  sub?: string
}
export const NavCtx = createContext<{
  route: Route
  go: (r: Route) => void
  /** 打开设置；section 指定打开哪一栏 */
  openSettings: (section?: string) => void
}>({ route: { page: 'home' }, go: () => {}, openSettings: () => {} })
export const useNav = () => useContext(NavCtx)
