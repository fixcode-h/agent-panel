import { useState } from 'react'
import { ChevronRight, Folder, FolderOpen, Gamepad2, Loader2, PencilLine, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DesignMeta } from '@shared/design'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { ConfirmDialog } from '@/components/ui/dialog'
import { t } from '@shared/i18n'

/**
 * UI 设计模式的侧栏：项目照常列出，展开后是这个项目的设计（和任务分开，互不混在一起）。
 */
export function DesignList() {
  const { projects, designs, setDesigns } = useData()
  const { route, go } = useNav()
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState('')
  const [deleting, setDeleting] = useState<DesignMeta>()
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
        images: f.images,
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

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <p className="flex h-7 shrink-0 items-center px-2.5 text-xs text-subtle">{t('项目')}</p>
      {!projects.length && (
        <p className="px-2.5 pt-1 text-xs leading-relaxed text-subtle">
          {t('还没有项目。设计放在项目里，先添加一个项目。')}
        </p>
      )}
      {list.map((p) => {
        const ds = byProject.get(p.id) ?? []
        const open = !folded.has(p.id)
        return (
          <section key={p.id} className="mb-2">
            <div className="group/proj flex h-8 items-center gap-1 rounded-lg pr-1 pl-1 text-[12.5px] text-muted hover:bg-sel/60">
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
                <span className="shrink-0 pr-1 text-[11px] text-subtle tabular-nums group-hover/proj:hidden">
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
            {open && ds.length > 0 && (
              <div className="mt-0.5 ml-[18px] flex flex-col gap-px border-l pl-1.5">
                {ds.map((d) => {
                  const on = route.page === 'design' && route.id === d.id
                  return (
                    <ContextMenu key={d.id}>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            'flex h-8 items-center gap-2 rounded-lg px-2 text-[13px]',
                            on ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/60 hover:text-fg',
                          )}
                        >
                          {d.running ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
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
                              className="h-6 min-w-0 flex-1 rounded-md border border-accent bg-field px-1.5 text-[12.5px] text-fg outline-none"
                            />
                          ) : (
                            <button
                              onClick={() => go({ page: 'design', id: d.id })}
                              className="min-w-0 flex-1 cursor-pointer truncate text-left"
                            >
                              {d.title}
                            </button>
                          )}
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => setRenaming(d.id)}>
                          <PencilLine className="h-4 w-4" />
                          {t('重命名')}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem danger onSelect={() => setDeleting(d)}>
                          <Trash2 className="h-4 w-4" />
                          {t('删除')}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
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
