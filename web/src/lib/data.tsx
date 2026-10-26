import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { toast } from '@/lib/toast'
import type {
  Agent,
  Category,
  CliStatus,
  Tag,
  Project,
  ProjectCategory,
  Settings,
  Task,
  Workflow,
} from '@shared/schema'
import type { DesignMeta, DesignProject } from '@shared/design'
import { api } from './api'
import { rememberAskUserDefault, rememberChildAskUserDefault } from './askUserDefault'
import { applyAppearance } from './appearance'
import { setCliModes } from './cli-models'
import { registerCliSpecs } from '@shared/clis'
import { t } from '@shared/i18n'
import { helpersWorking, taskSummary } from '@shared/task'
import { keepLiveFields } from './live-fields'

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
  /** 全局标签：Agent 和工作流共用 */
  tags: Tag[]
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
  /** 设计项目列表取回来没有：初值是空数组，没取回来时不能当成「项目不存在」 */
  designProjectsLoaded: boolean
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
  setTags: React.Dispatch<React.SetStateAction<Tag[]>>
  setWorkflows: React.Dispatch<React.SetStateAction<Workflow[]>>
  /** force：重新跑一遍检测；不带时用服务端的缓存（改了命令、环境变量时服务端会自己重新检测） */
  refreshClis: (force?: boolean) => Promise<void>
}

const Ctx = createContext<Data | null>(null)

/**
 * 任务摘要里列表和侧栏会用到的字段：流式推送每个增量都会重发整个摘要，
 * 这些没变时沿用原来的对象和数组，所有 useData() 的消费者就不用跟着重渲染。
 */
function sameTask(a: Task, b: Task) {
  return (
    a.title === b.title &&
    a.status === b.status &&
    a.updatedAt === b.updatedAt &&
    a.turnDoneAt === b.turnDoneAt &&
    a.turnSeenAt === b.turnSeenAt &&
    a.working === b.working &&
    a.childrenWorking === b.childrenWorking &&
    a.cliAlive === b.cliAlive &&
    a.childrenCli === b.childrenCli &&
    (a.jobs?.length ?? 0) === (b.jobs?.length ?? 0) &&
    helpersWorking(a) === helpersWorking(b) &&
    (a.parentAsks?.length ?? 0) === (b.parentAsks?.length ?? 0) &&
    a.archived === b.archived &&
    a.projectId === b.projectId &&
    a.parentTaskId === b.parentTaskId &&
    a.askedAt === b.askedAt &&
    (a.requests?.length ?? 0) === (b.requests?.length ?? 0) &&
    a.worktree?.state === b.worktree?.state
  )
}

/** 定时全量刷新：只把真正变了的任务换掉；整份列表没变时连数组都不换 */
function mergeTasks(cur: Task[], next: Task[]) {
  const sameOrder = cur.length === next.length && cur.every((x, i) => x.id === next[i].id && sameTask(x, next[i]))
  if (sameOrder) return cur
  const before = new Map(cur.map((x) => [x.id, x]))
  return next.map((x) => {
    const old = before.get(x.id)
    return old && sameTask(old, x) ? old : x
  })
}

/** 全局数据：页面之间共享 Agent、分类、工作流和 CLI 检测结果 */
export function DataProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<Agent[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [clis, setClis] = useState<CliStatus[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectCategories, setProjectCategories] = useState<ProjectCategory[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => applyContentWidth(settings?.contentWidth), [settings?.contentWidth])
  // 模型下拉按每个 CLI 现在的登录方式取列表（账号和 API 各列各的）
  useEffect(() => {
    if (settings) setCliModes(settings)
  }, [settings])
  const appearance = settings?.appearance
  useEffect(() => {
    if (appearance) applyAppearance(appearance)
  }, [appearance])
  // 新会话的「提问」开关要同步读默认值，设置还没取回来时也能用上次存的
  const askDefault = settings?.askUserDefault
  useEffect(() => {
    if (askDefault !== undefined) rememberAskUserDefault(askDefault)
  }, [askDefault])
  // 子对话的「提问」默认值同理：新开父对话时要用它定「子对话也提问」的初始值
  const childAskDefault = settings?.childAskUserDefault
  useEffect(() => {
    if (childAskDefault !== undefined) rememberChildAskUserDefault(childAskDefault)
  }, [childAskDefault])
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
  const [designProjectsLoaded, setDesignProjectsLoaded] = useState(false)
  const reloadDesigns = useCallback(async () => {
    try {
      const [ps, ds] = await Promise.all([api.designProjects(), api.designs()])
      setDesignProjects(ps)
      setDesigns(ds)
    } catch {
      // 连不上时保留现有列表
    } finally {
      // 取失败也算「问过了」：否则项目主页会一直停在加载中
      setDesignProjectsLoaded(true)
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
            // 只更新状态，名字等以页面上的为准（正在改名时不被盖掉）。
            // 转圈状态没变时不换数组，侧栏不用每 2.5 秒重渲染一次
            setDesigns((cur) => {
              let changed = false
              const next = cur.map((x) => {
                const d = ds.find((d) => d.id === x.id)
                const running = !!d?.running
                const asking = !!d?.asking
                if (x.running === running && x.asking === asking) return x
                changed = true
                return { ...x, running, asking }
              })
              return changed ? next : cur
            }),
          )
          .catch(() => {}),
      2500,
    )
    return () => clearInterval(t)
  }, [designRunning])

  const reloadTasks = useCallback(async () => {
    try {
      const next = await api.allTasks()
      setTasks((cur) => mergeTasks(cur, next))
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
  // CLI 还活着的也要刷：进程关掉不一定改状态，侧栏的流光和「CLI 存活」提示要跟着撤
  const anyRunning = tasks.some((t) => t.status === 'running' || t.cliAlive || !!t.childrenCli)
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => void reloadTasks().catch(() => {}), 2500)
    return () => clearInterval(t)
    // 有任务在执行时才定时刷新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [anyRunning])
  const upsertTask = useCallback(
    // 全局列表只存摘要：暂停、继续、改名这些接口回的是带全部对话的完整任务，原样放进来的话
    // 摘要没变时 mergeTasks 会一直沿用这份，整段对话（几 MB）就跟着列表常驻内存，切走对话也不释放
    (full: Task) => {
      setTasks((ts) => {
        const i = ts.findIndex((x) => x.id === full.id)
        // 停止、改名这类接口返回的任务不带运行时字段（后台命令、还在运行的子对话数）：沿用列表里的，转圈不闪
        const t = taskSummary(keepLiveFields(ts[i], full))
        if (i < 0) return [...ts, t]
        // 摘要没变时沿用原数组：流式输出期间每 200ms 来一次，不能每次都让侧栏重算
        if (sameTask(ts[i], t)) return ts
        const next = ts.slice()
        next[i] = t
        return next
      })
    },
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
      // 旧版本的服务没有标签接口：取不到当作没有标签
      api.tags().catch(() => [] as Tag[]),
    ])
      .then(([a, c, w, p, pc, s, tg]) => {
        setTags(tg)
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

  // 每次渲染都换新对象会让所有 useData() 的消费者一起重渲染：上面的数据都没变时沿用同一个值
  const value = useMemo(
    () => ({
      loading,
      agents,
      categories,
      tags,
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
      designProjectsLoaded,
      setDesignProjects,
      reloadDesigns,
      upsertTask,
      removeTask,
      reloadTasks,
      setSettings,
      setAgents,
      setCategories,
      setTags,
      setWorkflows,
      setProjects,
      setProjectCategories,
      refreshClis,
    }),
    [
      loading,
      agents,
      categories,
      tags,
      workflows,
      clis,
      projects,
      projectCategories,
      settings,
      tasks,
      tasksLoaded,
      designs,
      designProjects,
      designProjectsLoaded,
      reloadDesigns,
      upsertTask,
      removeTask,
      reloadTasks,
      refreshClis,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** 导入的任务里用到了本机没有的 Agent：任务页里换成带上它们的列表，名字、图标照常显示 */
export function WithAgents({ agents, children }: { agents: Agent[]; children: React.ReactNode }) {
  const d = useContext(Ctx)
  const value = useMemo(() => (d && d.agents !== agents ? { ...d, agents } : d), [d, agents])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useData() {
  const d = useContext(Ctx)
  if (!d) throw new Error('useData 必须在 DataProvider 内使用')
  return d
}

/** 当前页面和选中项；用于跨页面跳转，例如从 Agent 跳到使用它的工作流 */
export type PageId =
  | 'home'
  | 'schedules'
  | 'agents'
  | 'workflows'
  | 'projects'
  | 'chat'
  | 'design'
  | 'comfy'
  | 'library'
  | 'mcp'
  | 'summary'
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
  /** 打开项目设置弹窗；不传 id 是新建项目。section 指定打开哪一栏，item 是那一栏里要展开的条目（例如教训 id） */
  openProject: (id?: string, section?: string, item?: string) => void
}>({ route: { page: 'home' }, go: () => {}, openSettings: () => {}, openProject: () => {} })
export const useNav = () => useContext(NavCtx)
