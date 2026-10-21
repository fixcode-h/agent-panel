import { CliSkills } from '@/components/settings/CliSkills'
import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  FlaskConical,
  Loader2,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import type { Agent, ParamValue, Project, ProjectInput, TestStep, Workflow, WorkflowExpose } from '@shared/schema'
import { DEFAULT_FILE_FORMAT } from '@shared/schema'
import { derivedParams, agentParamGroups, type AgentParamGroup, type DerivedParam } from '@shared/agent-params'
import { ENV_LABEL, newTestStepId } from '@shared/test-steps'
import { AssistDialog } from '@/components/assist/AssistDialog'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { projectChecks } from '@/lib/readiness'
import { Button } from '@/components/ui/button'
import { CategoryPicker } from '@/components/ui/category-picker'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input, Select } from '@/components/ui/input'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { DirPicker, useDirInfo } from './DirPicker'
import { t } from '@shared/i18n'
import { CLIS } from '@shared/clis'
import { GENERAL_NAME, UE_PROJECT_NAME } from '@shared/builtin/workflows'
import { cliDocs, SHARED_DOC, type DocFile, type ProjectDocs } from '@shared/docs'
import { cliSettings, orderClis } from '@shared/settings'
import { cliColor } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { DocPage } from './ProjectDocs'
import { Segmented } from '@/components/ui/segmented'
import { CORE_AGENTS, coreKey, coreUse, findCore } from '@shared/builtin/core'
import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { ParamsForm } from '@/components/agents/ParamFields'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'

/** 默认工作流从这个工作流分类里选（内置的「通用项目」「UE 项目」都在这里） */
const PROJECT_WF_CATEGORY = '项目'

const toInput = ({ id, createdAt, updatedAt, ...rest }: Project): ProjectInput => rest
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
  testSteps: [],
  wslDistro: '',
  fileFormat: undefined,
  gitPolicy: 'ask',
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
  onOpenChange,
}: {
  open: boolean
  project?: Project
  onOpenChange: (open: boolean) => void
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/45 animate-[fade-in_150ms_ease-out]" />
        <D.Content
          aria-describedby={undefined}
          // 改到一半点到外面不关闭，免得白填
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] h-[min(800px,calc(100dvh-2rem))] w-[min(1120px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
        >
          {open && <Body key={project?.id ?? 'new'} project={project} onClose={() => onOpenChange(false)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

function Body({ project, onClose }: { project?: Project; onClose: () => void }) {
  const { projectCategories, setProjectCategories, setProjects, workflows, agents, clis, reloadTasks } = useData()
  const { go, route } = useNav()
  const [draft, setDraft] = useState<ProjectInput>(() =>
    project
      ? toInput(project)
      : // 新项目默认用协调 Agent；用户可以在下面改成「无」或别的 Agent
        { ...blank, defaultAgentId: agents.find((a) => a.origin === 'builtin:orchestrator')?.id ?? '' },
  )
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [signals, setSignals] = useState<string[]>([])
  // 没单独选工作流时跟随分类的默认工作流，同样算选好了（服务端也是这么解析的）
  const valid =
    !!draft.name.trim() && !!(draft.workflowId || projectCategories.find((c) => c.id === draft.categoryId)?.workflowId)
  const set = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => setDraft((d) => ({ ...d, [k]: v }))
  // 名称没填，或者名称就是原来的文件夹名时，换目录后名称跟着变成新的文件夹名；手动改过的名称不动
  const pickDir = (path: string) =>
    setDraft((d) => {
      const name = d.name.trim()
      const follow = !name || name === folderName(d.path) || (!project && name === t('新项目'))
      return { ...d, path, name: follow && folderName(path) ? folderName(path) : d.name }
    })
  const dir = useDirInfo(draft.path)
  const category = projectCategories.find((c) => c.id === draft.categoryId)
  const inherited = workflows.find((w) => w.id === category?.workflowId)
  const own = workflows.find((w) => w.id === draft.workflowId)
  // 没有单独指定时落到「通用项目」（服务端也是这么解析的），表单上显示实际会用的那个
  const general =
    workflows.find((w) => w.origin === 'builtin:project-general') ?? workflows.find((w) => w.name === GENERAL_NAME)
  const active = own ?? inherited ?? general
  // 每个工作流一份配置：默认工作流和每个可选工作流各自保存
  const paramsOf = (id: string) => draft.workflowParams[id] ?? {}
  const setParam = (id: string, key: string, value: string | boolean) =>
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
  const coreAgents = CORE_AGENTS.map((c) => findCore(agents, c.key)).filter((a): a is Agent => !!a)
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
    setAi({
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
            value={paramsOf(w.id)[e.key] as string | boolean | undefined}
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
  const [ai, setAi] = useState<{
    kind: 'params' | 'teststeps'
    workflowId?: string
    agentId?: string
    title: string
    /** 打开就直接发给 CLI 的要求：点「AI 配置」不用再自己写一遍 */
    start?: string
  } | null>(null)

  // 项目的「AI 分析」：读本地目录给出名称、简介、工作流和配置项，填进表单；用户确认后才保存
  const analyze = async () => {
    if (!draft.path.trim() || analyzing) return
    setAnalyzing(true)
    try {
      const r = await api.analyzeProject(draft.path)
      setSignals(r.signals)
      const want = r.workflow === 'ue' ? UE_PROJECT_NAME : GENERAL_NAME
      const wf =
        workflows.find((w) => w.origin === `builtin:project-${r.workflow}`) ?? workflows.find((w) => w.name === want)
      setDraft((d) => ({
        ...d,
        name: d.name.trim() || r.name,
        description: r.description || d.description,
        // 已经填过步骤的不覆盖：用户可能自己调过
        ...(r.testSteps.length && !d.testSteps.length ? { testSteps: r.testSteps } : {}),
        ...(r.wslDistro && !d.wslDistro ? { wslDistro: r.wslDistro } : {}),
        ...(wf
          ? {
              workflowId: wf.id,
              workflowParams: {
                ...d.workflowParams,
                [wf.id]: { ...(d.workflowParams[wf.id] ?? {}), ...r.workflowParams },
              },
            }
          : {}),
      }))
      toast.success(
        wf
          ? t('已按本地目录填好，检查一下再保存')
          : t('已填好，但没找到内置工作流「{name}」，请手动选择', { name: want }),
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }

  // 左边的菜单：常规、通用的项目说明、各个 CLI 读的说明文件
  const [section, setSection] = useState('general')
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
    if (!valid || saving) return
    setSaving(true)
    try {
      const input = { ...draft, name: draft.name.trim() }
      if (project) {
        // 说明文件先存：写到项目目录里，失败时项目设置也不算保存成功，改动还留在弹窗里
        for (const [f, c] of changedDocs) await api.saveProjectDoc(project.id, f, c)
        const saved = await api.updateProject(project.id, input)
        setProjects((ps) => ps.map((p) => (p.id === saved.id ? saved : p)))
        toast.success(t('项目设置已保存'))
      } else {
        const p = await api.createProject(input)
        setProjects((ps) => [...ps, p])
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
            on={section === 'doc'}
            onClick={() => setSection('doc')}
            dot={isChanged([SHARED_DOC, 'AGENT.md'])}
            hint={hasDoc([SHARED_DOC]) ? SHARED_DOC : undefined}
          >
            <FileText className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {t('项目说明')}
          </NavItem>
          <span className="hidden px-2.5 pt-4 pb-1 text-[0.6875rem] text-subtle md:block">
            {t('各个 CLI 读的说明')}
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
        {section === 'doc' || section.startsWith('cli:') ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
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
                        {t('检测到 AGENT.md，但各个 CLI 只读 AGENTS.md（多一个 s），现在这个文件不会被读到。')}
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
            className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 py-6 md:flex-row"
          >
            {section === 'roles' ? (
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <PageIntro
                  title={t('必备角色')}
                  desc={t(
                    '项目对话靠这四个角色运转：统筹分派、执行做事、文档落盘、测试验收。角色本身不能换，这里改的参数只对这个项目生效，没改的跟随角色页里的默认值。',
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
                  <span className="text-xs text-muted">{t('默认工作流')}</span>
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
                  <span className="text-xs text-subtle">
                    {t('只能从「{cat}」分类里选：这类工作流是为项目常驻流程设计的。', { cat: PROJECT_WF_CATEGORY })}
                  </span>
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
            ) : section === 'tests' ? (
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <PageIntro
                  title={t('测试步骤')}
                  desc={t(
                    '测试验收角色按这里的顺序执行，新建对话时快照进任务。写清楚命令、在哪执行和什么时候跑，没有配置时它会自己找命令并提醒你补上。',
                  )}
                />
                <TestStepsEditor
                  steps={draft.testSteps}
                  distro={draft.wslDistro}
                  onChange={(v) => set('testSteps', v)}
                  onDistro={(v) => set('wslDistro', v)}
                  aiRunning={false}
                  onAi={() =>
                    setAi({
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
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void analyze()}
                      disabled={!draft.path.trim() || analyzing}
                    >
                      {analyzing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {t('AI 分析这个目录')}
                    </Button>
                    <span className="text-xs text-subtle">
                      {t('只读扫描，按文件判断技术栈、构建和测试命令，填进下面的表单')}
                    </span>
                  </div>
                  {signals.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
                      {signals.map((s) => (
                        <li key={s}>· {s}</li>
                      ))}
                    </ul>
                  )}
                </FormSection>

                <FormSection title={t('文件格式')}>
                  <div className="flex flex-wrap gap-3">
                    <Field label={t('编码')} className="flex-[1_1_200px]">
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
                    {t(
                      '这个项目里新建和改写的文本文件用它，Agent 写文件时也按这个来。默认 UTF-8（不带 BOM）+ LF，在 WSL / Linux 里执行带 shebang 的脚本不会报 bad interpreter。',
                    )}
                    {!draft.fileFormat && (
                      <>
                        {' '}
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
                        {' '}
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

                <FormSection title={t('子对话')}>
                  <Field label={t('子对话隔离')}>
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
                  <span className="text-xs leading-relaxed text-subtle">
                    {draft.childIsolation === 'worktree'
                      ? t(
                          '每个子对话在自己的独立分支目录里改文件，互不干扰；编译不在里面跑，改完排队合回原来的目录，按测试步骤里勾了「合并时编译」的步骤编译，通过才提交，失败撤回并把报错交回子对话。不是 Git 仓库（P4 等）时自动用共用目录。',
                        )
                      : t(
                          '子对话都在项目目录里直接改，改文件前先认领，同一个文件同一时间只归一个子对话。不用建分支，但编译时可能读到别的子对话改到一半的文件。',
                        )}
                  </span>
                </FormSection>

                <FormSection title={t('版本与推送')}>
                  <Field label={t('推送到远端')}>
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
                  <span className="text-xs text-subtle">
                    {t('本地提交不受影响；推送、PR、P4 submit 这类对外操作按这里的设置和对话里的选择来。')}
                  </span>
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
        <Button onClick={() => void confirm()} disabled={!valid || saving}>
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

      {ai && (
        <AssistDialog
          open={!!ai}
          onOpenChange={(o) => !o && setAi(null)}
          kind={ai.kind}
          projectId={project?.id ?? ''}
          title={ai.title}
          autoStart={ai.start}
          paramAgentId={ai.agentId}
          paramSpec={
            ai.kind === 'params'
              ? (() => {
                  const wf = workflows.find((w) => w.id === (ai.workflowId || active?.id))
                  return wf ? derivedParams(wf, agents) : []
                })()
              : undefined
          }
          // params 时 target 是工作流：结果按它的 id 写进 workflowParams
          target={ai.kind === 'params' ? workflows.find((w) => w.id === (ai.workflowId || active?.id)) : undefined}
          onApply={(p) => {
            if (p.kind === 'params') {
              const id = ai.workflowId || p.workflowId || active?.id
              if (id)
                setDraft((d) => ({
                  ...d,
                  workflowParams: { ...d.workflowParams, [id]: { ...(d.workflowParams[id] ?? {}), ...p.values } },
                }))
              toast.success(t('已填进表单，确认保存后生效'))
            } else if (p.kind === 'teststeps') {
              set('testSteps', p.steps)
              toast.success(t('已填进表单，确认保存后生效'))
            }
          }}
        />
      )}
    </>
  )
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
  onChange,
  onDistro,
  onAi,
  aiRunning,
}: {
  steps: TestStep[]
  distro: string
  onChange: (v: TestStep[]) => void
  onDistro: (v: string) => void
  onAi: () => void
  aiRunning: boolean
}) {
  const patch = (i: number, p: Partial<TestStep>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...p } : s)))
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
            '测试 Agent 按这些步骤执行构建、测试和检查。新建对话时快照进任务，之后改这里不影响已经开始的对话；没配置时 Agent 会自己找命令并建议你补上。',
          )}
        </span>
        <Button size="sm" variant="secondary" onClick={onAi} disabled={aiRunning}>
          {aiRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('AI 生成步骤')}
        </Button>
      </div>
      {steps.length === 0 && (
        <p className="rounded-lg border border-dashed p-3 text-xs text-subtle">
          {t('还没有测试步骤。新建 Node 项目时「AI 分析这个目录」会按 scripts 填一份。')}
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
                aria-label={t('执行条件')}
                placeholder={t('执行条件，例如「仅改了 web/ 时」')}
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
                title={t('子对话在独立分支里改完提交编译时，合回原目录后跑这一步，通过才提交')}
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={s.merge}
                  onChange={(e) => patch(i, { merge: e.target.checked })}
                />
                {t('合并时编译')}
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
                timeoutSec: 0,
                note: '',
                enabled: true,
                merge: false,
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
  const mine = agents.filter((d) => d.agents.some((a) => a.id === group.agentId) && !hidden.has(d.key))
  if (!mine.length) return null
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-field/40 p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-[0.8125rem] font-medium">{group.agentName}</span>
        <span className="text-xs text-subtle">{t('{n} 个参数', { n: mine.length })}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onAi} disabled={aiRunning}>
          {aiRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {t('AI 配置')}
        </Button>
      </div>
      {mine.map((d) => (
        <DerivedParamField key={d.key} d={d} value={values[d.key]} onChange={(v) => onChange(d.key, v)} />
      ))}
    </div>
  )
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
  const fallback = Array.isArray(d.defaultValue) ? d.defaultValue.join(', ') : (d.defaultValue ?? '')
  const shared = d.agents.length > 1
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {label}
        <span className="font-mono text-[0.6875rem] text-subtle">{d.key}</span>
        {d.required && <span className="text-[0.6875rem] text-warning">{t('必须填')}</span>}
        {shared && (
          <span className="text-[0.6875rem] text-subtle">
            {t('同时影响 {names}', { names: [...new Set(d.agents.map((a) => a.name))].join(t('、')) })}
          </span>
        )}
      </span>
      {d.type === 'select' ? (
        <Select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          options={[
            { value: '', label: fallback ? t('默认：{v}', { v: String(fallback) }) : t('未选择') },
            ...d.options.map((o) => ({ value: o, label: o })),
          ]}
        />
      ) : d.type === 'bool' ? (
        <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem]">
          <input
            type="checkbox"
            className="accent-accent"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {value === true ? t('是') : t('否')}
          {d.defaultValue !== undefined && (
            <span className="text-xs text-subtle">{t('默认：{v}', { v: d.defaultValue ? t('是') : t('否') })}</span>
          )}
        </label>
      ) : (
        <Input
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fallback ? t('默认：{v}', { v: String(fallback) }) : ''}
        />
      )}
      {d.description && <span className="text-xs text-subtle">{d.description}</span>}
    </div>
  )
}

/** 工作流暴露的一项配置：按类型渲染成下拉、多选、开关或文本框 */
function ExposeField({
  e,
  value,
  onChange,
}: {
  e: WorkflowExpose
  value: string | boolean | undefined
  onChange: (v: string | boolean) => void
}) {
  const label = e.label || e.key
  const text = typeof value === 'boolean' ? String(value) : Array.isArray(value) ? value.join(', ') : (value ?? '')
  const fallback = Array.isArray(e.default) ? e.default.join(', ') : (e.default ?? '')
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {e.type === 'select' ? (
        <Select
          value={text}
          onChange={(ev) => onChange(ev.target.value)}
          options={[
            ...(text || fallback ? [] : [{ value: '', label: t('未选择') }]),
            ...e.options.map((o) => ({ value: o, label: o })),
          ]}
        />
      ) : e.type === 'bool' ? (
        <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem]">
          <input
            type="checkbox"
            className="accent-accent"
            checked={value === true || value === 'true'}
            onChange={(ev) => onChange(ev.target.checked ? 'true' : 'false')}
          />
          {text === 'true' || value === true ? t('是') : t('否')}
        </label>
      ) : (
        <Input
          value={text}
          onChange={(ev) => onChange(ev.target.value)}
          placeholder={fallback ? t('默认：{v}', { v: String(fallback) }) : ''}
        />
      )}
      {e.description && <span className="text-xs text-subtle">{e.description}</span>}
    </div>
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
