import { CliSkills } from '@/components/settings/CliSkills'
import { ProjectMcpSection } from './ProjectMcpSection'
import { useEffect, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from '@/lib/toast'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  FlaskConical,
  GraduationCap,
  Library,
  Loader2,
  Plug,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import type {
  Agent,
  ParamValue,
  ParamValues,
  Project,
  ProjectInput,
  TestStep,
  Workflow,
  WorkflowExpose,
} from '@shared/schema'
import { DEFAULT_FILE_FORMAT } from '@shared/schema'
import {
  derivedParams,
  agentParamGroups,
  isDefaultValue,
  type AgentParamGroup,
  type DerivedParam,
} from '@shared/agent-params'
import { ENV_LABEL, newTestStepId, parseGlobs } from '@shared/test-steps'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { projectChecks } from '@/lib/readiness'
import { Button } from '@/components/ui/button'
import { CategoryPicker } from '@/components/ui/category-picker'
import { ConfirmDialog, dialogScrollClass } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FormSection, Input, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { HelpTip } from '@/components/ui/help-tip'
import type { ProjectProposal, Proposal } from '@shared/assist'
import { readProjectProposal } from '@shared/project-init'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { DirPicker, useDirInfo } from './DirPicker'
import { t } from '@shared/i18n'
import { resolveParams } from '@shared/agent-role'
import { CLIS } from '@shared/clis'
import { GENERAL_NAME, UE_PROJECT_NAME } from '@shared/builtin/workflows'
import { cliDocs, SHARED_DOC, type DocFile, type ProjectDocs } from '@shared/docs'
import { cliSettings, orderClis } from '@shared/settings'
import { DEFAULT_SEARCH_EXCLUDE, UE_SEARCH_EXCLUDE } from '@shared/search-exclude'
import { cliColor } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { DocPage } from './ProjectDocs'
import { ProjectSkillsSection } from './ProjectSkillsSection'
import { runAssistInProject } from '@/lib/assist-conv'
import { ProjectInitPanel } from './ProjectInitPanel'
import { LessonsEditor } from './Lessons'
import { Segmented } from '@/components/ui/segmented'
import { CORE_AGENTS, coreKey, coreUse, findCore, isHelperAgent } from '@shared/builtin/core'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { ParamControl, ParamRow, ParamsForm } from '@/components/agents/ParamFields'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'

/** 默认工作流从这个工作流分类里选（内置的「通用项目」「UE 项目」都在这里） */
const PROJECT_WF_CATEGORY = '项目'

/**
 * 一次 AI 优化会话。参数在打开时快照下来：关掉项目设置后 Body 卸载了，
 * 对话还要接着跑，不能依赖表单里的草稿。
 */
type AiSession = {
  kind: 'params' | 'teststeps' | 'project'
  workflowId?: string
  agentId?: string
  title: string
  /** 打开就直接发给 CLI 的要求：点「AI 配置」不用再自己写一遍 */
  start?: string
  /** AI 初始化要的目录和扫描线索（Body 关掉后草稿就没了，先存下来） */
  subject?: Record<string, string>
  /** 在新建项目里开的会话，会话没结束项目就先保存了：结果要应用到这个项目，不能再按新建项目打开 */
  projectId?: string
}

/** 把 AI 结果填进表单：Body 挂载时注册，设置关着时先排队，重新打开后再应用 */
type ApplyAi = (p: Proposal) => void

const toInput = ({ id, createdAt, updatedAt, ...rest }: Project): ProjectInput => ({
  ...rest,
  // 数据文件是用户可改的：保存的推荐读不出来时当作没有推荐
  initResult: readProjectProposal(rest.initResult),
})
const folderName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? ''
const blank: ProjectInput = {
  name: '',
  description: '',
  path: '',
  categoryId: '',
  workflowId: '',
  workflowIds: [],
  defaultAgentId: '',
  agentSet: true,
  workflowParams: {},
  agentParams: {},
  childIsolation: 'worktree',
  isolateDefault: false,
  testSteps: [],
  scaledVerify: true,
  lessons: [],
  wslDistro: '',
  fileFormat: undefined,
  searchExclude: [],
  gitPolicy: 'ask',
  initializedAt: '',
  initResult: undefined,
}

/** 关闭按钮：设置类弹窗共用，带边框，比纯图标更容易看到 */
export function DialogCloseButton({ label = t('关闭') }: { label?: string }) {
  return (
    <D.Close
      aria-label={label}
      title={`${label}（Esc）`}
      className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg border border-line-strong bg-field text-muted transition-colors hover:border-fg/30 hover:bg-sel hover:text-fg"
    >
      <X className="h-[18px] w-[18px]" strokeWidth={2} />
    </D.Close>
  )
}

/**
 * 项目设置弹窗：改完点「确认」才保存，「取消」放弃改动。
 * 没有 project 时是新建项目，确认后创建并打开它。
 */
export function ProjectSettingsDialog({
  open,
  project,
  section,
  item,
  onOpenChange,
}: {
  open: boolean
  project?: Project
  /** 打开时先显示哪一栏（例如项目首页点教训时直接到「教训」） */
  section?: string
  /** 那一栏里要展开的条目 */
  item?: string
  onOpenChange: (open: boolean) => void
}) {
  const { workflows, agents, projects, setProjects } = useData()
  const { openProject } = useNav()
  // AI 会话放在外壳：关掉项目设置时 AssistDialog 不卸载，生成继续跑，最小化的浮条留在屏幕上
  const [ai, setAi] = useState<AiSession | null>(null)
  // Body 挂载时注册「把结果填进表单」；它没挂载（设置关着）时先排队，重新打开后补上
  const applyRef = useRef<ApplyAi | null>(null)
  const queued = useRef<Proposal[]>([])
  // 新建项目还没保存就关掉了设置：草稿留到下次打开，应用结果时接着用（不然目录、名称都没了）
  const stash = useRef<ProjectInput | null>(null)
  const apply = (p: Proposal) => {
    // 会话期间项目已经建好：打开那个项目再应用。按新建项目打开会再建一个同名的
    if (ai?.projectId && project?.id !== ai.projectId) {
      queued.current.push(p)
      openProject(ai.projectId, 'init')
      return
    }
    if (applyRef.current) {
      applyRef.current(p)
      return
    }
    queued.current.push(p)
    if (!open) onOpenChange(true)
  }
  // 项目对话里做完的结果：这个项目的设置开着就直接填进草稿；关着（或开的是别的项目）就把推荐记进项目，
  // 下次打开「AI 初始化」页能直接应用。不自动弹出设置，也不会填进别的项目
  const deliver = (projectId: string, p: Proposal) => {
    if (open && applyRef.current && project?.id === projectId) return applyRef.current(p)
    if (p.kind !== 'project' || !projects.some((x) => x.id === projectId)) return
    // 只写初始化的结果：初始化对话可能跑好几分钟，这里手里的项目还是开始那时的，
    // 整份写回会把用户这期间应用的推荐（名称、简介、测试步骤……）覆盖回旧值
    void api
      .saveProjectInitResult(projectId, { initResult: p })
      .then((saved) => setProjects((ps) => ps.map((x) => (x.id === saved.id ? saved : x))))
      .catch((e) => toast.error((e as Error).message))
  }
  // 换了项目就不再沿用上一份会话（AssistDialog 卸载时会停掉还在跑的生成）
  const pid = useRef(project?.id)
  useEffect(() => {
    if (pid.current === project?.id) return
    pid.current = project?.id
    // 会话里刚建好的项目接着用这份会话
    if (project?.id && project.id === ai?.projectId) return
    setAi(null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])
  useEffect(() => {
    if (!ai) stash.current = null
  }, [ai])
  const aiWorkflow = ai?.workflowId ? workflows.find((w) => w.id === ai.workflowId) : undefined
  return (
    <>
      <D.Root open={open} onOpenChange={onOpenChange}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
          <D.Content
            aria-describedby={undefined}
            // 改到一半点到外面不关闭，免得白填
            onInteractOutside={(e) => e.preventDefault()}
            className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] h-[min(800px,calc(100dvh-2rem))] w-[min(1120px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
          >
            {open && (
              <Body
                key={project?.id ?? 'new'}
                project={project}
                initialSection={section}
                item={item}
                ai={ai}
                onAssist={setAi}
                deliver={deliver}
                onCreated={(id) => setAi((s) => (s ? { ...s, projectId: id } : s))}
                applyRef={applyRef}
                queued={queued}
                stash={stash}
                onClose={() => onOpenChange(false)}
              />
            )}
          </D.Content>
        </D.Portal>
      </D.Root>
      {/* 放在设置弹窗外面：关掉设置不会连带卸载它，生成和浮条都留着 */}
      {ai && (
        <AssistDialog
          open={!!ai}
          onOpenChange={(o) => !o && setAi(null)}
          kind={ai.kind}
          projectId={project?.id ?? ''}
          subject={ai.subject}
          title={ai.title}
          autoStart={ai.start}
          paramAgentId={ai.agentId}
          paramSpec={aiWorkflow ? derivedParams(aiWorkflow, agents) : undefined}
          target={aiWorkflow}
          onApply={apply}
        />
      )}
    </>
  )
}

function Body({
  project,
  initialSection,
  item,
  ai,
  onAssist,
  deliver,
  onCreated,
  applyRef,
  queued,
  stash,
  onClose,
}: {
  project?: Project
  initialSection?: string
  item?: string
  /** 这次打开设置时的 AI 会话（外壳持有，关掉设置也不丢） */
  ai: AiSession | null
  onAssist: (s: AiSession) => void
  /** 在项目对话里做完的结果交回来（见外壳的 deliver） */
  deliver: (projectId: string, p: Proposal) => void
  /** 新建的项目保存好了（会话要跟着这个项目走） */
  onCreated: (id: string) => void
  /** 应用函数和排队的结果由外壳持有，设置重新打开后要接得上 */
  applyRef: { current: ApplyAi | null }
  queued: { current: Proposal[] }
  /** 新建项目时会话还在跑就关掉设置，草稿暂存在这里 */
  stash: { current: ProjectInput | null }
  onClose: () => void
}) {
  const { projectCategories, setProjectCategories, setProjects, workflows, agents, clis, reloadTasks } = useData()
  const { go, route } = useNav()
  const [draft, setDraft] = useState<ProjectInput>(() =>
    project
      ? toInput(project)
      : (stash.current ??
          // 新项目默认用协调 Agent；用户可以在下面改成「无」或别的 Agent
          { ...blank, defaultAgentId: agents.find((a) => a.origin === 'builtin:orchestrator')?.id ?? '' }),
  )
  // 「在父对话中执行」只对 Git 项目生效（ADR 0018）：路径变了重新判断，判断不出来按不是 Git 处理（置灰）。
  // 输入路径时每敲一个字都会变，等 300ms 再问，避免连续请求
  const [gitRepo, setGitRepo] = useState(false)
  useEffect(() => {
    const p = draft.path.trim()
    if (!p) {
      setGitRepo(false)
      return
    }
    const timer = setTimeout(() => {
      api
        .dirVcs(p)
        .then((r) => setGitRepo(r.vcs === 'git'))
        .catch(() => setGitRepo(false))
    }, 300)
    return () => clearTimeout(timer)
  }, [draft.path])
  // 新建项目时 AI 会话还在跑就关掉了：草稿留给下次打开
  const draftNow = useRef(draft)
  draftNow.current = draft
  const created = useRef(false)
  const keep = useRef(false)
  keep.current = !project && !!ai && !created.current
  useEffect(
    () => () => {
      if (keep.current) stash.current = draftNow.current
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  // 页面上的项目列表是启动时读的：对话里的角色后来用 record_lesson 记的教训不在里面。
  // 打开时重新读一次，把新记的教训补进草稿，教训页才看得到，保存时也不会把它们盖掉
  useEffect(() => {
    if (!project) return
    let alive = true
    api
      .projects()
      .then((list) => {
        const fresh = list.find((p) => p.id === project.id)
        if (!alive || !fresh) return
        setProjects(list)
        setDraft((d) => {
          // 用 Set 查：条目多时两层 some 是平方级，上万条要卡近一秒
          const have = new Set(d.lessons.map((x) => x.id))
          return { ...d, lessons: [...d.lessons, ...fresh.lessons.filter((l) => !have.has(l.id))] }
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // 只在打开（换项目）时读一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [signals, setSignals] = useState<string[]>([])
  // 这次打开弹窗里 AI 初始化的结果：推荐项在「AI 初始化」页逐项或整体应用
  const [init, setInit] = useState<ProjectProposal | null>(null)
  const set = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => setDraft((d) => ({ ...d, [k]: v }))
  // 名称没填，或者名称就是原来的文件夹名时，换目录后名称跟着变成新的文件夹名；手动改过的名称不动
  const pickDir = (path: string) =>
    setDraft((d) => {
      const name = d.name.trim()
      const follow = !name || name === folderName(d.path) || (!project && name === t('新项目'))
      return { ...d, path, name: follow && folderName(path) ? folderName(path) : d.name }
    })
  const dir = useDirInfo(draft.path)
  // 目录里已有初始化写好的 AGENTS.md 和文档（比如上次初始化完没保存、删了项目再建）：直接算初始化过，不用再跑一遍。
  // 只记是不是这样认出来的：目录再换成没初始化过的，要撤回
  const [dirInit, setDirInit] = useState(false)
  useEffect(() => {
    if (dir === undefined) return
    if (dir?.initialized && !draft.initializedAt) {
      setDraft((d) => ({ ...d, initializedAt: new Date().toISOString() }))
      setDirInit(true)
    } else if (!dir?.initialized && dirInit) {
      setDraft((d) => ({ ...d, initializedAt: '' }))
      setDirInit(false)
    }
    // 只跟着目录检测结果走
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])
  const category = projectCategories.find((c) => c.id === draft.categoryId)
  const inherited = workflows.find((w) => w.id === category?.workflowId)
  const own = workflows.find((w) => w.id === draft.workflowId)
  // 没有单独指定时落到「通用项目」（服务端也是这么解析的），表单上显示实际会用的那个
  const general =
    workflows.find((w) => w.origin === 'builtin:project-general') ?? workflows.find((w) => w.name === GENERAL_NAME)
  const active = own ?? inherited ?? general
  // 没单独选工作流时跟随分类的默认工作流；分类也没有就用「通用项目」，保存时写进去（服务端要求有默认工作流）。
  // 初始化推荐的默认工作流和这个回退一致时「全部应用」没东西可点，不能因此一直存不了
  const valid = !!draft.name.trim() && !!active
  // 每个工作流一份配置：默认工作流和每个可选工作流各自保存
  const paramsOf = (id: string) => draft.workflowParams[id] ?? {}
  const setParam = (id: string, key: string, value: ParamValue) =>
    setDraft((d) => ({
      ...d,
      workflowParams: { ...d.workflowParams, [id]: { ...(d.workflowParams[id] ?? {}), [key]: value } },
    }))
  const optionalWorkflows = draft.workflowIds
    .map((id) => workflows.find((w) => w.id === id))
    .filter((w): w is (typeof workflows)[number] => !!w)
  // 工作流 expose 里 target=agent 的 key 由 expose 表单管，这里不重复渲染（同一个参数只有一处配置源）
  const paramsFor = (w: (typeof workflows)[number]) => {
    const derived = derivedParams(w, agents)
    const exposed = new Set(w.expose.filter((e) => e.target === 'agent').map((e) => e.targetId))
    return { derived, exposed, groups: agentParamGroups(w, agents) }
  }
  const checks = projectChecks(draft, dir, own ?? inherited ?? general, agents, clis)
  const { settings, categories } = useData()
  // 「子任务」不作为可选角色展示，也没有参数：跳去角色页的那个按钮只会跳开，不在这个列表里列
  const coreAgents = CORE_AGENTS.map((c) => findCore(agents, c.key)).filter((a): a is Agent => !!a && !isHelperAgent(a))
  // 默认工作流只从「项目」分类里选：项目常驻流程按子对话的需要设计，别的流程放进可选工作流
  const projectCat = categories.find((c) => c.scope === 'workflow' && c.name === PROJECT_WF_CATEGORY)
  const inProjectCat = workflows.filter((w) => projectCat && w.categoryId === projectCat.id)
  const defaultChoices = (inProjectCat.length ? inProjectCat : workflows).filter((w, i, list) => list.indexOf(w) === i)
  if (own && !defaultChoices.includes(own)) defaultChoices.unshift(own)
  const addable = workflows.filter((w) => w.id !== active?.id && !draft.workflowIds.includes(w.id))
  const hasAgentParams = (w: (typeof workflows)[number]) => {
    const { derived, groups } = paramsFor(w)
    return groups.some((g) => derived.some((d) => d.agents.some((a) => a.id === g.agentId)))
  }
  const aiParams = (w: (typeof workflows)[number], agentId?: string, name?: string) =>
    onAssist({
      kind: 'params',
      workflowId: w.id,
      agentId,
      title: name ? t('AI 配置「{name}」', { name }) : t('AI 配置「{name}」的参数', { name: w.name }),
      start: t('读一下这个项目的目录、脚本和配置，按项目的实际情况把「{name}」的参数配好，说明每一项为什么这么填', {
        name: name ?? w.name,
      }),
    })
  // 一个工作流的配置：暴露项 + 它用到的角色的参数（按角色分组）
  const workflowParamsBody = (w: (typeof workflows)[number]) => {
    const { derived, exposed, groups } = paramsFor(w)
    if (!w.expose.length && !hasAgentParams(w)) return null
    return (
      <div className="flex flex-col gap-3">
        {w.expose.map((e) => (
          <ExposeField
            key={e.key}
            e={e}
            value={paramsOf(w.id)[e.key] as ParamValue | undefined}
            onChange={(v) => setParam(w.id, e.key, v)}
          />
        ))}
        {groups.map((g) => (
          <AgentParamsEditor
            key={g.agentId}
            group={g}
            agents={derived}
            hidden={exposed}
            values={paramsOf(w.id)}
            onChange={(k, v) => setParam(w.id, k, v)}
            aiRunning={false}
            onAi={() => aiParams(w, g.agentId, g.agentName)}
          />
        ))}
      </div>
    )
  }
  // 项目没单独设置时跟随全局的格式，下拉框里直接显示实际生效的那个
  const globalFormat = settings?.fileFormat ?? DEFAULT_FILE_FORMAT
  const format = draft.fileFormat ?? globalFormat
  // AI 配置：一次只开一个，结果只填草稿；用户取消不会改数据
  // （会话本身由外壳拿着，见 AiSession：关掉设置时这里会卸载，对话不跟着停）

  // 「AI 初始化项目」：先快速扫一遍目录（几毫秒，拿技术栈、版本控制这类能直接读出的线索），
  // 再打开 AI 对话，让本机 Agent 在项目目录里写 AGENTS.md 和文档框架、评估工作流和设置。
  // 推荐项回到「AI 初始化」页应用；收下结果才算初始化过，之后才能确认保存
  const [scan, setScan] = useState<Awaited<ReturnType<typeof api.analyzeProject>> | null>(null)
  const startInit = async () => {
    if (!draft.path.trim() || analyzing) return
    setAnalyzing(true)
    try {
      const r = await api.analyzeProject(draft.path)
      setScan(r)
      setSignals(r.signals)
      const start = t('初始化这个项目：写好 AGENTS.md 和项目文档框架，评估可用的工作流，推荐项目设置')
      const subject = { path: draft.path.trim(), scan: scanText(r) }
      // 已经建好的项目：在这个项目里开一个对话来做，过程和结果留在项目的对话列表里（AI 分析统一归属）
      if (project?.id) {
        runAssistInProject({
          kind: 'project',
          projectId: project.id,
          title: t('AI 初始化项目：{name}', { name: project.name }),
          start,
          subject,
          onProposal: (p) => deliver(project.id, p),
        })
        return
      }
      // 新建项目还没保存、没有项目可放对话：照旧在 AI 窗口里做。目录和扫描线索随会话一起存，关掉设置后草稿没了也能继续用
      onAssist({ kind: 'project', title: t('AI 初始化项目'), start, subject })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }
  // 对话里的 AI 按用户要求初始化项目（动作 project.init 打开时带 item=start）：打开就开始，不用再点按钮
  const autoInit = useRef(initialSection === 'init' && item === 'start')
  useEffect(() => {
    if (!autoInit.current) return
    autoInit.current = false
    void startInit()
    // 只在打开时看一次
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // AI 没评估出默认工作流时按项目类型落到内置的「通用项目」/「UE 项目」
  const fallbackWorkflow = (type: 'general' | 'ue') => {
    const want = type === 'ue' ? UE_PROJECT_NAME : GENERAL_NAME
    return workflows.find((w) => w.origin === `builtin:project-${type}`) ?? workflows.find((w) => w.name === want)
  }
  // 刚初始化的结果和上次保存的推荐都按项目类型找内置工作流兜底
  const initType = init?.type ?? draft.initResult?.type
  const initFallbackId = initType ? (fallbackWorkflow(initType)?.id ?? '') : ''
  const acceptInit = (p: ProjectProposal) => {
    // 扫描给的工作流参数（结构技能、文档目录）没被 AI 覆盖时一起推荐
    const params = scan && scan.workflow === p.type ? { ...scan.workflowParams, ...p.params } : p.params
    const def = p.workflows.find((w) => w.verdict === 'default')?.id ?? fallbackWorkflow(p.type)?.id
    const expose = workflows.find((w) => w.id === def)?.expose ?? []
    const result: ProjectProposal = {
      ...p,
      params: Object.fromEntries(Object.entries(params).filter(([k]) => expose.some((e) => e.key === k))),
    }
    setInit(result)
    // 推荐随项目保存：关掉设置再打开，卡片上还能直接应用（点「确认」才真正写进项目）
    setDraft((d) => ({ ...d, initializedAt: new Date().toISOString(), initResult: result }))
    setDirInit(false)
    setSection('init')
    // AGENTS.md 刚被改过，「项目说明」页要读新的
    if (project?.path)
      void api
        .projectDocs(project.id)
        .then(setDocs)
        .catch(() => {})
    toast.success(t('初始化完成，按需应用推荐的设置后点「确认」保存'))
  }

  // 左边的菜单：常规、通用的项目说明、各个 CLI 读的说明文件
  // 还没初始化的旧项目打开时先到「AI 初始化」：不初始化就不能保存
  const [section, setSection] = useState(initialSection || (project && !project.initializedAt ? 'init' : 'general'))
  const [lessonIds0] = useState(() => new Set(project?.lessons.map((l) => l.id)))
  const [docs, setDocs] = useState<ProjectDocs | null>(null)
  const [docError, setDocError] = useState('')
  const [docDrafts, setDocDrafts] = useState<Partial<Record<DocFile, string>>>({})
  // 说明文件按保存过的目录读；目录改了要先确认保存，免得读写到旧目录
  const docsReady = !!project && !!project.path && draft.path.trim() === project.path
  useEffect(() => {
    if (!project || !project.path) return
    api
      .projectDocs(project.id)
      .then(setDocs)
      .catch((e) => setDocError((e as Error).message))
  }, [project])
  const docOf = (f: DocFile) => docs?.files.find((d) => d.path === f)
  const changedDocs = (Object.entries(docDrafts) as [DocFile, string][]).filter(
    ([f, c]) => c !== (docOf(f)?.content ?? '') && (docOf(f)?.exists || c.trim()),
  )
  const isChanged = (files: DocFile[]) => changedDocs.some(([f]) => files.includes(f))
  const hasDoc = (files: DocFile[]) => files.some((f) => docOf(f)?.exists)
  // 停用的 CLI 不在项目设置里出现
  const cliPages = orderClis(CLIS, settings?.cliOrder ?? []).filter(
    (c) => c.docs.length && (!settings || cliSettings(settings, c.id).enabled),
  )

  const confirm = async () => {
    if (!valid || saving || !draft.initializedAt) return
    setSaving(true)
    try {
      // 初始化结果不在表单里编辑：本次刚初始化出来的用新的，否则用服务端最新的那份。
      // 打开设置时手里的旧推荐不能写回去：期间可能已经在别处重新初始化或应用过推荐
      const latest = project
        ? await api
            .projects()
            .then((list) => list.find((x) => x.id === project.id))
            .catch(() => undefined)
        : undefined
      // 弹窗开着时角色在对话里新记的教训（打开时还没有、草稿里也没有）一起留下，不被这次保存盖掉
      const inDraft = new Set(draft.lessons.map((x) => x.id))
      const fresh = (project?.lessons ?? []).filter((l) => !lessonIds0.has(l.id) && !inDraft.has(l.id))
      const input = {
        ...draft,
        name: draft.name.trim(),
        workflowId: draft.workflowId || (inherited ? '' : (general?.id ?? '')),
        lessons: [...draft.lessons, ...fresh],
        // 服务端会在保存时严格校验推荐，坏值原样发回去会让整个设置保存被 400 拒掉（数据文件是用户可改的）
        initResult: init ?? readProjectProposal(latest?.initResult) ?? draft.initResult,
      }
      if (project) {
        // 说明文件先存：写到项目目录里，失败时项目设置也不算保存成功，改动还留在弹窗里
        for (const [f, c] of changedDocs) await api.saveProjectDoc(project.id, f, c)
        const saved = await api.updateProject(project.id, input)
        setProjects((ps) => ps.map((p) => (p.id === saved.id ? saved : p)))
        toast.success(t('项目设置已保存'))
      } else {
        const p = await api.createProject(input)
        setProjects((ps) => [...ps, p])
        created.current = true
        keep.current = false
        stash.current = null
        onCreated(p.id)
        go({ page: 'projects', id: p.id })
      }
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!project) return
    try {
      await api.deleteProject(project.id)
      setProjects((ps) => ps.filter((p) => p.id !== project.id))
      // 后端连同任务一起删了，侧栏的对话也要去掉
      void reloadTasks()
      toast.success(t('已删除「{name}」', { name: project.name }))
      setDeleting(false)
      onClose()
      if (route.page === 'projects' && route.id === project.id) go({ page: 'home' })
    } catch (e) {
      toast.error((e as Error).message)
      setDeleting(false)
    }
  }

  /**
   * 把 AI 的结果填进表单。会话在外壳手里：设置关着时点「填进表单」会先把设置重新打开，
   * Body 挂载后把排队的那份结果应用掉。
   */
  const applyAi = (p: Proposal) => {
    if (p.kind === 'params') {
      const id = ai?.workflowId || p.workflowId || active?.id
      const wf = workflows.find((w) => w.id === id)
      const spec = wf ? derivedParams(wf, agents) : []
      if (id)
        setDraft((d) => {
          const next = { ...(d.workflowParams[id] ?? {}), ...p.values }
          // 等于默认值的不存：存下来会覆盖工作流节点上的预设（例如第一个节点的「先识别现场」）
          for (const [k, v] of Object.entries(p.values)) {
            const def = spec.find((x) => x.key === k)
            if (def && isDefaultValue(def, v)) delete next[k]
          }
          return { ...d, workflowParams: { ...d.workflowParams, [id]: next } }
        })
      toast.success(t('已填进表单，确认保存后生效'))
    } else if (p.kind === 'project') {
      acceptInit(p)
    } else if (p.kind === 'teststeps') {
      set('testSteps', p.steps)
      toast.success(t('已填进表单，确认保存后生效'))
    }
  }
  // 交给外壳的永远是最新这一份（里面读的是当前草稿）；挂载时把关掉设置期间排队的应用掉
  const applyLatest = useRef(applyAi)
  applyLatest.current = applyAi
  useEffect(() => {
    const handler: ApplyAi = (p) => applyLatest.current(p)
    applyRef.current = handler
    const queuedNow = queued.current
    queued.current = []
    for (const one of queuedNow) handler(one)
    return () => {
      if (applyRef.current === handler) applyRef.current = null
    }
    // 注册一次转发就够：applyLatest 每次渲染都指向当前草稿，不用重挂
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b px-6 py-4">
        <D.Title className="min-w-0 flex-1 truncate font-serif text-[1.125rem] font-semibold">
          {project ? t('项目设置 · {name}', { name: project.name }) : t('新建项目')}
        </D.Title>
        <DialogCloseButton />
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={t('项目设置分类')}
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b bg-rail p-2 md:w-[244px] md:flex-col md:overflow-visible md:border-r md:border-b-0 md:p-3"
        >
          <NavItem on={section === 'general'} onClick={() => setSection('general')}>
            <Settings2 className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('常规')}
          </NavItem>
          <NavItem on={section === 'init'} onClick={() => setSection('init')} dot={!draft.initializedAt}>
            <Sparkles className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('AI 初始化')}
          </NavItem>
          <NavItem
            on={section === 'roles'}
            onClick={() => setSection('roles')}
            dot={Object.values(draft.agentParams).some((v) => Object.keys(v).length > 0)}
          >
            <Users className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('必备角色')}
          </NavItem>
          <NavItem on={section === 'workflows'} onClick={() => setSection('workflows')}>
            <WorkflowIcon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('工作流')}
          </NavItem>
          <NavItem
            on={section === 'tests'}
            onClick={() => setSection('tests')}
            hint={draft.testSteps.length ? t('{n} 步', { n: draft.testSteps.length }) : undefined}
          >
            <FlaskConical className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('测试步骤')}
          </NavItem>
          <NavItem
            on={section === 'lessons'}
            onClick={() => setSection('lessons')}
            hint={draft.lessons.length ? t('{n} 条', { n: draft.lessons.length }) : undefined}
          >
            <GraduationCap className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('项目教训')}
          </NavItem>
          <NavItem on={section === 'skills'} onClick={() => setSection('skills')}>
            <Library className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            Skill
          </NavItem>
          <NavItem on={section === 'mcp'} onClick={() => setSection('mcp')}>
            <Plug className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('MCP')}
          </NavItem>
          <NavItem
            on={section === 'doc'}
            onClick={() => setSection('doc')}
            dot={isChanged([SHARED_DOC, 'AGENT.md'])}
            hint={hasDoc([SHARED_DOC]) ? SHARED_DOC : undefined}
          >
            <FileText className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('项目说明')}
          </NavItem>
          <span className="hidden px-2.5 pt-4 pb-1 text-[0.6875rem] text-subtle md:block">
            {t('各个 Agent 读的说明')}
          </span>
          {cliPages.map((c) => (
            <NavItem
              key={c.id}
              on={section === `cli:${c.id}`}
              onClick={() => setSection(`cli:${c.id}`)}
              dot={isChanged(cliDocs(c.id))}
              hint={cliDocs(c.id).find((f) => docOf(f)?.exists)}
            >
              <span className="h-4 w-4 shrink-0 rounded-[4px]" style={{ background: cliColor(c.id) }} />
              {c.name}
            </NavItem>
          ))}
        </nav>
        {section === 'mcp' ? (
          <div className={dialogScrollClass}>
            {!project ? (
              <p className="text-[0.8125rem] leading-relaxed text-subtle">
                {t('先创建项目，再管这个项目的 MCP 配置。')}
              </p>
            ) : !project.path || draft.path.trim() !== project.path ? (
              <p className="text-[0.8125rem] leading-relaxed text-subtle">
                {t('本地目录改了，先点「确认」保存，再管新目录里的 MCP 配置。')}
              </p>
            ) : (
              <ProjectMcpSection key={project.id} project={project} />
            )}
          </div>
        ) : section === 'skills' ? (
          <div className={dialogScrollClass}>
            {!project ? (
              <p className="text-[0.8125rem] leading-relaxed text-subtle">{t('先创建项目，再管理项目里的技能。')}</p>
            ) : !project.path || draft.path.trim() !== project.path ? (
              <p className="text-[0.8125rem] leading-relaxed text-subtle">
                {t('本地目录改了，先点「确认」保存，再管理新目录里的技能。')}
              </p>
            ) : (
              <ProjectSkillsSection key={project.id} projectId={project.id} />
            )}
          </div>
        ) : section === 'doc' || section.startsWith('cli:') ? (
          <div className={dialogScrollClass}>
            {!docsReady || !docs ? (
              <p className="text-[0.8125rem] leading-relaxed text-subtle">
                {!project
                  ? t('先创建项目，再编辑项目里的说明文件。')
                  : !project.path || draft.path.trim() !== project.path
                    ? t('本地目录改了，先点「确认」保存，再编辑新目录里的说明文件。')
                    : docError || t('正在读取…')}
              </p>
            ) : section === 'doc' ? (
              <DocPage
                key="doc"
                projectId={project!.id}
                title={t('项目说明')}
                desc={t(
                  'AGENTS.md 放在项目根目录，Codex 和 Command Code 每次启动都会读它，写这个项目的约定、常用命令和注意事项。Claude Code 读的是 CLAUDE.md，可以在左边的 Claude Code 里编辑，或在 CLAUDE.md 里写一行 @AGENTS.md 引用它。',
                )}
                files={[SHARED_DOC]}
                docs={docs.files}
                drafts={docDrafts}
                onDraft={(f, c) => setDocDrafts((d) => ({ ...d, [f]: c }))}
                note={
                  docOf('AGENT.md')?.exists &&
                  !docOf(SHARED_DOC)?.exists && (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-2.5 text-[0.8125rem]">
                      <span className="min-w-0 flex-1">
                        {t('检测到 AGENT.md，但各个 Agent 只读 AGENTS.md（多一个 s），现在这个文件不会被读到。')}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setDocDrafts((d) => ({ ...d, [SHARED_DOC]: docOf('AGENT.md')!.content }))}
                      >
                        {t('复制到 AGENTS.md')}
                      </Button>
                    </div>
                  )
                }
              />
            ) : (
              (() => {
                const id = section.slice(4)
                const name = CLIS.find((c) => c.id === id)?.name ?? id
                const files = cliDocs(id)
                return (
                  <DocPage
                    key={section}
                    projectId={project!.id}
                    title={name}
                    desc={CLIS.find((c) => c.id === id)?.docsNote ?? ''}
                    files={files}
                    docs={docs.files}
                    drafts={docDrafts}
                    onDraft={(f, c) => setDocDrafts((d) => ({ ...d, [f]: c }))}
                    extra={
                      <section className="flex flex-col gap-2 pt-6">
                        <h3 className="text-[0.8125rem] font-medium">Skills</h3>
                        <p className="text-[0.75rem] text-muted">
                          {t('{cli} 在这个项目里能用的 Skill，包括用户目录下的和项目里的', { cli: name })}
                        </p>
                        <CliSkills key={id} cli={id} projectId={project!.id} />
                      </section>
                    }
                  />
                )
              })()
            )}
          </div>
        ) : (
          <form
            id="project-settings"
            onSubmit={(e) => {
              e.preventDefault()
              void confirm()
            }}
            className={cn(dialogScrollClass, 'gap-7 md:flex-row')}
          >
            {section === 'init' ? (
              <ProjectInitPanel
                draft={draft}
                setDraft={setDraft}
                result={init}
                workflows={workflows}
                activeId={active?.id ?? ''}
                fallbackId={initFallbackId}
                fromDir={dirInit}
                globalFormat={globalFormat}
                canStart={!!draft.path.trim()}
                starting={analyzing || ai?.kind === 'project'}
                signals={signals}
                onStart={() => void startInit()}
              />
            ) : section === 'roles' ? (
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <PageIntro
                  title={t('必备角色')}
                  desc={t(
                    '项目对话靠这几个角色运转：统筹分派、执行做事、文档落盘、测试验收、版本控制收尾。角色本身不能换，这里改的参数只对这个项目生效，没改的跟随角色页里的默认值。',
                  )}
                />
                {coreAgents.map((a) => (
                  <Collapsible
                    key={a.id}
                    defaultOpen={coreAgents.indexOf(a) === 0}
                    leading={<AgentAvatar icon={a.icon} cli={a.cli} size="sm" />}
                    title={a.name}
                    subtitle={coreUse(coreKey(a)!)}
                    badge={
                      Object.keys(draft.agentParams[a.id] ?? {}).length
                        ? t('改了 {n} 项', { n: Object.keys(draft.agentParams[a.id] ?? {}).length })
                        : undefined
                    }
                    actions={
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => go({ page: 'agents', id: a.id })}
                        title={t('去角色页改所有项目的默认值和模型')}
                      >
                        {t('角色设置')}
                      </Button>
                    }
                  >
                    {a.params.length ? (
                      <ParamsForm
                        params={a.params}
                        values={draft.agentParams[a.id] ?? {}}
                        onChange={(v) =>
                          setDraft((d) => {
                            const next = { ...d.agentParams }
                            if (Object.keys(v).length) next[a.id] = v
                            else delete next[a.id]
                            return { ...d, agentParams: next }
                          })
                        }
                      />
                    ) : (
                      <p className="text-xs text-subtle">{t('这个角色没有可调的参数。')}</p>
                    )}
                  </Collapsible>
                ))}
                {!coreAgents.length && (
                  <p className="text-xs text-subtle">{t('必备角色还没装好，重启面板后会自动补上。')}</p>
                )}
              </div>
            ) : section === 'workflows' ? (
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <PageIntro
                  title={t('工作流')}
                  desc={t(
                    '子对话要改代码时按工作流执行：默认用下面这一个，需求更适合某个可选工作流时，执行角色会改用它。每个工作流的配置分开保存，对新开的对话生效。',
                  )}
                />
                <div className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1 text-xs text-muted">
                    {t('默认工作流')}
                    <HelpTip>
                      {t('只能从「{cat}」分类里选：这类工作流是为项目常驻流程设计的。', { cat: PROJECT_WF_CATEGORY })}
                    </HelpTip>
                  </span>
                  <Select
                    aria-label={t('默认工作流')}
                    value={draft.workflowId}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        workflowId: e.target.value,
                        workflowIds: d.workflowIds.filter((x) => x !== e.target.value),
                      }))
                    }
                    options={[
                      ...(!draft.workflowId
                        ? [
                            {
                              value: '',
                              label: inherited
                                ? t('跟随分类：{name}', { name: inherited.name })
                                : general
                                  ? t('未选择，将使用「{name}」', { name: general.name })
                                  : t('请选择工作流'),
                            },
                          ]
                        : []),
                      ...defaultChoices.map((w) => ({ value: w.id, label: w.name })),
                    ]}
                  />
                </div>
                {active && (
                  <WorkflowCard
                    key={active.id}
                    w={active}
                    isDefault
                    defaultOpen
                    body={workflowParamsBody(active)}
                    onAi={hasAgentParams(active) ? () => aiParams(active) : undefined}
                  />
                )}
                <div className="flex items-center gap-2 pt-2">
                  <span className="text-xs text-muted">{t('可选工作流')}</span>
                  <span className="text-xs text-subtle">{t('{n} 个', { n: optionalWorkflows.length })}</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="secondary" className="ml-auto" disabled={!addable.length}>
                        <Plus className="h-3.5 w-3.5" />
                        {t('添加可选工作流')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-[320px]">
                      <div className="max-h-72 overflow-y-auto">
                        {addable.map((w) => (
                          <PopoverClose
                            key={w.id}
                            className={menuItem}
                            onClick={() => set('workflowIds', [...draft.workflowIds, w.id])}
                          >
                            <WorkflowIcon className="h-4 w-4 shrink-0 text-subtle" />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate">{w.name}</span>
                              {w.description && (
                                <span className="truncate text-[0.71875rem] text-subtle">{w.description}</span>
                              )}
                            </span>
                          </PopoverClose>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
                {optionalWorkflows.length === 0 && (
                  <p className="rounded-xl border border-dashed px-4 py-5 text-center text-xs text-subtle">
                    {t('还没有可选工作流。像 Bug 修复、发布这类流程可以加进来，需求合适时执行角色会自动选它。')}
                  </p>
                )}
                {optionalWorkflows.map((w) => (
                  <WorkflowCard
                    key={w.id}
                    w={w}
                    body={workflowParamsBody(w)}
                    onAi={hasAgentParams(w) ? () => aiParams(w) : undefined}
                    onRemove={() =>
                      set(
                        'workflowIds',
                        draft.workflowIds.filter((x) => x !== w.id),
                      )
                    }
                  />
                ))}
              </div>
            ) : section === 'lessons' ? (
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <PageIntro
                  title={t('项目教训')}
                  desc={t(
                    '角色在这个项目里返工过、走过弯路的地方，写成下次能直接照做的规则。被纠正、或自己发现办法不对换了做法时，角色会自己记一条，标「角色记录」；你的新要求和某条冲突时，角色会找两全的做法改写它，找不到就先问你。新会话开头只带「所有改动」的全文和其余条目的标题，改到哪些文件再取对应的全文。优先级：你当次的要求 > 项目教训 > 全局教训。',
                  )}
                />
                <LessonsEditor
                  lessons={draft.lessons}
                  onChange={(v) => set('lessons', v)}
                  project={project}
                  initialOpen={item}
                />
              </div>
            ) : section === 'tests' ? (
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <PageIntro
                  title={t('测试步骤')}
                  desc={t(
                    '测试验收角色按这里的顺序执行，新建对话时快照进任务。写清楚命令、在哪执行和什么时候跑，没有配置时它会自己找命令并提醒你补上。',
                  )}
                />
                <Checkbox
                  checked={draft.scaledVerify}
                  onChange={(v) => set('scaledVerify', v)}
                  label={t('按改动大小决定验证范围')}
                  tip={t(
                    '对话里改代码时，角色先判断改动大小：改文案、样式这类小改动只跑勾了「小改动也跑」的步骤就收尾，其他改动跑完整的测试步骤。关掉后每次都按「适用改动」跑完整的步骤（不适用的一样跳过）。工作流里的测试验收不受影响。',
                  )}
                />
                <TestStepsEditor
                  steps={draft.testSteps}
                  distro={draft.wslDistro}
                  gitRepo={gitRepo}
                  onChange={(v) => set('testSteps', v)}
                  onDistro={(v) => set('wslDistro', v)}
                  aiRunning={false}
                  onAi={() =>
                    onAssist({
                      kind: 'teststeps',
                      title: t('AI 生成测试步骤'),
                      start: t('按这个项目现在的脚本和配置，生成类型检查、单元测试、端到端和构建的测试步骤'),
                    })
                  }
                />
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col gap-7">
                <FormSection title={t('基本信息')}>
                  <div className="flex flex-wrap gap-4">
                    <Field
                      label={t('名称')}
                      className="flex-[1_1_200px]"
                      error={draft.name.trim() ? undefined : t('名称不能为空')}
                    >
                      <Input
                        autoFocus={!project}
                        value={draft.name}
                        onChange={(e) => set('name', e.target.value)}
                        placeholder={t('例如：官网前端')}
                      />
                    </Field>
                    <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
                      <span className="text-xs text-muted">{t('分类')}</span>
                      <CategoryPicker
                        value={draft.categoryId}
                        onChange={(id) => set('categoryId', id)}
                        options={projectCategories}
                        onCreate={async (name) => {
                          const c = await api.createProjectCategory({ name, description: '', workflowId: '' })
                          setProjectCategories((cs) => [...cs, c])
                          return c
                        }}
                      />
                    </div>
                  </div>
                  <Field label={t('简介')}>
                    <Input
                      value={draft.description}
                      onChange={(e) => set('description', e.target.value)}
                      placeholder={t('这个项目是做什么的')}
                    />
                  </Field>
                </FormSection>

                <FormSection title={t('本地目录')}>
                  <DirPicker value={draft.path} onChange={pickDir} info={dir} />
                  {!draft.initializedAt && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft/40 px-3.5 py-2.5">
                      <Sparkles className="h-4 w-4 shrink-0 text-accent" />
                      <span className="min-w-0 flex-1 text-[0.8125rem]">
                        {draft.path.trim()
                          ? t('选好目录后先 AI 初始化项目：写好 AGENTS.md 和文档框架，并推荐工作流和设置。')
                          : t('选好本地目录后，先 AI 初始化项目才能保存。')}
                      </span>
                      <Button size="sm" onClick={() => void startInit()} disabled={!draft.path.trim() || analyzing}>
                        {analyzing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5" />
                        )}
                        {t('AI 初始化项目')}
                      </Button>
                    </div>
                  )}
                </FormSection>

                <FormSection title={t('文件格式')}>
                  <div className="flex flex-wrap gap-3">
                    <Field
                      label={t('编码')}
                      className="flex-[1_1_200px]"
                      tip={t(
                        '这个项目里新建和改写的文本文件用它，角色写文件时也按这个来。默认 UTF-8（不带 BOM）+ LF，在 WSL / Linux 里执行带 shebang 的脚本不会报 bad interpreter。',
                      )}
                    >
                      <Select
                        value={format.encoding}
                        onChange={(e) =>
                          set('fileFormat', { ...format, encoding: e.target.value as typeof format.encoding })
                        }
                        options={[
                          { value: 'utf8', label: t('UTF-8（不带 BOM）') },
                          { value: 'utf8-bom', label: 'UTF-8（带 BOM）' },
                        ]}
                      />
                    </Field>
                    <Field label={t('换行符')} className="flex-[1_1_200px]">
                      <Select
                        value={format.eol}
                        onChange={(e) => set('fileFormat', { ...format, eol: e.target.value as typeof format.eol })}
                        options={[
                          { value: 'lf', label: 'LF（Linux / macOS）' },
                          { value: 'crlf', label: 'CRLF（Windows）' },
                        ]}
                      />
                    </Field>
                  </div>
                  <span className="text-xs text-subtle">
                    {!draft.fileFormat && (
                      <>
                        <button
                          type="button"
                          className="cursor-pointer text-accent hover:underline"
                          onClick={() => set('fileFormat', { ...globalFormat })}
                        >
                          {t('和全局设置不同时，在这里单独指定')}
                        </button>
                      </>
                    )}
                    {draft.fileFormat && (
                      <>
                        <button
                          type="button"
                          className="cursor-pointer text-accent hover:underline"
                          onClick={() => set('fileFormat', undefined)}
                        >
                          {t('跟随全局设置')}
                        </button>
                      </>
                    )}
                  </span>
                </FormSection>

                <FormSection title={t('搜索')}>
                  <SearchExcludeField value={draft.searchExclude} onChange={(v) => set('searchExclude', v)} />
                </FormSection>

                <FormSection title={t('子对话')}>
                  <Field
                    label={t('子对话隔离')}
                    tip={
                      draft.childIsolation === 'worktree'
                        ? t(
                            '每个子对话要改文件时才开自己的独立分支目录，互不干扰；编译、测试在自己的分支里跑，通过后排队合回父对话所在的分支，有冲突撤回并交回子对话。子对话标记完成后删除分支。不是 Git 仓库（P4 等）时自动用共用目录。',
                          )
                        : t(
                            '子对话都在项目目录里直接改，改文件前先认领，同一个文件同一时间只归一个子对话。不用建分支，但编译时可能读到别的子对话改到一半的文件。',
                          )
                    }
                  >
                    <div>
                      <Segmented
                        label={t('子对话隔离')}
                        value={draft.childIsolation}
                        onChange={(v) => set('childIsolation', v as ProjectInput['childIsolation'])}
                        options={[
                          { id: 'worktree', label: t('独立 worktree（推荐）') },
                          { id: 'claim', label: t('共用目录 + 认领文件') },
                        ]}
                      />
                    </div>
                  </Field>
                </FormSection>

                <FormSection title={t('版本与推送')}>
                  <Field
                    label={t('推送到远端')}
                    tip={t(
                      '只管 Git 推送，本地提交不受影响。允许直接推送：对话做完、本地提交后直接推到跟踪的远端分支；问一次：那时先问你；不推送：面板直接拦下 git push。创建 PR、P4 submit 仍要你在对话里要求。',
                    )}
                  >
                    <Select
                      value={draft.gitPolicy}
                      onChange={(v) => set('gitPolicy', v.target.value as ProjectInput['gitPolicy'])}
                      options={[
                        { value: 'ask', label: t('第一次需要推送时问一次（推荐）') },
                        { value: 'allow', label: t('允许直接推送') },
                        { value: 'deny', label: t('不推送，只做本地提交') },
                      ]}
                    />
                  </Field>
                </FormSection>
              </div>
            )}
            {section === 'general' && (
              <aside className="flex shrink-0 flex-col gap-4 md:w-[260px]">
                <ReadinessCard checks={checks} />
              </aside>
            )}
          </form>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t bg-panel/60 px-6 py-3.5">
        {project && (
          <Button
            variant="ghost"
            className="text-danger hover:bg-danger/10 hover:text-danger"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t('删除项目')}
          </Button>
        )}
        <span className="ml-auto" />
        <Button variant="secondary" onClick={onClose}>
          {t('取消')}
        </Button>
        {changedDocs.length > 0 && (
          <span className="text-xs text-subtle">{t('{n} 个说明文件有改动', { n: changedDocs.length })}</span>
        )}
        {!draft.initializedAt && (
          <button
            type="button"
            className="cursor-pointer text-xs text-warning hover:underline"
            onClick={() => setSection('init')}
          >
            {t('先完成「AI 初始化项目」才能保存')}
          </button>
        )}
        {!!draft.initializedAt && !active && (
          <button
            type="button"
            className="cursor-pointer text-xs text-warning hover:underline"
            onClick={() => setSection('workflows')}
          >
            {t('请为项目选择子对话默认工作流')}
          </button>
        )}
        <Button onClick={() => void confirm()} disabled={!valid || saving || !draft.initializedAt}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {project ? t('确认') : t('创建')}
        </Button>
      </footer>

      {project && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={t('删除「{name}」？', { name: project.name })}
          description={t('会删除面板里的配置和这个项目的所有对话，不会动本地目录里的文件。')}
          onConfirm={remove}
        />
      )}
    </>
  )
}

/** 扫描结果写成交给 AI 的线索 */
function scanText(r: Awaited<ReturnType<typeof api.analyzeProject>>) {
  return [
    `- 名称：${r.name}`,
    r.description ? `- 简介：${r.description}` : '',
    `- 类型：${r.workflow}`,
    ...r.signals.map((s) => `- ${s}`),
    r.testSteps.length ? `- 扫出的测试步骤：${r.testSteps.map((s) => `${s.name}（${s.command}）`).join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 每个设置页顶上的标题和一句说明 */
function PageIntro({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex flex-col gap-1 pb-1">
      <h3 className="text-[0.9375rem] font-semibold">{title}</h3>
      <p className="text-[0.78125rem] leading-relaxed text-subtle">{desc}</p>
    </div>
  )
}

/** 可以折叠的卡片：标题行常驻（图标、名称、说明、角标、操作），内容点开才显示 */
function Collapsible({
  leading,
  title,
  subtitle,
  badge,
  actions,
  defaultOpen = false,
  children,
}: {
  leading?: React.ReactNode
  title: string
  subtitle?: string
  badge?: string
  actions?: React.ReactNode
  defaultOpen?: boolean
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        >
          <ChevronRight
            className={cn('h-4 w-4 shrink-0 text-subtle transition-transform', open && 'rotate-90')}
            strokeWidth={2}
          />
          {leading}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[0.8125rem] font-medium">{title}</span>
            {subtitle && <span className="truncate text-[0.71875rem] text-subtle">{subtitle}</span>}
          </span>
          {badge && (
            <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] text-accent">
              {badge}
            </span>
          )}
        </button>
        {actions}
      </div>
      {open && children && <div className="border-t px-3.5 py-3.5">{children}</div>}
    </section>
  )
}

/** 一个工作流的卡片：默认的标「默认」，可选的能移除；有参数时点开配置 */
function WorkflowCard({
  w,
  isDefault,
  defaultOpen,
  body,
  onAi,
  onRemove,
}: {
  w: Workflow
  isDefault?: boolean
  defaultOpen?: boolean
  body: React.ReactNode
  onAi?: () => void
  onRemove?: () => void
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      leading={<WorkflowIcon className="h-4 w-4 shrink-0 text-subtle" />}
      title={w.name}
      subtitle={w.description || undefined}
      badge={isDefault ? t('默认') : undefined}
      actions={
        <>
          {onAi && (
            <Button size="sm" variant="ghost" onClick={onAi}>
              <Sparkles className="h-3.5 w-3.5" />
              {t('AI 配置')}
            </Button>
          )}
          {onRemove && (
            <Button size="icon-sm" variant="ghost" aria-label={t('移除')} title={t('移除')} onClick={onRemove}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </>
      }
    >
      {body ?? <p className="text-xs text-subtle">{t('这个工作流没有需要配置的参数。')}</p>}
    </Collapsible>
  )
}

/**
 * 测试步骤编辑器：增删、排序、启停，每条写明名称、命令、环境和工作目录。
 * 步骤属于项目，新建对话时会快照进任务，所以这里改完要点「确认」保存。
 */
function TestStepsEditor({
  steps,
  distro,
  gitRepo,
  onChange,
  onDistro,
  onAi,
  aiRunning,
}: {
  steps: TestStep[]
  distro: string
  /** 项目是 Git 仓库：「在父对话中执行」才生效（ADR 0018），不是时置灰并说明原因 */
  gitRepo: boolean
  onChange: (v: TestStep[]) => void
  onDistro: (v: string) => void
  onAi: () => void
  aiRunning: boolean
}) {
  const patch = (i: number, p: Partial<TestStep>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...p } : s)))
  // 「适用改动」在输入过程中保存用户敲的原文（逗号、空格原样回显），失焦后才按 parseGlobs 归一。
  // 每次按键就 parse 再 join 会把刚敲下的逗号吞掉，手敲不进第二条 glob，续敲会拼成匹配不上的串。
  // 草稿按步骤 id 记：上下移动不会串到别的步骤；内部生成的步骤 id 可能重复（两个都叫 node-typecheck），
  // 那时草稿会短暂盖住 AI 回填的新值，下一次失焦就对上了
  const [appliesDraft, setAppliesDraft] = useState<Record<string, string>>({})
  const dropDraft = (id: string) =>
    setAppliesDraft((d) => {
      const next = { ...d }
      delete next[id]
      return next
    })
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const hasWsl = steps.some((s) => s.env === 'wsl')
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-xs leading-relaxed text-subtle">
          {t(
            '测试角色按这些步骤执行构建、测试和检查。新建对话时快照进任务，之后改这里不影响已经开始的对话；没配置时角色会自己找命令并建议你补上。',
          )}
          {t(
            '每条可以写「适用改动」（glob）：只改文档、资源这类没碰到的步骤会被跳过，并在验收结论里写清原因——同时会算上从远端拉取、合并进来的改动。',
          )}
          {t(
            '勾了「在父对话中执行」的步骤子对话不跑：合并回父对话的分支后由父对话跑（一次只跑一个），结果和耗时回传给子对话。只对 Git 项目生效，适合端到端测试这类很吃资源的步骤。',
          )}
        </span>
        <Button size="sm" variant="secondary" onClick={onAi} disabled={aiRunning}>
          {aiRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('AI 生成步骤')}
        </Button>
      </div>
      {steps.length === 0 && (
        <p className="rounded-lg border border-dashed p-3 text-xs text-subtle">
          {t('还没有测试步骤。「AI 初始化项目」会按项目的脚本推荐一份。')}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <li
            key={s.id}
            className={cn('flex flex-col gap-2 rounded-xl border bg-field/40 p-3', !s.enabled && 'opacity-60')}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-subtle">{i + 1}</span>
              <Input
                className="h-8 flex-[1_1_140px]"
                value={s.name}
                aria-label={t('步骤名')}
                placeholder={t('步骤名，例如「单元测试」')}
                onChange={(e) => patch(i, { name: e.target.value })}
              />
              <Select
                className="h-8 w-auto min-w-[6.5rem]"
                aria-label={t('环境')}
                value={s.env}
                onChange={(e) => patch(i, { env: e.target.value as TestStep['env'] })}
                options={(Object.keys(ENV_LABEL) as TestStep['env'][]).map((k) => ({ value: k, label: ENV_LABEL[k] }))}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('上移')}
                title={t('上移')}
                onClick={() => move(i, -1)}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('下移')}
                title={t('下移')}
                onClick={() => move(i, 1)}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('删除这一步')}
                title={t('删除这一步')}
                onClick={() => onChange(steps.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Input
              className="h-8 font-mono text-xs"
              value={s.command}
              aria-label={t('命令')}
              placeholder={t('要执行的命令')}
              onChange={(e) => patch(i, { command: e.target.value })}
            />
            <Input
              className="h-8 font-mono text-xs"
              value={appliesDraft[s.id] ?? (s.appliesTo ?? []).join(', ')}
              aria-label={t('适用改动')}
              placeholder={t('适用改动（相对项目根的 glob，逗号分隔）：例如 **/*.cpp、**/Build.cs；留空表示总是执行')}
              onChange={(e) => {
                // 原文留给输入框，步骤里存解析后的 glob：保存和提示词都读后者
                const text = e.target.value
                setAppliesDraft((d) => ({ ...d, [s.id]: text }))
                patch(i, { appliesTo: parseGlobs(text) })
              }}
              onBlur={() => dropDraft(s.id)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 flex-[1_1_120px] font-mono text-xs"
                value={s.cwd}
                aria-label={t('工作目录')}
                placeholder={t('工作目录（相对项目根，可空）')}
                onChange={(e) => patch(i, { cwd: e.target.value })}
              />
              <Input
                className="h-8 flex-[1_1_140px] text-xs"
                value={s.when}
                aria-label={t('补充说明')}
                placeholder={t('补充说明，写给人看（判定以适用改动为准）')}
                onChange={(e) => patch(i, { when: e.target.value })}
              />
              <Input
                className="h-8 w-[7rem] text-xs"
                type="number"
                min={0}
                value={s.timeoutSec || ''}
                aria-label={t('超时秒数')}
                placeholder={t('超时（秒）')}
                onChange={(e) => patch(i, { timeoutSec: Math.max(0, Number(e.target.value) || 0) })}
              />
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={s.enabled}
                  onChange={(e) => patch(i, { enabled: e.target.checked })}
                />
                {t('启用')}
              </label>
              <label
                className="flex cursor-pointer items-center gap-1.5 text-xs text-muted"
                title={t('角色判断是小改动时只跑勾了这项的步骤，适合几十秒内跑完的类型检查、lint')}
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={s.quick}
                  onChange={(e) => patch(i, { quick: e.target.checked })}
                />
                {t('小改动也跑')}
              </label>
              <label
                className={cn(
                  'flex items-center gap-1.5 text-xs',
                  gitRepo ? 'cursor-pointer text-muted' : 'cursor-not-allowed text-subtle',
                )}
                title={
                  gitRepo
                    ? t(
                        '勾了以后子对话不跑这条步骤：合并回父对话的分支后由父对话在它的目录里跑，结果和耗时回传给子对话。适合端到端测试这类很吃资源的步骤。标了「合并时编译」的步骤仍由父对话申请编译，不受这项影响。',
                      )
                    : t(
                        '只对 Git 项目生效：其它版本控制的子对话没有独立分支可合，勾了也不会由父对话跑，所以这里不能选。',
                      )
                }
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={s.runInParent}
                  disabled={!gitRepo}
                  onChange={(e) => patch(i, { runInParent: e.target.checked })}
                />
                {t('在父对话中执行')}
                {!gitRepo && <span className="text-subtle">{t('（只对 Git 项目生效）')}</span>}
              </label>
            </div>
            {s.note && <span className="text-xs text-subtle">{s.note}</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            onChange([
              ...steps,
              {
                id: newTestStepId(steps),
                name: '',
                command: '',
                env: 'auto',
                cwd: '',
                when: '',
                appliesTo: [],
                timeoutSec: 0,
                note: '',
                enabled: true,
                merge: false,
                runInParent: false,
                quick: false,
              },
            ])
          }
        >
          {t('加一条步骤')}
        </Button>
        {hasWsl && (
          <label className="flex items-center gap-2 text-xs text-subtle">
            {t('WSL 发行版')}
            <Input
              className="h-8 w-[10rem] font-mono text-xs"
              value={distro}
              placeholder="Ubuntu-24.04"
              onChange={(e) => onDistro(e.target.value)}
            />
          </label>
        )}
      </div>
    </div>
  )
}

/** 按 Agent 分组的参数表单：值来自 AgentParam.default，留空即用默认；同一 key 只出现一次，注明影响哪些 Agent */
function AgentParamsEditor({
  group,
  agents,
  values,
  onChange,
  onAi,
  aiRunning,
  hidden,
}: {
  group: AgentParamGroup
  /** 同一个 key 在其他 Agent 里也有的情况，派生结果里已经合并，这里只用来显示影响面 */
  agents: DerivedParam[]
  values: Record<string, ParamValue | undefined>
  onChange: (key: string, v: string | boolean) => void
  onAi: () => void
  aiRunning: boolean
  /** 工作流 expose 已经管着的参数 key：同 key 只渲染一次，由 expose 那边负责 */
  hidden: Set<string>
}) {
  // 联动按这个 Agent 自己的参数顺序算：前面参数没选到的不显示，选项跟着前面的取值缩小
  const view = resolveParams(group.params, values as ParamValues)
  const mine = agents.filter(
    (d) => d.agents.some((a) => a.id === group.agentId) && !hidden.has(d.key) && !view.hidden.includes(d.key),
  )
  if (!mine.length) return null
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-field/40 p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-[0.8125rem] font-medium">{group.agentName}</span>
        <span className="text-xs text-subtle">{t('{n} 个参数', { n: mine.length })}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onAi} disabled={aiRunning}>
          {aiRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('AI 配置')}
        </Button>
      </div>
      {mine.map((d) => (
        <DerivedParamField
          key={d.key}
          d={view.options[d.key] ? { ...d, options: view.options[d.key] } : d}
          value={values[d.key]}
          onChange={(v) => onChange(d.key, v)}
        />
      ))}
    </div>
  )
}

/** 参数的默认值写成人能看的字：开关是「是 / 否」，多选用顿号连起来 */
function defaultText(v: ParamValue | undefined) {
  if (v === undefined || v === '') return ''
  if (typeof v === 'boolean') return v ? t('是') : t('否')
  if (Array.isArray(v)) return v.join(t('、'))
  return String(v)
}

/** 一项派生参数：按类型渲染，显示默认值；多个 Agent 共用同一个 key 时注明影响面 */
function DerivedParamField({
  d,
  value,
  onChange,
}: {
  d: DerivedParam
  value: ParamValue | undefined
  onChange: (v: string | boolean) => void
}) {
  const label = d.label || d.key
  const fallback = defaultText(d.defaultValue)
  const shared = d.agents.length > 1
  // 说明、默认值和影响面都收进 ⓘ，行里只留参数名——参数多时一屏能看到全条
  const hint = [
    d.description,
    fallback && t('默认：{v}', { v: fallback }),
    shared && t('同时影响 {names}', { names: [...new Set(d.agents.map((a) => a.name))].join(t('、')) }),
  ]
    .filter(Boolean)
    .join('；')
  return (
    <ParamRow
      label={
        <>
          <span className="truncate font-medium text-muted">{label}</span>
          <span className="shrink-0 font-mono text-[0.6875rem] text-subtle">{d.key}</span>
          {d.required && <span className="shrink-0 text-[0.6875rem] text-warning">{t('必须填')}</span>}
        </>
      }
      hint={hint}
      controlClass={d.type === 'bool' ? undefined : 'w-[min(14rem,50%)]'}
    >
      {d.type === 'select' ? (
        <Select
          aria-label={label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          options={[
            { value: '', label: fallback ? t('默认：{v}', { v: fallback }) : t('未选择') },
            ...d.options.map((o) => ({ value: o, label: o })),
          ]}
        />
      ) : d.type === 'bool' ? (
        <Switch checked={value === true} onCheckedChange={(x) => onChange(x)} aria-label={label} />
      ) : (
        <Input
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fallback ? t('默认：{v}', { v: fallback }) : ''}
          className="h-9"
        />
      )}
    </ParamRow>
  )
}

/** 工作流暴露的一项配置：按类型渲染成下拉、多选、开关或文本框 */
function ExposeField({
  e,
  value,
  onChange,
}: {
  e: WorkflowExpose
  value: ParamValue | undefined
  onChange: (v: ParamValue) => void
}) {
  const label = e.label || e.key
  // 多选存的是字符串数组，早先的版本存成 "a, b" 字符串，这里两种都认
  const text =
    typeof value === 'boolean' ? String(value) : Array.isArray(value) ? value.join(', ') : String(value ?? '')
  const list = Array.isArray(value) ? value : text ? text.split(/\s*,\s*/).filter(Boolean) : []
  // 没改过时显示默认值（这些选项本来就生效），改动后再存实际的数组
  const shown = list.length || !Array.isArray(e.default) ? list : e.default
  const fallback = defaultText(e.default)
  // 和角色参数一样：说明与默认值收进 ⓘ，行里只留名字，控件靠右
  const hint = [e.description, fallback && t('默认：{v}', { v: fallback })].filter(Boolean).join('；')
  const on = value === true || text === 'true'
  return (
    <ParamRow
      label={<span className="truncate font-medium text-muted">{label}</span>}
      hint={hint}
      controlClass={e.type === 'bool' ? undefined : e.type === 'multi' ? 'w-[min(20rem,60%)]' : 'w-[min(14rem,50%)]'}
    >
      {e.type === 'select' ? (
        <Select
          aria-label={label}
          value={text}
          onChange={(ev) => onChange(ev.target.value)}
          options={[
            // 没选时显示默认值（或「未选择」），选了就只显示选中的
            ...(text ? [] : [{ value: '', label: fallback ? t('默认：{v}', { v: fallback }) : t('未选择') }]),
            ...e.options.map((o) => ({ value: o, label: o })),
          ]}
        />
      ) : e.type === 'bool' ? (
        // 开关的取值照旧存成 'true' / 'false' 字符串，和工作流配置里的格式一致
        <Switch checked={on} onCheckedChange={(x) => onChange(x ? 'true' : 'false')} aria-label={label} />
      ) : e.type === 'multi' ? (
        // 多选和角色参数用同一个控件：值是字符串数组，exposeValue 会拼成「a, b」填进 {{槽名}}
        <ParamControl
          param={{
            key: e.key,
            label,
            type: 'multi',
            options: e.options,
            ask: false,
            description: e.description,
            default: e.default,
          }}
          value={shown}
          onChange={(v) => onChange(Array.isArray(v) ? v : [])}
        />
      ) : (
        <Input
          aria-label={label}
          value={text}
          onChange={(ev) => onChange(ev.target.value)}
          placeholder={fallback ? t('默认：{v}', { v: fallback }) : ''}
          className="h-9"
        />
      )}
    </ParamRow>
  )
}

/**
 * 搜索排除目录：一项一个 chip，回车或点「添加」加一项，点 × 删一项。
 * 只存用户填的；内置默认清单（依赖、产物、缓存）始终生效，不占这里的输入。
 */
function SearchExcludeField({ value, onChange }: { value: string[] | undefined; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('')
  const list = value ?? []
  // 输入时就把首尾空白和尾部斜杠去掉：`Saved/` 和 `Saved` 是同一个目录，存两种写法只会重复
  const clean = (s: string) => s.trim().replace(/[\\/]+$/, '')
  const add = () => {
    const item = clean(text)
    setText('')
    if (!item || list.includes(item)) return
    onChange([...list, item])
  }
  // UE 预设只补缺的：已经填过的项不重复加，用户自己加的也留着
  const preset = () => onChange([...list, ...UE_SEARCH_EXCLUDE.filter((d) => !list.includes(d))])
  return (
    <ParamRow
      label={
        <>
          <span className="truncate font-medium text-muted">{t('搜索时跳过的目录')}</span>
          <span className="shrink-0 text-[0.6875rem] text-subtle">{t('相对项目根')}</span>
        </>
      }
      hint={t(
        'Agent 找文件、搜代码时跳过这些目录。大项目里全仓搜索会跑几分钟、命中大量编译产物，所以先读项目文档定位到模块，再在最小目录里搜。Git 项目里 .gitignore 已经忽略的目录会自动跳过，这里只需填它没覆盖的。',
      )}
      stacked
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {list.map((d) => (
            <span
              key={d}
              className="flex h-7 items-center gap-1 rounded-md border border-line-strong bg-field pr-1 pl-2 text-[0.78125rem] text-muted"
            >
              <span className="font-mono">{d}</span>
              <button
                type="button"
                aria-label={t('删除 {name}', { name: d })}
                title={t('删除 {name}', { name: d })}
                onClick={() => onChange(list.filter((x) => x !== d))}
                className="grid h-5 w-5 cursor-pointer place-items-center rounded text-subtle hover:bg-sel hover:text-fg"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <Input
            aria-label={t('搜索时跳过的目录')}
            value={text}
            placeholder={t('目录名，回车添加')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // 回车是加一项，不是提交整个设置表单
              e.preventDefault()
              add()
            }}
            className="h-7 w-[11rem] text-xs"
          />
          <Button variant="secondary" size="sm" onClick={add} disabled={!clean(text)} className="h-7">
            <Plus className="h-3.5 w-3.5" />
            {t('添加')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button type="button" className="cursor-pointer text-accent hover:underline" onClick={preset}>
            {t('填入 UE 排除清单')}
          </button>
          {list.length > 0 && (
            <button
              type="button"
              className="cursor-pointer text-subtle hover:text-fg hover:underline"
              onClick={() => onChange([])}
            >
              {t('清空')}
            </button>
          )}
        </div>
        <span className="text-xs text-subtle">
          {t('此外始终跳过：{list}', { list: DEFAULT_SEARCH_EXCLUDE.join(t('、')) })}
        </span>
      </div>
    </ParamRow>
  )
}

export function NavItem({
  on,
  onClick,
  dot,
  hint,
  children,
}: {
  on: boolean
  onClick: () => void
  /** 有没保存的改动 */
  dot?: boolean
  /** 右边的小字：用的是哪个文件 */
  hint?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on ? 'page' : undefined}
      className={cn(
        'flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[0.84375rem] whitespace-nowrap transition-colors',
        on ? 'bg-sel font-medium text-fg' : 'text-muted hover:bg-sel/70 hover:text-fg',
      )}
    >
      {children}
      {hint && (
        <span className="ml-auto hidden truncate font-mono text-[0.65625rem] font-normal text-subtle md:inline">
          {hint}
        </span>
      )}
      {dot && (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-accent', !hint && 'ml-auto')}
          title={t('有未保存的改动')}
        />
      )}
    </button>
  )
}
