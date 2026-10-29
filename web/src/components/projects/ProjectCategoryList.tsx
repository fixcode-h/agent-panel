import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Layers, Plus, Trash2 } from 'lucide-react'
import type { ProjectCategory, ProjectCategoryInput } from '@shared/schema'
import { isBuiltinProjectCategory } from '@shared/builtin/project-categories'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { useAutosave } from '@/lib/useAutosave'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { WorkflowPicker } from '@/components/workflows/WorkflowPicker'
import { t } from '@shared/i18n'

const toInput = ({ id, createdAt, updatedAt, builtin: _b, ...rest }: ProjectCategory): ProjectCategoryInput => rest

/** 设置里的「项目分类」：分类决定项目默认用哪个工作流，改动自动保存 */
export function ProjectCategoryList() {
  const { projectCategories, setProjectCategories } = useData()
  const create = async () => {
    const base = t('新分类')
    let name = base
    for (let i = 2; projectCategories.some((c) => c.name === name); i++) name = `${base} ${i}`
    try {
      const c = await api.createProjectCategory({ name, description: '', workflowId: '' })
      setProjectCategories((cs) => [...cs, c])
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t('项目选了分类后默认使用分类的工作流；项目也可以在项目设置里单独指定。')}
      </p>
      {/* 内置分类按固定 id 认，改名不影响；说清楚为什么没有删除按钮 */}
      <p className="text-xs leading-relaxed text-subtle">{t('带「内置」标记的分类可以改名，不能删除。')}</p>
      {projectCategories.length === 0 && <EmptyPanel size="square">{t('还没有项目分类。')}</EmptyPanel>}
      {projectCategories.map((c) => (
        <CategoryRow key={c.id} category={c} />
      ))}
      <div>
        <Button variant="secondary" size="sm" onClick={create}>
          <Plus className="h-3.5 w-3.5" />
          {t('新建分类')}
        </Button>
      </div>
    </div>
  )
}

function CategoryRow({ category }: { category: ProjectCategory }) {
  const { projects, setProjectCategories, setProjects } = useData()
  const builtin = isBuiltinProjectCategory(category.id)
  const [draft, setDraft] = useState<ProjectCategoryInput>(() => toInput(category))
  const [deleting, setDeleting] = useState(false)
  const valid = !!draft.name.trim()
  useAutosave(
    draft,
    async (v) => {
      const saved = await api.updateProjectCategory(category.id, v)
      setProjectCategories((cs) => cs.map((c) => (c.id === saved.id ? saved : c)))
    },
    valid,
  )
  const set = <K extends keyof ProjectCategoryInput>(k: K, v: ProjectCategoryInput[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))
  const members = projects.filter((p) => p.categoryId === category.id).length

  const remove = async () => {
    try {
      await api.deleteProjectCategory(category.id)
      setProjectCategories((cs) => cs.filter((c) => c.id !== category.id))
      setProjects((ps) => ps.map((p) => (p.categoryId === category.id ? { ...p, categoryId: '' } : p)))
      toast.success(t('已删除分类「{name}」', { name: category.name }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-card shadow-card p-4">
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 shrink-0 text-subtle" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">{draft.name || t('未命名分类')}</span>
        {builtin && (
          <span
            className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] text-accent-text"
            title={t('内置分类不能删除')}
          >
            {t('内置')}
          </span>
        )}
        <span className="shrink-0 text-xs text-subtle">{t('{n} 个项目', { n: members })}</span>
        {!builtin && (
          <IconButton
            icon={Trash2}
            size="sm"
            label={t('删除分类「{name}」', { name: category.name })}
            title={t('删除分类')}
            tone="danger"
            onClick={() => setDeleting(true)}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={t('名称')} className="flex-[1_1_160px]" error={valid ? undefined : t('名称不能为空')}>
          <Input className="h-9" value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label={t('简介')} className="flex-[2_1_220px]">
          <Input
            className="h-9"
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={t('哪类项目归到这里')}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">{t('默认工作流')}</span>
        <WorkflowPicker value={draft.workflowId} onChange={(id) => set('workflowId', id)} emptyLabel={t('不指定')} />
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除分类「{name}」？', { name: category.name })}
        description={t('分类里的项目不会被删除，会变成未分类。')}
        onConfirm={remove}
      />
    </section>
  )
}
