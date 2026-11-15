import { useState, type ComponentType, type ReactNode } from 'react'
import { Archive, FolderSearch, MessageSquarePlus, PencilLine, Settings2, Trash2 } from 'lucide-react'
import type { Project, Task } from '@shared/schema'
import { t } from '@shared/i18n'
import { TRASH_RETENTION_DAYS } from '@shared/task'
import { liveBusy } from '@shared/live/task-live'
import { useData, useNav } from '@/lib/data'
import { useLiveOf } from '@/lib/live/store'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/ui/dialog'
import { unmergedOf } from '@/components/tasks/Worktrees'

/** 菜单项的形状：右键菜单（ContextMenuItem）和「更多」菜单（MenuItem）都能接 */
type ItemComp = ComponentType<{ onSelect?: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }>

/**
 * 一个项目的操作（新建对话、项目设置、在文件夹中打开、重命名、一键归档 / 删除未运行的对话、删除项目）：
 * 原来挂在侧栏项目树的右键菜单上，方案 B 里项目切换器的右键菜单和「全部项目」页的卡片菜单共用这一份。
 * recent 是没归档的项目对话（不含子对话、插件管的对话），一键清理只动其中没在执行的
 */
export function useProjectActions(recent: Task[]) {
  const { route, go, openProject } = useNav()
  const { setProjects, reloadTasks, removeTask, upsertTask } = useData()
  const liveOf = useLiveOf()
  // 重命名就地改名（调用方按 renaming 换成输入框），删除先确认
  const [renaming, setRenaming] = useState('')
  const [deleting, setDeleting] = useState<Project>()
  const [bulk, setBulk] = useState<{ project: Project; action: 'archive' | 'delete'; n: number }>()

  const rename = async (p: Project, name: string) => {
    setRenaming('')
    name = name.trim()
    if (!name || name === p.name) return
    try {
      const { id, createdAt, updatedAt, ...rest } = p
      const saved = await api.updateProject(id, { ...rest, name })
      setProjects((ps) => ps.map((x) => (x.id === saved.id ? saved : x)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const remove = async (p: Project) => {
    try {
      await api.deleteProject(p.id)
      setProjects((ps) => ps.filter((x) => x.id !== p.id))
      void reloadTasks()
      toast.success(t('已删除「{name}」', { name: p.name }))
      if ((route.page === 'projects' || route.page === 'plugin') && (route.id === p.id || route.project === p.id))
        go({ page: 'home' })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeleting(undefined)
    }
  }
  // 一键清理：只动这个项目下没在执行的对话（子对话在跑的父对话也算在执行，删它会连带结束子对话）
  const idleTasks = (pid: string) => recent.filter((x) => x.projectId === pid && !liveBusy(liveOf(x)))
  const runBulk = async () => {
    if (!bulk) return
    const { project, action } = bulk
    // 确认框开着时可能有对话开始执行了：按确认那一刻的状态重新挑一遍
    const list = idleTasks(project.id)
    let ok = 0
    let failed = 0
    let kept = 0
    for (const tk of list) {
      try {
        if (action === 'delete') {
          // 有没合并的独立分支的对话不在一键清理里删，免得改动悄悄丢掉；要删就单独删，会先警告
          const wts = await api.taskWorktrees(tk.id).catch(() => ({ items: [] }))
          if (unmergedOf(wts.items).length) {
            kept++
            continue
          }
          await api.deleteTask(tk.id)
          removeTask(tk.id)
        } else upsertTask(await api.archiveTaskSummary(tk.id, true))
        ok++
      } catch {
        failed++
      }
    }
    setBulk(undefined)
    // 正在看的对话被删掉了：回到项目首页
    if (action === 'delete' && route.page === 'projects' && route.sub && list.some((x) => x.id === route.sub))
      go({ page: 'projects', id: project.id })
    if (failed) toast.error(t('{ok} 个成功，{failed} 个失败', { ok, failed }))
    else if (action === 'delete' && kept)
      toast.success(t('已删除 {n} 个对话，{kept} 个有没合并的独立分支，留着没删', { n: ok, kept }))
    else if (action === 'delete') toast.success(t('已删除 {n} 个对话', { n: ok }))
    else toast.success(t('已归档 {n} 个对话，可以在筛选里选「已归档」找到', { n: ok }))
  }
  const reveal = (p: Project) => {
    if (!p.path) return toast.error(t('这个项目还没有选择本地目录'))
    // 成功也给一句：资源管理器可能开在浏览器后面，没有反馈时用户只能看到「点了没反应」
    api
      .revealProject(p.id)
      .then((r) => toast.success(t('已在文件夹中打开：{dir}', { dir: r.dir })))
      .catch((e) => toast.error((e as Error).message))
  }

  /** 菜单内容：Item、Sep 由调用方给（右键菜单或下拉菜单的部件） */
  const menu = (p: Project, Item: ItemComp, Sep: ComponentType) => {
    const idle = idleTasks(p.id).length
    return (
      <>
        <Item onSelect={() => go({ page: 'projects', id: p.id })}>
          <MessageSquarePlus className="h-4 w-4" />
          {t('新建对话')}
        </Item>
        <Item onSelect={() => openProject(p.id)}>
          <Settings2 className="h-4 w-4" />
          {t('项目设置')}
        </Item>
        {!import.meta.env.VITE_DEMO && (
          <Item disabled={!p.path} onSelect={() => reveal(p)}>
            <FolderSearch className="h-4 w-4" />
            {t('在文件夹中打开')}
          </Item>
        )}
        <Item onSelect={() => setRenaming(p.id)}>
          <PencilLine className="h-4 w-4" />
          {t('重命名')}
        </Item>
        <Sep />
        <Item disabled={!idle} onSelect={() => setBulk({ project: p, action: 'archive', n: idle })}>
          <Archive className="h-4 w-4" />
          {t('归档所有未运行的对话')}
        </Item>
        <Item danger disabled={!idle} onSelect={() => setBulk({ project: p, action: 'delete', n: idle })}>
          <Trash2 className="h-4 w-4" />
          {t('删除所有未运行的对话')}
        </Item>
        <Sep />
        <Item danger onSelect={() => setDeleting(p)}>
          <Trash2 className="h-4 w-4" />
          {t('删除')}
        </Item>
      </>
    )
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(undefined)}
        title={t('删除「{name}」？', { name: deleting?.name ?? '' })}
        description={t('会删除面板里的配置和这个项目的所有对话，不会动本地目录里的文件。')}
        onConfirm={() => deleting && remove(deleting)}
      />
      <ConfirmDialog
        open={!!bulk}
        onOpenChange={(o) => !o && setBulk(undefined)}
        title={
          bulk?.action === 'delete'
            ? t('删除「{name}」里 {n} 个未运行的对话？', { name: bulk.project.name, n: bulk.n })
            : t('归档「{name}」里 {n} 个未运行的对话？', { name: bulk?.project.name ?? '', n: bulk?.n ?? 0 })
        }
        description={
          bulk?.action === 'delete'
            ? t(
                '正在执行的对话、有没合并的独立分支的对话不受影响。删除的对话会移进回收站，{days} 天内可以在设置 →「数据」→ 回收站里恢复，不会动本地目录里的文件。',
                { days: TRASH_RETENTION_DAYS },
              )
            : t('正在执行的对话不受影响。归档的对话不会删除，可以在筛选里选「已归档」找到。')
        }
        confirmText={bulk?.action === 'delete' ? t('删除') : t('归档')}
        onConfirm={runBulk}
      />
    </>
  )

  return { menu, dialogs, renaming, setRenaming, rename }
}
