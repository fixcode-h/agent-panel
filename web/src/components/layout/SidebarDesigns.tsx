import { useState } from 'react'
import {
  ChevronRight,
  CircleAlert,
  CopyPlus,
  Folder,
  FolderInput,
  FolderOpen,
  Gamepad2,
  Globe,
  Loader2,
  PencilLine,
  Plus,
  Settings2,
  Trash2,
  Palette,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import type { DesignMeta, DesignProject } from '@shared/design'
import { DesignProjectDialog, type DesignProjectSection } from '@/components/design/DesignProjectDialog'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import { DESIGN_HOME, designHomeRoute, designKind, kindFoldKey, kindLabel, toggleFoldKey } from '@/lib/design-projects'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { ConfirmDialog } from '@/components/ui/dialog'
import { SIDEBAR_GROUP_LABEL, SIDEBAR_ROW_OFF, SIDEBAR_ROW_ON } from './SidebarTasks'
import { t } from '@shared/i18n'

/**
 * UI 设计模式的侧栏：UI 设计自己的项目（和 Agent 的项目分开），展开后是这个项目的各个界面。
 */
const KINDS = [
  { id: 'game', icon: Gamepad2 },
  { id: 'web', icon: Globe },
] as const

export function DesignList() {
  const { designProjects: projects, setDesignProjects, designs, setDesigns } = useData()
  const { route, go } = useNav()
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState('')
  const [deleting, setDeleting] = useState<DesignMeta>()
  // 新建（null）或编辑项目；undefined 表示没打开
  const [editing, setEditing] = useState<DesignProject | null>()
  const [section, setSection] = useState<DesignProjectSection>('general')
  const [removingProject, setRemovingProject] = useState<DesignProject>()
  const byProject = new Map<string, DesignMeta[]>()
  for (const d of [...designs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    byProject.set(d.projectId, [...(byProject.get(d.projectId) ?? []), d])
  const last = (pid: string, fallback: string) => byProject.get(pid)?.[0]?.updatedAt ?? fallback
  const list = [...projects].sort((a, b) => last(b.id, b.updatedAt).localeCompare(last(a.id, a.updatedAt)))
  // 项目和分类（`项目id:分类id`）共用一份折叠集合。只有最前面的箭头按钮和分类行改这个集合，
  // 点项目名是打开项目主页，不再顺带折叠
  const toggleFold = (key: string) => setFolded((f) => toggleFoldKey(f, key))

  const rename = async (d: DesignMeta, title: string) => {
    setRenaming('')
    title = title.trim()
    if (!title || title === d.title) return
    try {
      const f = await api.design(d.id)
      await api.saveDesign(d.id, {
        title,
        data: f.data,
        designSize: f.designSize,
        style: f.style,
        root: f.root,
        components: f.components,
        annotations: f.annotations,
        images: f.images,
        animations: f.animations,
      })
      setDesigns((l) => l.map((x) => (x.id === d.id ? { ...x, title } : x)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async (d: DesignMeta) => {
    try {
      await api.deleteDesign(d.id)
      setDesigns((l) => l.filter((x) => x.id !== d.id))
      if (route.page === 'design' && route.id === d.id) go({ page: 'design' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(undefined)
    }
  }

  const copy = async (d: DesignMeta) => {
    try {
      const c = await api.copyDesign(d.id)
      setDesigns((l) => [
        ...l,
        {
          id: c.id,
          projectId: c.projectId,
          kind: c.kind,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        },
      ])
      go({ page: 'design', id: c.id })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const move = async (d: DesignMeta, projectId: string) => {
    try {
      await api.moveDesign(d.id, projectId)
      setDesigns((l) => l.map((x) => (x.id === d.id ? { ...x, projectId } : x)))
      // 目标项目如果折叠着就展开，能看到移过去的设计
      setFolded((f) => {
        const n = new Set(f)
        n.delete(projectId)
        return n
      })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const removeProject = async (p: DesignProject) => {
    try {
      await api.deleteDesignProject(p.id)
      setDesignProjects((l) => l.filter((x) => x.id !== p.id))
      setDesigns((l) => l.filter((x) => x.projectId !== p.id))
      if (route.page === 'design' && designs.some((d) => d.id === route.id && d.projectId === p.id))
        go({ page: 'design' })
      // 正停在这个项目的主页上：项目没了就回新建设计页
      else if (route.page === 'design' && route.id === DESIGN_HOME && route.sub === p.id) go({ page: 'design' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemovingProject(undefined)
    }
  }

  /** 侧栏里的一个设计 */
  const designRow = (d: DesignMeta) => {
    const on = route.page === 'design' && route.id === d.id
    return (
      <ContextMenu key={d.id}>
        <ContextMenuTrigger asChild>
          <div
            // 整行都能点：以前只有文字能点，点到图标或空白处没反应，像是要点两次
            onClick={() => renaming !== d.id && go({ page: 'design', id: d.id })}
            className={cn(
              'flex h-8 cursor-pointer items-center gap-2 rounded-md border px-2 text-[0.8125rem] transition-colors',
              on ? SIDEBAR_ROW_ON : SIDEBAR_ROW_OFF,
            )}
          >
            {d.asking ? (
              // AI 在等你确认或回答
              <CircleAlert
                aria-label={t('需要你处理')}
                className="h-3.5 w-3.5 shrink-0 text-warning"
                strokeWidth={2.4}
              />
            ) : d.running ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
            ) : d.kind === 'web' ? (
              <Globe className="h-3.5 w-3.5 shrink-0 text-subtle" />
            ) : (
              <Gamepad2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
            )}
            {renaming === d.id ? (
              <input
                autoFocus
                defaultValue={d.title}
                aria-label={t('设计名称')}
                onFocus={(e) => e.target.select()}
                onBlur={(e) => void rename(d, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setRenaming('')
                  }
                }}
                className="h-6 min-w-0 flex-1 rounded-md border border-accent bg-field px-1.5 text-[0.78125rem] text-fg outline-none"
              />
            ) : (
              // 点击冒泡到整行去跳转；保留按钮是为了能用键盘选中
              <button className="min-w-0 flex-1 cursor-pointer truncate text-left">{d.title}</button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setRenaming(d.id)}>
            <PencilLine className="h-4 w-4" />
            {t('重命名')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copy(d)}>
            <CopyPlus className="h-4 w-4" />
            {t('创建副本')}
          </ContextMenuItem>
          {projects.length > 1 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <FolderInput className="h-4 w-4" />
                {t('移到项目')}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {projects
                  .filter((x) => x.id !== d.projectId)
                  .map((x) => (
                    <ContextMenuItem key={x.id} onSelect={() => void move(d, x.id)}>
                      <Folder className="h-4 w-4 text-subtle" />
                      {x.name}
                    </ContextMenuItem>
                  ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem danger onSelect={() => setDeleting(d)}>
            <Trash2 className="h-4 w-4" />
            {t('删除')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <div className="flex h-7 shrink-0 items-center pr-1 pl-2.5">
        <p className={cn('flex-1', SIDEBAR_GROUP_LABEL)}>{t('UI 项目')}</p>
        <button
          onClick={() => setEditing(null)}
          aria-label={t('新建 UI 项目')}
          title={t('新建 UI 项目')}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-sel hover:text-fg"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {!projects.length && (
        <div className="mx-0.5 mt-1 flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center">
          <Palette className="h-5 w-5 text-subtle" strokeWidth={1.6} />
          <p className="text-xs leading-relaxed text-subtle">
            {t('还没有 UI 项目。UI 设计的项目和 Agent 的项目是分开的。')}
          </p>
          <button
            onClick={() => setEditing(null)}
            className="cursor-pointer rounded-md px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft"
          >
            {t('新建 UI 项目')}
          </button>
        </div>
      )}
      {list.map((p) => {
        const ds = byProject.get(p.id) ?? []
        const open = !folded.has(p.id)
        const on = route.page === 'design' && route.id === DESIGN_HOME && route.sub === p.id
        return (
          <section key={p.id} className="mb-2">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  // 整行只是排成一行的容器：点空白处不展开也不打开，展开 / 打开各有自己的按钮
                  className={cn(
                    'group/proj flex h-8 items-center gap-1 rounded-md border pr-1 pl-1 text-[0.78125rem] transition-colors',
                    on ? SIDEBAR_ROW_ON : SIDEBAR_ROW_OFF,
                  )}
                >
                  <button
                    // 折叠只由这个箭头按钮触发：以前整行可点、靠冒泡折叠，点项目名打不开主页
                    onClick={() => toggleFold(p.id)}
                    // 界面检查按项目定位这个按钮：侧栏里 Agent 项目行也有同名「收起」按钮，不能靠 DOM 顺序取第一个
                    data-fold={p.id}
                    aria-expanded={open}
                    aria-label={open ? t('收起') : t('展开')}
                    disabled={!ds.length}
                    className={cn(
                      'grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-sel/70 hover:text-fg',
                      !ds.length && 'invisible',
                    )}
                  >
                    <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
                  </button>
                  <button
                    onClick={() => go(designHomeRoute(p.id))}
                    aria-label={t('打开项目「{name}」，右键查看更多操作', { name: p.name })}
                    title={t('打开项目「{name}」，右键查看更多操作', { name: p.name })}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                  >
                    {open ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  </button>
                  {ds.length > 0 && (
                    <span className="shrink-0 pr-1 text-[0.6875rem] text-subtle tabular-nums group-hover/proj:hidden">
                      {ds.length}
                    </span>
                  )}
                  <button
                    onClick={() => go({ page: 'design', id: 'new', sub: p.id })}
                    aria-label={t('在「{name}」新建设计', { name: p.name })}
                    title={t('新建设计')}
                    className={cn(
                      ds.length ? 'hidden' : 'grid opacity-60',
                      'h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle group-hover/proj:grid group-hover/proj:opacity-100 hover:bg-sel hover:text-fg',
                    )}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => go({ page: 'design', id: 'new', sub: p.id })}>
                  <Plus className="h-4 w-4" />
                  {t('新建设计')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => (setSection('general'), setEditing(p))}>
                  <Settings2 className="h-4 w-4" />
                  {t('项目设置')}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => (setSection('prompts'), setEditing(p))}>
                  <Palette className="h-4 w-4" />
                  {t('美术提示词')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem danger onSelect={() => setRemovingProject(p)}>
                  <Trash2 className="h-4 w-4" />
                  {t('删除项目')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {open && ds.length > 0 && (
              <div className="mt-1 ml-3 flex flex-col gap-0.5">
                {/* 同一个项目里游戏 UI 和网页 UI 分开列，各自可以收起 */}
                {KINDS.filter((k) => ds.some((d) => designKind(d) === k.id)).map((k) => {
                  const list = ds.filter((d) => designKind(d) === k.id)
                  const key = kindFoldKey(p.id, k.id)
                  const kOpen = !folded.has(key)
                  return (
                    <div key={k.id} className="flex flex-col gap-px">
                      <button
                        data-kind={k.id}
                        onClick={() => toggleFold(key)}
                        aria-expanded={kOpen}
                        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[0.75rem] text-subtle transition-colors hover:bg-sel/60 hover:text-fg"
                      >
                        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', kOpen && 'rotate-90')} />
                        <k.icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-left">{kindLabel(k.id)}</span>
                        <span className="shrink-0 pr-1 text-[0.6875rem] tabular-nums">{list.length}</span>
                      </button>
                      {kOpen && <div className="ml-3 flex flex-col gap-px">{list.map(designRow)}</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
      <DesignProjectDialog
        open={editing !== undefined}
        onOpenChange={(o) => !o && setEditing(undefined)}
        project={editing ?? undefined}
        section={editing ? section : 'general'}
        onSaved={(np) => !editing && go({ page: 'design', id: 'new', sub: np.id })}
      />
      <ConfirmDialog
        open={!!removingProject}
        onOpenChange={(o) => !o && setRemovingProject(undefined)}
        title={t('删除项目「{name}」？', { name: removingProject?.name ?? '' })}
        description={t('会一起删除这个项目里的 {n} 个设计和它们的图片，本机目录里导出的文件不受影响。', {
          n: designs.filter((d) => d.projectId === removingProject?.id).length,
        })}
        onConfirm={() => removingProject && removeProject(removingProject)}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={t('删除「{name}」？', { name: deleting?.title ?? '' })}
        description={t('会删除这个设计的控件树、对话和生成的图片。')}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  )
}
