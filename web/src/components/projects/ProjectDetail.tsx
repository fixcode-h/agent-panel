import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, FolderGit2, Trash2 } from 'lucide-react'
import type { Project, ProjectInput } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { isReady, projectChecks } from '@/lib/readiness'
import { useAutosave } from '@/lib/useAutosave'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CategoryPicker } from '@/components/ui/category-picker'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input } from '@/components/ui/input'
import { Detail, DetailHeader } from '@/components/layout/Detail'
import { ReadinessCard } from '@/components/layout/ReadinessCard'
import { WorkflowPicker } from '@/components/workflows/WorkflowPicker'
import { WorkflowSummary } from '@/components/workflows/WorkflowSummary'
import { DirPicker, useDirInfo } from './DirPicker'

const toInput = ({ id, createdAt, updatedAt, ...rest }: Project): ProjectInput => rest

export function ProjectDetail({
  project,
  onDuplicate,
  onDeleted,
}: {
  project: Project
  onDuplicate: () => void
  onDeleted: () => void
}) {
  const { projectCategories, setProjectCategories, setProjects, workflows, agents, clis, reloadTasks } = useData()
  const { go } = useNav()
  const [draft, setDraft] = useState<ProjectInput>(() => toInput(project))
  const [deleting, setDeleting] = useState(false)
  const valid = !!draft.name.trim()
  const save = useAutosave(
    draft,
    async (v) => {
      const saved = await api.updateProject(project.id, v)
      setProjects((ps) => ps.map((p) => (p.id === saved.id ? saved : p)))
    },
    valid,
  )
  const set = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const dir = useDirInfo(draft.path)
  const category = projectCategories.find((c) => c.id === draft.categoryId)
  const inherited = workflows.find((w) => w.id === category?.workflowId)
  const own = workflows.find((w) => w.id === draft.workflowId)
  const workflow = own ?? inherited
  const checks = projectChecks(draft, dir, workflow, agents, clis)

  const remove = async () => {
    try {
      await api.deleteProject(project.id)
      setProjects((ps) => ps.filter((p) => p.id !== project.id))
      // 后端连同任务一起删了，侧栏的最近任务也要去掉
      void reloadTasks()
      toast.success(`已删除「${project.name}」`)
      onDeleted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Detail
        header={
          <DetailHeader
            leading={
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#3b6fd8] text-white">
                <FolderGit2 className="h-6 w-6" strokeWidth={1.8} />
              </span>
            }
            title={draft.name || '未命名项目'}
            meta={
              <>
                <Badge>{category?.name ?? '未分类'}</Badge>
                {isReady(checks) ? (
                  <StatusDot tone="success" label="就绪" />
                ) : (
                  <StatusDot tone="warning" label="未就绪" />
                )}
              </>
            }
            subtitle={draft.path || '还没有选择本地目录'}
            save={{ ...save, invalid: valid ? undefined : '名称为空，未保存' }}
            actions={
              <>
                <Button variant="secondary" size="icon" aria-label="复制" title="复制" onClick={onDuplicate}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="danger-outline"
                  size="icon"
                  aria-label="删除"
                  title="删除"
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            }
          />
        }
        form={
          <>
            <FormSection title="基本信息">
              <div className="flex flex-wrap gap-4">
                <Field label="名称" className="flex-[1_1_200px]" error={valid ? undefined : '名称不能为空'}>
                  <Input
                    value={draft.name}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder="例如：官网前端"
                  />
                </Field>
                <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
                  <span className="text-xs text-muted">项目分类</span>
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
              <Field label="简介">
                <Input
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="这个项目是做什么的"
                />
              </Field>
            </FormSection>

            <FormSection title="本地目录">
              <DirPicker value={draft.path} onChange={(p) => set('path', p)} info={dir} />
            </FormSection>

            <FormSection title="工作流">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">执行任务时使用的工作流</span>
                <WorkflowPicker
                  value={draft.workflowId}
                  onChange={(id) => set('workflowId', id)}
                  emptyLabel={inherited ? `使用分类默认：${inherited.name}` : '使用分类默认（分类还没有指定）'}
                />
                <span className="text-xs text-subtle">
                  {own ? (
                    '这个项目单独指定了工作流，不受分类默认的影响。'
                  ) : category ? (
                    <>
                      跟随项目分类「
                      <button
                        className="cursor-pointer text-accent hover:underline"
                        onClick={() => go({ page: 'projects', id: `cat:${category.id}` })}
                      >
                        {category.name}
                      </button>
                      」的默认工作流，修改分类后这里会一起变化。
                    </>
                  ) : (
                    '项目没有分类，需要在这里单独指定工作流。'
                  )}
                </span>
              </div>
            </FormSection>
          </>
        }
        aside={
          <>
            <ReadinessCard checks={checks} />
            <WorkflowSummary
              workflow={workflow}
              source={own ? '项目单独指定' : workflow ? '来自分类默认' : undefined}
            />
          </>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除「${project.name}」？`}
        description="只会删除面板里的配置，不会动本地目录里的文件。"
        onConfirm={remove}
      />
    </>
  )
}
