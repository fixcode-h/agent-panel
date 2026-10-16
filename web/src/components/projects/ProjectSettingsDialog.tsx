import { useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { toast } from 'sonner'
import { Loader2, Trash2, X } from 'lucide-react'
import type { Project, ProjectInput } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { projectChecks } from '@/lib/readiness'
import { Button } from '@/components/ui/button'
import { CategoryPicker } from '@/components/ui/category-picker'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input } from '@/components/ui/input'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { WorkflowPicker } from '@/components/workflows/WorkflowPicker'
import { DirPicker, useDirInfo } from './DirPicker'
import { t } from '@shared/i18n'

const toInput = ({ id, createdAt, updatedAt, ...rest }: Project): ProjectInput => rest
const folderName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? ''
const blank: ProjectInput = { name: '', description: '', path: '', categoryId: '', workflowId: '' }

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
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(820px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line-strong bg-card shadow-pop animate-[pop-in_160ms_ease-out] focus:outline-none"
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
  const valid = !!draft.name.trim()
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
  const checks = projectChecks(draft, dir, own ?? inherited, agents, clis)

  const confirm = async () => {
    if (!valid || saving) return
    setSaving(true)
    try {
      const input = { ...draft, name: draft.name.trim() }
      if (project) {
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
        <D.Title className="min-w-0 flex-1 truncate font-serif text-[18px] font-semibold">
          {project ? t('项目设置 · {name}', { name: project.name }) : t('新建项目')}
        </D.Title>
        <DialogCloseButton />
      </header>

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
          </FormSection>

          <FormSection title={t('工作流')}>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">{t('执行任务时使用的工作流')}</span>
              <WorkflowPicker
                value={draft.workflowId}
                onChange={(id) => set('workflowId', id)}
                emptyLabel={
                  inherited ? t('使用分类默认：{name}', { name: inherited.name }) : t('使用分类默认（分类还没有指定）')
                }
              />
              <span className="text-xs text-subtle">
                {own ? (
                  t('这个项目单独指定了工作流，不受分类默认的影响。')
                ) : category ? (
                  <>
                    {t('跟随项目分类「{name}」的默认工作流，分类可以在', { name: category.name })}
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
                ) : (
                  t('项目没有分类，需要在这里单独指定工作流。')
                )}
              </span>
            </div>
          </FormSection>
        </div>
        <aside className="flex shrink-0 flex-col gap-4 md:w-[260px]">
          <ReadinessCard checks={checks} />
        </aside>
      </form>

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
        <Button variant="secondary" className="ml-auto" onClick={onClose}>
          {t('取消')}
        </Button>
        <Button type="submit" form="project-settings" disabled={!valid || saving}>
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
