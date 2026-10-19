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
import { toast } from 'sonner'
import type { DesignMeta, DesignProject } from '@shared/design'
import { DesignProjectDialog, type DesignProjectSection } from '@/components/design/DesignProjectDialog'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
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

  const rename = async (d: DesignMeta, title: string) => {
    setRenaming('')
    title = title.trim()
    if (!title || title === d.title) return
    try {
      const f = await api.design(d.id)
      await api.saveDesign(d.id, {
        title,
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
              'flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[0.8125rem]',
              on ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/60 hover:text-fg',
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
        <p className="flex-1 text-xs text-subtle">{t('UI 项目')}</p>
        <button
          onClick={() => setEditing(null)}
          aria-label={t('新建 UI 项目')}
          title={t('新建 UI 项目')}
          className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {!projects.length && (
        <div className="px-2.5 pt-1 text-xs leading-relaxed text-subtle">
          <p>{t('还没有 UI 项目。UI 设计的项目和 Agent 的项目是分开的。')}</p>
          <button onClick={() => setEditing(null)} className="mt-1.5 cursor-pointer text-accent hover:underline">
            {t('新建 UI 项目')}
          </button>
        </div>
      )}
      {list.map((p) => {
        const ds = byProject.get(p.id) ?? []
        const open = !folded.has(p.id)
        return (
          <section key={p.id} className="mb-2">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="group/proj flex h-8 items-center gap-1 rounded-lg pr-1 pl-1 text-[0.78125rem] text-muted hover:bg-sel/60">
                  <button
                    onClick={() =>
                      setFolded((f) => {
                        const n = new Set(f)
                        if (!n.delete(p.id)) n.add(p.id)
                        return n
                      })
                    }
                    aria-expanded={open}
                    aria-label={open ? t('收起') : t('展开')}
                    disabled={!ds.length}
                    className={cn(
                      'grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:text-fg',
                      !ds.length && 'invisible',
                    )}
                  >
                    <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
                  </button>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {open ? (
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-subtle" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  </span>
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
              <div className="mt-0.5 ml-[18px] flex flex-col gap-px border-l pl-1.5">
                {/* 同一个项目里游戏 UI 和网页 UI 分开列，各自可以收起 */}
                {KINDS.filter((k) => ds.some((d) => (d.kind ?? 'game') === k.id)).map((k) => {
                  const list = ds.filter((d) => (d.kind ?? 'game') === k.id)
                  const key = `${p.id}:${k.id}`
                  const kOpen = !folded.has(key)
                  return (
                    <div key={k.id} className="flex flex-col gap-px">
                      <button
                        onClick={() =>
                          setFolded((f) => {
                            const n = new Set(f)
                            if (!n.delete(key)) n.add(key)
                            return n
                          })
                        }
                        aria-expanded={kOpen}
                        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 text-[0.75rem] text-subtle hover:bg-sel/60 hover:text-fg"
                      >
                        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', kOpen && 'rotate-90')} />
                        <k.icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-left">
                          {k.id === 'web' ? t('网页 UI') : t('游戏 UI')}
                        </span>
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
