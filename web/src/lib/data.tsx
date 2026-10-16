import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Agent, Category, CliStatus, Project, ProjectCategory, Settings, Workflow } from '@shared/schema'
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

  useEffect(() => {
    Promise.all([api.agents(), api.categories(), api.workflows(), api.clis(), api.projects(), api.projectCategories(), api.settings()])
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
export type PageId = 'agents' | 'workflows' | 'projects' | 'settings'
export interface Route {
  page: PageId
  id?: string
  /** 二级选择，例如项目里的任务 id、'new'（新建任务）或 'settings'（项目设置） */
  sub?: string
}
export const NavCtx = createContext<{ route: Route; go: (r: Route) => void }>({ route: { page: 'agents' }, go: () => {} })
export const useNav = () => useContext(NavCtx)
