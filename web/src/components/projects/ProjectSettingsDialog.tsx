import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { FolderCog } from 'lucide-react'
import type { Project, ProjectInput } from '@shared/schema'
import { DEFAULT_FILE_FORMAT } from '@shared/schema'
import { derivedParams } from '@shared/agent-params'
import { AssistDialog } from '@/components/assist/LazyAssistDialog'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { projectChecks } from '@/lib/readiness'
import { Modal, ModalHeader } from '@/components/ui/modal'
import { dialogScrollClass } from '@/components/ui/dialog'
import type { Proposal } from '@shared/assist'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { useDirInfo } from './DirPicker'
import { t } from '@shared/i18n'
import { GENERAL_NAME } from '@shared/builtin/workflows'
import { cn } from '@/lib/utils'
import { ProjectInitPanel } from './ProjectInitPanel'
import {
  blank,
  folderName,
  toInput,
  type AiSession,
  type ApplyAi,
  type SetDraft,
  type Vcs,
} from './settings/project-draft'
import { useDirInit, useDirVcs, useDraftStash, useFreshLessons } from './settings/use-project-draft'
import { useProjectDocs } from './settings/use-project-docs'
import { useProjectInit } from './settings/use-project-init'
import { useProjectSave } from './settings/use-project-save'
import { useApplyAi } from './settings/use-apply-ai'
import { ProjectSettingsNav } from './settings/ProjectSettingsNav'
import { ProjectSettingsFooter } from './settings/ProjectSettingsFooter'
import { GeneralPage } from './settings/GeneralPage'
import { RolesPage } from './settings/RolesPage'
import { WorkflowsPage } from './settings/WorkflowsPage'
import { TestsPage } from './settings/TestsPage'
import { ExperiencePage, LessonsPage, TablesPage } from './settings/RecordPages'
import { DocsPane, McpPane, SkillsPane } from './settings/DocsPages'

const projectDialogTitle = (project?: Project) =>
  project ? t('项目设置 · {name}', { name: project.name }) : t('新建项目')

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
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={null}
        size="xl"
        bare
        className="h-[min(800px,calc(100dvh-3.75rem))] max-w-[1120px]"
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
      </Modal>
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
  const { projectCategories, setProjects, workflows, agents, clis, settings } = useData()
  const [draft, setDraft] = useState<ProjectInput>(() =>
    project
      ? toInput(project)
      : (stash.current ??
          // 新项目默认用协调 Agent；用户可以在下面改成「无」或别的 Agent
          { ...blank, defaultAgentId: agents.find((a) => a.origin === 'builtin:orchestrator')?.id ?? '' }),
  )
  // 「禁止子对话执行」、cherry-pick 目标和「文档根」都按目录的版本控制判断（见 useDirVcs）
  const vcs = useDirVcs(draft.path)
  // 新建项目时 AI 会话还在跑就关掉了：草稿留给下次打开
  const { created, keep } = useDraftStash({ project, ai, stash, draft })
  // 打开时把角色在对话里新记的教训补进草稿（见 useFreshLessons）
  useFreshLessons(project, setProjects, setDraft)
  const set = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => setDraft((d) => ({ ...d, [k]: v }))
  // 名称没填，或者名称就是原来的文件夹名时，换目录后名称跟着变成新的文件夹名；手动改过的名称不动
  const pickDir = (path: string) =>
    setDraft((d) => {
      const name = d.name.trim()
      const follow = !name || name === folderName(d.path) || (!project && name === t('新项目'))
      return { ...d, path, name: follow && folderName(path) ? folderName(path) : d.name }
    })
  const dir = useDirInfo(draft.path)
  const [dirInit, setDirInit] = useDirInit(dir, draft.initializedAt, setDraft)
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
  const checks = projectChecks(draft, dir, own ?? inherited ?? general, agents, clis)
  // 项目没单独设置时跟随全局的格式
  const globalFormat = settings?.fileFormat ?? DEFAULT_FILE_FORMAT

  // 左边的菜单：常规、通用的项目说明、各个 CLI 读的说明文件
  // 还没初始化的旧项目打开时先到「AI 初始化」：不初始化就不能保存
  const [section, setSection] = useState(initialSection || (project && !project.initializedAt ? 'init' : 'general'))
  const docs = useProjectDocs(project, draft.path)
  const initFlow = useProjectInit({
    project,
    draft,
    setDraft,
    workflows,
    initialSection,
    item,
    onAssist,
    deliver,
    setDirInit,
    setSection,
    setDocs: docs.setDocs,
  })
  const save = useProjectSave({
    project,
    draft,
    setDraft,
    valid,
    init: initFlow.init,
    inherited,
    general,
    changedDocs: docs.changedDocs,
    created,
    keep,
    stash,
    onCreated,
    onClose,
  })
  useApplyAi({
    ai,
    activeId: active?.id,
    workflows,
    agents,
    setDraft,
    set,
    acceptInit: initFlow.acceptInit,
    applyRef,
    queued,
  })

  return (
    <>
      <ModalHeader icon={FolderCog} title={projectDialogTitle(project)} />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ProjectSettingsNav section={section} onSection={setSection} project={project} draft={draft} docs={docs} />
        {section === 'mcp' ? (
          <McpPane project={project} draftPath={draft.path} />
        ) : section === 'skills' ? (
          <SkillsPane project={project} draftPath={draft.path} />
        ) : section === 'doc' || section.startsWith('cli:') ? (
          <DocsPane section={section} project={project} draft={draft} set={set} docs={docs} />
        ) : (
          <form
            id="project-settings"
            onSubmit={(e) => {
              e.preventDefault()
              void save.confirm()
            }}
            className={cn(dialogScrollClass, 'gap-7 md:flex-row')}
          >
            {section === 'init' ? (
              <ProjectInitPanel
                draft={draft}
                setDraft={setDraft}
                result={initFlow.init}
                workflows={workflows}
                activeId={active?.id ?? ''}
                fallbackId={initFlow.initFallbackId}
                fromDir={dirInit}
                globalFormat={globalFormat}
                canStart={!!draft.path.trim()}
                starting={initFlow.analyzing || ai?.kind === 'project'}
                signals={initFlow.signals}
                onStart={() => void initFlow.startInit()}
              />
            ) : (
              <FormPage
                section={section}
                project={project}
                item={item}
                draft={draft}
                setDraft={setDraft}
                set={set}
                vcs={vcs}
                wf={{ own, inherited, general, active }}
                onAssist={onAssist}
                general={{
                  pickDir,
                  dir,
                  globalFormat,
                  analyzing: initFlow.analyzing,
                  onStartInit: () => void initFlow.startInit(),
                }}
              />
            )}
            {section === 'general' && (
              <aside className="flex shrink-0 flex-col gap-4 md:w-[260px]">
                <ReadinessCard checks={checks} />
              </aside>
            )}
          </form>
        )}
      </div>

      <ProjectSettingsFooter
        project={project}
        save={save}
        valid={valid}
        initialized={!!draft.initializedAt}
        hasWorkflow={!!active}
        changedDocs={docs.changedDocs.length}
        onSection={setSection}
        onClose={onClose}
      />
    </>
  )
}

/** 表单里的各页（「AI 初始化」除外）：每页只拿自己那几项草稿和要用的东西 */
function FormPage({
  section,
  project,
  item,
  draft,
  setDraft,
  set,
  vcs,
  wf,
  onAssist,
  general,
}: {
  section: string
  project?: Project
  item?: string
  draft: ProjectInput
  setDraft: SetDraft
  set: <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => void
  vcs: Vcs
  /** 默认工作流的几种来源（见 Body） */
  wf: Pick<Parameters<typeof WorkflowsPage>[0], 'own' | 'inherited' | 'general' | 'active'>
  onAssist: (s: AiSession) => void
  /** 只有「常规」页用的 */
  general: Pick<Parameters<typeof GeneralPage>[0], 'pickDir' | 'dir' | 'globalFormat' | 'analyzing' | 'onStartInit'>
}) {
  if (section === 'roles') return <RolesPage project={project} draft={draft} setDraft={setDraft} vcs={vcs} />
  if (section === 'workflows')
    return <WorkflowsPage draft={draft} setDraft={setDraft} set={set} vcs={vcs} {...wf} onAssist={onAssist} />
  if (section === 'tables') return <TablesPage project={project} draft={draft} set={set} dir={general.dir} />
  if (section === 'lessons') return <LessonsPage project={project} draft={draft} set={set} item={item} />
  if (section === 'experience' && project) return <ExperiencePage project={project} item={item} />
  if (section === 'tests') return <TestsPage draft={draft} set={set} gitRepo={vcs === 'git'} onAssist={onAssist} />
  return <GeneralPage project={project} draft={draft} set={set} vcs={vcs} {...general} />
}
