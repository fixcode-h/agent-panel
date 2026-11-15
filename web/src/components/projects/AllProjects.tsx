import { useState } from 'react'
import { FolderPlus, MoreHorizontal } from 'lucide-react'
import type { Project } from '@shared/schema'
import { t } from '@shared/i18n'
import { byAskedAt } from '@shared/task'
import { sortProjects } from '@shared/projects/order'
import { useData, useNav, useTasks } from '@/lib/data'
import { useLiveOf } from '@/lib/live/store'
import { pickCurrentProject } from '@/lib/projects/current'
import { moveItem, useDragSort } from '@/lib/useDragSort'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useOwnedByPlugin } from '@/plugins/registry'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { InlineRename } from '@/components/ui/inline-rename'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Segmented } from '@/components/ui/segmented'
import { ProjectCard } from '@/components/ui/project-card'
import { PageFrame } from '@/components/library/parts'
import { useProjectActions } from '@/components/layout/sidebar/project-actions'
import { EMPTY_STAT, projectStats } from '@/components/layout/sidebar/project-stats'
import { ProjectStatus } from '@/components/layout/sidebar/ProjectPicker'

/** 每张卡片下面列几个最近的对话 */
const RECENT = 3

/**
 * 「全部项目」页（#/projects，侧栏项目下拉底部进来）：项目卡片按分类筛选，点卡片切到那个项目。
 * 原来侧栏项目树上的拖动排序、右键菜单挪到这里（卡片左上角的手柄、右上角的更多菜单）
 */
export function AllProjects() {
  const { route, go, openProject, openSettings } = useNav()
  const { projects, setProjects, categories } = useData()
  const { tasks } = useTasks()
  const liveOf = useLiveOf()
  const owned = useOwnedByPlugin()
  const [cat, setCat] = useState('all')
  const recent = tasks
    .filter((x) => x.projectId && !x.parentTaskId && !x.flowRun?.owner && !owned(x) && !x.archived)
    .sort(byAskedAt)
  const stats = projectStats(recent, liveOf)
  const actions = useProjectActions(recent)
  const ordered = sortProjects(projects)
  const shown = cat === 'all' ? ordered : ordered.filter((p) => (p.categoryId || '') === cat)
  // 侧栏切换器上的那个项目：卡片上的文件夹图标换成项目蓝
  const current = pickCurrentProject(projects, route)?.id

  // 拖动排序：立刻生效，再写回服务端；失败时换回原来的顺序并提示。筛选分类时不能拖（下标对不上全量顺序）
  const saveOrder = async (next: Project[]) => {
    const before = projects
    setProjects(next)
    try {
      setProjects(await api.orderProjects(next.map((p) => p.id)))
    } catch (e) {
      setProjects(before)
      toast.error(t('保存项目顺序失败：{msg}', { msg: (e as Error).message }))
    }
  }
  const sort = useDragSort((from, to) => {
    const next = moveItem(ordered, from, to)
    if (next !== ordered) void saveOrder(next)
  })
  const used = categories.filter((c) => projects.some((p) => p.categoryId === c.id))
  const loose = projects.some((p) => !used.some((c) => c.id === p.categoryId))
  const options = [
    { id: 'all', label: t('全部 {n}', { n: projects.length }) },
    ...used.map((c) => ({ id: c.id, label: c.name })),
    ...(loose && used.length ? [{ id: '', label: t('未分类') }] : []),
  ]

  return (
    <PageFrame
      title={t('全部项目')}
      intro={t('点卡片切到那个项目；拖动左上角的手柄调整顺序，右上角是更多操作。')}
      align="left"
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={() => openSettings('categories')}>
            {t('管理项目分类')}
          </Button>
          <Button size="sm" onClick={() => openProject()}>
            <FolderPlus className="h-4 w-4" />
            {t('新建项目')}
          </Button>
        </>
      }
    >
      {options.length > 2 && (
        <Segmented size="sm" label={t('按分类筛选')} value={cat} onChange={setCat} options={options} />
      )}
      {!projects.length && <EmptyPanel size="md">{t('还没有项目。点右上角「新建项目」添加一个本机目录。')}</EmptyPanel>}
      <div data-all-projects className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((p) => {
          const gi = ordered.indexOf(p)
          const handle = sort.itemProps(gi, ordered.length)
          const stat = stats.get(p.id) ?? EMPTY_STAT
          return (
            <div
              key={p.id}
              data-project-name={p.name}
              onDragOver={handle.onDragOver}
              onDrop={handle.onDrop}
              className={cn(
                'relative rounded-(--c-card-radius)',
                sort.drag === gi && 'opacity-40',
                sort.drag !== null && sort.over === gi && sort.drag !== gi && 'ring-2 ring-accent',
              )}
            >
              <ProjectCard
                name={
                  actions.renaming === p.id ? (
                    <InlineRename
                      value={p.name}
                      label={t('项目名称')}
                      size="sm"
                      onCommit={(v) => actions.rename(p, v)}
                      onCancel={() => actions.setRenaming('')}
                    />
                  ) : (
                    p.name
                  )
                }
                path={p.path}
                category={categories.find((c) => c.id === p.categoryId)?.name}
                status={<ProjectStatus stat={stat} />}
                recent={recent
                  .filter((x) => x.projectId === p.id)
                  .slice(0, RECENT)
                  .map((x) => x.title)}
                on={p.id === current}
                onOpen={() => actions.renaming !== p.id && go({ page: 'projects', id: p.id })}
                handle={
                  cat === 'all'
                    ? {
                        ...handle,
                        'aria-label': t('拖动调整「{name}」的顺序', { name: p.name }),
                        title: t('拖动调整顺序（也可以按 Alt + ↑ / ↓）'),
                      }
                    : undefined
                }
                more={
                  <Menu>
                    <MenuTrigger asChild>
                      <IconButton icon={MoreHorizontal} label={t('「{name}」的更多操作', { name: p.name })} size="sm" />
                    </MenuTrigger>
                    <MenuContent align="end">{actions.menu(p, MenuItem, MenuSeparator)}</MenuContent>
                  </Menu>
                }
              />
            </div>
          )
        })}
      </div>
      {actions.dialogs}
    </PageFrame>
  )
}
