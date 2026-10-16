import { useState } from 'react'
import { toast } from 'sonner'
import { FolderGit2, Layers, Plus, Trash2 } from 'lucide-react'
import type { ProjectCategory, ProjectCategoryInput } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { useAutosave } from '@/lib/useAutosave'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, FormSection, Input } from '@/components/ui/input'
import { Detail, DetailHeader } from '@/components/layout/Detail'
import { WorkflowPicker } from '@/components/workflows/WorkflowPicker'
import { WorkflowSummary } from '@/components/workflows/WorkflowSummary'

const toInput = ({ id, createdAt, updatedAt, ...rest }: ProjectCategory): ProjectCategoryInput => rest

export function ProjectCategoryDetail({
  category,
  onNewProject,
}: {
  category: ProjectCategory
  onNewProject: () => void
}) {
  const { projects, workflows, setProjectCategories, setProjects } = useData()
  const { go } = useNav()
  const [draft, setDraft] = useState<ProjectCategoryInput>(() => toInput(category))
  const [deleting, setDeleting] = useState(false)
  const valid = !!draft.name.trim()
  const save = useAutosave(
    draft,
    async (v) => {
      const saved = await api.updateProjectCategory(category.id, v)
      setProjectCategories((cs) => cs.map((c) => (c.id === saved.id ? saved : c)))
    },
    valid,
  )
  const set = <K extends keyof ProjectCategoryInput>(k: K, v: ProjectCategoryInput[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))
  const members = projects.filter((p) => p.categoryId === category.id)
  const workflow = workflows.find((w) => w.id === draft.workflowId)

  const remove = async () => {
    try {
      await api.deleteProjectCategory(category.id)
      setProjectCategories((cs) => cs.filter((c) => c.id !== category.id))
      setProjects((ps) => ps.map((p) => (p.categoryId === category.id ? { ...p, categoryId: '' } : p)))
      toast.success(`已删除分类「${category.name}」`)
      go({ page: 'projects' })
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
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-line-strong bg-card text-muted">
                <Layers className="h-6 w-6" strokeWidth={1.8} />
              </span>
            }
            title={draft.name || '未命名分类'}
            meta={<span className="text-xs text-subtle">项目分类 · {members.length} 个项目</span>}
            subtitle={draft.description || '还没有简介'}
            save={{ ...save, invalid: valid ? undefined : '名称为空，未保存' }}
            actions={
              <Button
                variant="danger-outline"
                size="icon"
                aria-label="删除分类"
                title="删除分类"
                onClick={() => setDeleting(true)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            }
          />
        }
        form={
          <>
            <FormSection title="基本信息">
              <div className="flex flex-wrap gap-4">
                <Field label="名称" className="flex-[1_1_200px]" error={valid ? undefined : '名称不能为空'}>
                  <Input value={draft.name} onChange={(e) => set('name', e.target.value)} />
                </Field>
                <Field label="简介" className="flex-[2_1_280px]">
                  <Input
                    value={draft.description}
                    onChange={(e) => set('description', e.target.value)}
                    placeholder="哪类项目归到这里"
                  />
                </Field>
              </div>
            </FormSection>
            <FormSection title="默认工作流">
              <div className="flex flex-col gap-1.5">
                <WorkflowPicker value={draft.workflowId} onChange={(id) => set('workflowId', id)} emptyLabel="不指定" />
                <span className="text-xs text-subtle">这个分类下的项目默认使用它；项目也可以单独指定别的工作流。</span>
              </div>
            </FormSection>
            <FormSection
              title={`项目 · ${members.length}`}
              aside={
                <Button variant="secondary" size="sm" onClick={onNewProject}>
                  <Plus className="h-3.5 w-3.5" />
                  在此分类新建项目
                </Button>
              }
            >
              {members.length === 0 && <p className="text-[13px] text-subtle">这个分类下还没有项目。</p>}
              <div className="flex flex-col gap-2">
                {members.map((p) => {
                  const own = workflows.find((w) => w.id === p.workflowId)
                  return (
                    <button
                      key={p.id}
                      onClick={() => go({ page: 'projects', id: p.id })}
                      className="flex cursor-pointer items-center gap-3 rounded-[10px] border bg-card p-3 text-left hover:border-line-strong"
                    >
                      <FolderGit2 className="h-5 w-5 shrink-0 text-subtle" strokeWidth={1.8} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{p.name}</span>
                        <span className="truncate font-mono text-xs text-muted">{p.path || '未选择目录'}</span>
                      </span>
                      <span className="shrink-0 text-xs text-subtle">{own ? `单独指定：${own.name}` : '使用默认'}</span>
                    </button>
                  )
                })}
              </div>
            </FormSection>
          </>
        }
        aside={<WorkflowSummary workflow={workflow} source={workflow ? '分类默认' : undefined} />}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`删除分类「${category.name}」？`}
        description="分类里的项目不会被删除，会移到「未分类」。"
        onConfirm={remove}
      />
    </>
  )
}
