import { useState } from 'react'
import { toast } from 'sonner'
import { ChevronRight, FolderGit2, FolderPlus, Plus } from 'lucide-react'
import type { Project, ProjectInput } from '@shared/schema'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { GroupHeader, ListEmpty, ListGroup, ListItem, ListPane } from '@/components/layout/ListPane'
import { DetailEmpty } from '@/components/layout/Detail'
import { ProjectWorkspace } from '@/components/tasks/ProjectWorkspace'
import { ProjectCategoryDetail } from '@/components/projects/ProjectCategoryDetail'

export function ProjectsPage() {
  const { loading, projects, projectCategories, workflows, setProjects, setProjectCategories } = useData()
  const { route, go } = useNav()
  const [query, setQuery] = useState('')

  const catId = route.id?.startsWith('cat:') ? route.id.slice(4) : null
  const selectedCategory = catId ? projectCategories.find((c) => c.id === catId) : undefined
  const selected = selectedCategory ? undefined : projects.find((p) => p.id === route.id)

  const q = query.trim().toLowerCase()
  const match = (p: Project) => !q || `${p.name}${p.description}${p.path}`.toLowerCase().includes(q)
  const groups = [...projectCategories.map((c) => ({ category: c, id: c.id })), { category: null, id: '' }]
    .map((g) => ({ ...g, items: projects.filter((p) => p.categoryId === g.id && match(p)) }))
    .filter((g) => g.items.length || (!q && g.category))

  const effectiveWorkflow = (p: Project) =>
    workflows.find((w) => w.id === (p.workflowId || projectCategories.find((c) => c.id === p.categoryId)?.workflowId))

  const create = async (input: Partial<ProjectInput> = {}) => {
    try {
      const p = await api.createProject({
        name: '新项目',
        description: '',
        path: '',
        categoryId: catId ?? '',
        workflowId: '',
        ...input,
      })
      setProjects((ps) => [...ps, p])
      setQuery('')
      go({ page: 'projects', id: p.id, sub: 'settings' })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const createCategory = async () => {
    const base = '新分类'
    let name = base
    for (let i = 2; projectCategories.some((c) => c.name === name); i++) name = `${base} ${i}`
    try {
      const c = await api.createProjectCategory({ name, description: '', workflowId: '' })
      setProjectCategories((cs) => [...cs, c])
      go({ page: 'projects', id: `cat:${c.id}` })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const duplicate = (p: Project) => {
    const { id, createdAt, updatedAt, ...rest } = p
    create({ ...rest, name: `${p.name} 副本` })
  }

  // 点进项目后整个页面换成项目工作区（任务列表 + 任务对话）
  if (selected)
    return (
      <ProjectWorkspace key={selected.id} project={selected} sub={route.sub} onDuplicate={() => duplicate(selected)} />
    )

  return (
    <>
      <ListPane
        title="项目"
        count={projects.length}
        onNew={() => create()}
        query={query}
        onQuery={setQuery}
        placeholder="搜索名称、简介或目录"
        footer={
          <button
            onClick={createCategory}
            className="flex w-full cursor-pointer items-center gap-2 text-[13px] text-muted hover:text-accent"
          >
            <FolderPlus className="h-4 w-4" />
            新建项目分类
          </button>
        }
      >
        {groups.map((g) => (
          <ListGroup
            key={g.id || 'none'}
            header={
              g.category ? (
                <div className="flex h-9 items-center gap-1 pt-2 pr-1">
                  <button
                    onClick={() => go({ page: 'projects', id: `cat:${g.id}` })}
                    aria-current={catId === g.id || undefined}
                    title="查看分类设置"
                    className={cn(
                      'flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-sel hover:text-fg',
                      catId === g.id ? 'bg-sel text-fg' : 'text-subtle',
                    )}
                  >
                    <span className="truncate">{g.category.name}</span>
                    <span className="shrink-0">· {g.items.length}</span>
                    <span className="truncate pl-1 text-subtle">
                      {workflows.find((w) => w.id === g.category!.workflowId)?.name ?? '未指定工作流'}
                    </span>
                    <ChevronRight className="h-3 w-3 shrink-0" />
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="在此分类新建项目"
                    title="在此分类新建项目"
                    className="ml-auto opacity-0 [@media(hover:none)]:opacity-100 group-hover/g:opacity-100 focus:opacity-100"
                    onClick={() => create({ categoryId: g.id })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <GroupHeader label="未分类" count={g.items.length} />
              )
            }
          >
            {g.items.map((p) => (
              <ListItem
                key={p.id}
                selected={false}
                onClick={() => go({ page: 'projects', id: p.id })}
                leading={
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-[#3b6fd8] text-white">
                    <FolderGit2 className="h-[18px] w-[18px]" strokeWidth={1.8} />
                  </span>
                }
                title={p.name}
                subtitle={p.path || '未选择目录'}
                trailing={
                  <span className="max-w-24 shrink-0 truncate text-xs text-subtle">
                    {effectiveWorkflow(p)?.name ?? '无工作流'}
                  </span>
                }
              />
            ))}
            {g.items.length === 0 && <p className="px-2.5 pb-1 text-xs text-subtle">这个分类还没有项目</p>}
          </ListGroup>
        ))}
        {!loading && projects.length > 0 && groups.length === 0 && <ListEmpty>没有匹配的项目</ListEmpty>}
      </ListPane>

      {selectedCategory ? (
        <ProjectCategoryDetail
          key={selectedCategory.id}
          category={selectedCategory}
          onNewProject={() => create({ categoryId: selectedCategory.id })}
        />
      ) : projects.length > 0 ? (
        <DetailEmpty desktopOnly icon={<FolderGit2 className="h-6 w-6" />} title="选择一个项目">
          <p>
            点开项目可以查看它的任务，或者新建任务让 Agent 按工作流执行。项目的目录和工作流在项目里的「设置」中修改。
          </p>
        </DetailEmpty>
      ) : (
        !loading && (
          <DetailEmpty icon={<FolderGit2 className="h-6 w-6" />} title="添加第一个项目">
            <p>
              项目是本机上的一个目录。给项目选一个分类，分类指定默认工作流，之后就可以在项目里描述任务，让 Agent
              按工作流执行。
            </p>
            <Button className="mt-5" onClick={() => create()}>
              <Plus className="h-4 w-4" />
              新建项目
            </Button>
          </DetailEmpty>
        )
      )}
    </>
  )
}
