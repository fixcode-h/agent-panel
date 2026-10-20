import { CliSkills } from '@/components/settings/CliSkills'
import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { FileText, Loader2, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import type { Project, ProjectInput, WorkflowExpose } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { projectChecks } from '@/lib/readiness'
import { Button } from '@/components/ui/button'
import { CategoryPicker } from '@/components/ui/category-picker'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input, Select } from '@/components/ui/input'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { WorkflowPicker } from '@/components/workflows/WorkflowPicker'
import { DirPicker, useDirInfo } from './DirPicker'
import { t } from '@shared/i18n'
import { CLIS } from '@shared/clis'
import { GENERAL_NAME, UE_PROJECT_NAME } from '@shared/builtin/workflows'
import { cliDocs, SHARED_DOC, type DocFile, type ProjectDocs } from '@shared/docs'
import { cliSettings, orderClis } from '@shared/settings'
import { cliColor } from '@/lib/cli-style'
import { cn } from '@/lib/utils'
import { DocPage } from './ProjectDocs'

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
  workflowParams: {},
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
  const { go, route, openSettings } = useNav()
  const [draft, setDraft] = useState<ProjectInput>(() => (project ? toInput(project) : blank))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [signals, setSignals] = useState<string[]>([])
  const valid = !!draft.name.trim() && !!draft.workflowId
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
  const checks = projectChecks(draft, dir, own ?? inherited ?? general, agents, clis)
  const { settings } = useData()

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
        ...(wf ? { workflowId: wf.id } : {}),
        workflowParams: { ...d.workflowParams, ...r.workflowParams },
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
        {section !== 'general' ? (
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
            <div className="flex min-w-0 flex-1 flex-col gap-7">
              <FormSection title={t('基本信息')}>
                <div className="flex flex-wrap gap-4">
                  <Field label={t('名称')} className="flex-[1_1_200px]" error={valid ? undefined : t('名称不能为空')}>
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

              <FormSection title={t('工作流')}>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted">{t('这个项目的对话按哪套流程走（必选）')}</span>
                  <WorkflowPicker
                    value={draft.workflowId}
                    onChange={(id) => set('workflowId', id)}
                    emptyLabel={
                      inherited
                        ? t('使用分类默认：{name}', { name: inherited.name })
                        : general
                          ? t('未选择，将使用「{name}」', { name: general.name })
                          : t('请选择工作流')
                    }
                  />
                  <span className="text-xs text-subtle">
                    {own ? (
                      t('这个项目单独指定了工作流，不受分类默认的影响。')
                    ) : inherited ? (
                      <>
                        {t('跟随项目分类「{name}」的默认工作流，分类可以在', { name: category!.name })}
                        <button
                          type="button"
                          className="cursor-pointer text-accent hover:underline"
                          onClick={() => {
                            onClose()
                            openSettings('categories')
                          }}
                        >
                          {t('设置 · 项目分类')}
                        </button>
                        {t('中修改。')}
                      </>
                    ) : general ? (
                      t('没有单独指定时使用内置的「{name}」，它会一直跟着这个项目。', { name: general.name })
                    ) : (
                      t('项目没有分类，需要在这里单独指定工作流。')
                    )}
                  </span>
                  {active && active.expose.length > 0 && (
                    <div className="mt-3 flex flex-col gap-3 rounded-xl border bg-field/40 p-3">
                      <span className="text-xs text-muted">
                        {t('「{name}」的配置，改完保存后对新开的对话生效', { name: active.name })}
                      </span>
                      {active.expose.map((e) => (
                        <ExposeField
                          key={e.key}
                          e={e}
                          value={draft.workflowParams[e.key] as string | boolean | undefined}
                          onChange={(v) => set('workflowParams', { ...draft.workflowParams, [e.key]: v })}
                        />
                      ))}
                    </div>
                  )}
                </div>
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
            <aside className="flex shrink-0 flex-col gap-4 md:w-[260px]">
              <ReadinessCard checks={checks} />
            </aside>
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
    </>
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
