import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Agent, Category, CliStatus, Project, ProjectCategory, Settings, Task, Workflow } from '@shared/schema'
import type { DesignMeta, DesignProject } from '@shared/design'
import { api } from './api'
import { rememberAskUserDefault } from './askUserDefault'
import { registerCliSpecs } from '@shared/clis'
import { t } from '@shared/i18n'

/** 换语言：记在浏览器里（页面加载时就要用），重新加载让所有文案换掉 */
export function switchLang(setting: string) {
  try {
    if ((localStorage.getItem('lang') ?? 'auto') === setting) return
    localStorage.setItem('lang', setting)
  } catch {
    return
  }
  location.reload()
}

/** 内容区宽度用 CSS 变量，项目首页、任务页、流程视图里的 max-w-(--content-w) 都跟着它 */
export function applyContentWidth(w: number | undefined) {
  if (w) document.documentElement.style.setProperty('--content-w', `${w}px`)
}

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
  /** UI 设计（和任务分开） */
  designs: DesignMeta[]
  setDesigns: React.Dispatch<React.SetStateAction<DesignMeta[]>>
  /** UI 设计自己的项目，和 Agent 的项目分开 */
  designProjects: DesignProject[]
  setDesignProjects: React.Dispatch<React.SetStateAction<DesignProject[]>>
  reloadDesigns: () => Promise<void>
  upsertTask: (t: Task) => void
  removeTask: (id: string) => void
  reloadTasks: () => Promise<void>
  setSettings: (s: Settings) => void
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>
  setProjectCategories: React.Dispatch<React.SetStateAction<ProjectCategory[]>>
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>
  setCategories: React.Dispatch<React.SetStateAction<Category[]>>
  setWorkflows: React.Dispatch<React.SetStateAction<Workflow[]>>
  /** force：重新跑一遍检测；不带时用服务端的缓存（改了命令、环境变量时服务端会自己重新检测） */
  refreshClis: (force?: boolean) => Promise<void>
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
  useEffect(() => applyContentWidth(settings?.contentWidth), [settings?.contentWidth])
  // 新会话的「提问」开关要同步读默认值，设置还没取回来时也能用上次存的
  const askDefault = settings?.askUserDefault
  useEffect(() => {
    if (askDefault !== undefined) rememberAskUserDefault(askDefault)
  }, [askDefault])
  // 设置里的语言和浏览器记的不一样（例如在别的浏览器里改过）：以设置为准
  useEffect(() => {
    if (settings) switchLang(settings.language)
    // 只在语言设置变化时切换
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.language])
  const [tasks, setTasks] = useState<Task[]>([])
  const [tasksLoaded, setTasksLoaded] = useState(false)
  const [designs, setDesigns] = useState<DesignMeta[]>([])
  const [designProjects, setDesignProjects] = useState<DesignProject[]>([])
  const reloadDesigns = useCallback(async () => {
    try {
      const [ps, ds] = await Promise.all([api.designProjects(), api.designs()])
      setDesignProjects(ps)
      setDesigns(ds)
    } catch {
      // 连不上时保留现有列表
    }
  }, [])
  useEffect(() => {
    void reloadDesigns()
  }, [reloadDesigns])
  // 有设计在跑 AI 对话或生成图片时定期刷新列表：切到别的设计后，侧栏里那个的转圈也能在完成时停下
  const designRunning = designs.some((d) => d.running)
  useEffect(() => {
    if (!designRunning) return
    const t = setInterval(
      () =>
        void api
          .designs()
          .then((ds) =>
            // 只更新状态，名字等以页面上的为准（正在改名时不被盖掉）
            setDesigns((cur) =>
              cur.map((x) => {
                const d = ds.find((d) => d.id === x.id)
                return { ...x, running: !!d?.running, asking: !!d?.asking }
              }),
            ),
          )
          .catch(() => {}),
      2500,
    )
    return () => clearInterval(t)
  }, [designRunning])

  const reloadTasks = useCallback(async () => {
    try {
      setTasks(await api.allTasks())
    } catch {
      // 后端暂时连不上时保留现有列表，下次刷新再试
    } finally {
      setTasksLoaded(true)
    }
  }, [])
  useEffect(() => {
    void reloadTasks()
    // 启动时取一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 有执行中的任务时定期刷新状态
  const anyRunning = tasks.some((t) => t.status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => void reloadTasks().catch(() => {}), 2500)
    return () => clearInterval(t)
    // 有任务在执行时才定时刷新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [anyRunning])
  const upsertTask = useCallback(
    (t: Task) =>
      setTasks((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t])),
    [],
  )
  const removeTask = useCallback((id: string) => setTasks((ts) => ts.filter((t) => t.id !== id)), [])

  useEffect(() => {
    // CLI 检测可能要跑一遍各个 CLI，不挡住页面：其他数据到了就先显示
    // 先注册用户自己加的 CLI 配置，CLI 列表、设置页才认得它们
    api
      .cliSpecs()
      .then((r) => registerCliSpecs(r.specs))
      .catch(() => {})
      .then(() => api.clis())
      .then(setClis)
      .catch(() => {})
    Promise.all([
      api.agents(),
      api.categories(),
      api.workflows(),
      api.projects(),
      api.projectCategories(),
      api.settings(),
    ])
      .then(([a, c, w, p, pc, s]) => {
        setSettings(s)
        setProjects(p)
        setProjectCategories(pc)
        setAgents(a)
        setCategories(c)
        setWorkflows(w)
      })
      .catch((e) => toast.error(t('加载失败：{msg}', { msg: (e as Error).message })))
      .finally(() => setLoading(false))
  }, [])

  const refreshClis = useCallback(async (force = true) => {
    setClis(await api.clis(force))
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
        designs,
        setDesigns,
        designProjects,
        setDesignProjects,
        reloadDesigns,
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
export type PageId = 'home' | 'agents' | 'workflows' | 'projects' | 'chat' | 'design' | 'library' | 'mcp'
export interface Route {
  page: PageId
  id?: string
  /** 二级选择，例如项目里的任务 id、'new'（新建任务） */
  sub?: string
}
export const NavCtx = createContext<{
  route: Route
  go: (r: Route) => void
  /** 打开设置；section 指定打开哪一栏 */
  openSettings: (section?: string) => void
  /** 打开项目设置弹窗；不传 id 是新建项目 */
  openProject: (id?: string) => void
}>({ route: { page: 'home' }, go: () => {}, openSettings: () => {}, openProject: () => {} })
export const useNav = () => useContext(NavCtx)
