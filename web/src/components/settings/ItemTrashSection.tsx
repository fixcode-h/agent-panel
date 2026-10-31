import { useEffect, useState } from 'react'
import { Bot, FolderOpen, Loader2, RotateCcw, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import { TRASH_RETENTION_DAYS } from '@shared/task'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast, toastError } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { shortTime } from '@/components/layout/SidebarTasks'

type Row = Awaited<ReturnType<typeof api.itemTrash>>[number]

const KIND: Record<Row['kind'], { icon: typeof Bot; label: () => string }> = {
  agent: { icon: Bot, label: () => t('角色') },
  workflow: { icon: WorkflowIcon, label: () => t('工作流') },
  project: { icon: FolderOpen, label: () => t('项目') },
}

/**
 * 设置 →「数据」→ 回收站里的第二块：删掉的角色、工作流、项目。
 * 和对话一样保留 TRASH_RETENTION_DAYS 天；项目恢复时它的对话一起回来。空的时候整块不显示
 */
export function ItemTrashSection() {
  const { setAgents, setWorkflows, setProjects, reloadTasks } = useData()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState('')
  const key = (r: Row) => `${r.kind}:${r.id}`

  const load = async () => {
    setLoading(true)
    try {
      setRows(await api.itemTrash())
    } catch (e) {
      toastError(e)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const restore = async (r: Row) => {
    setBusy(key(r))
    try {
      const res = await api.restoreItem(r.kind, r.id)
      // 恢复的那一类重新取一遍，页面上马上能看到
      if (r.kind === 'agent') setAgents(await api.agents())
      else if (r.kind === 'workflow') setWorkflows(await api.workflows())
      else {
        setProjects(await api.projects())
        void reloadTasks()
      }
      toast.success(
        res.tasks
          ? t('已恢复「{name}」和它的 {n} 个对话', { name: r.name, n: res.tasks })
          : t('已恢复「{name}」', { name: r.name }),
      )
      await load()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy('')
    }
  }

  const purge = async (r: Row) => {
    if (confirm !== key(r)) return setConfirm(key(r))
    setBusy(key(r))
    try {
      await api.purgeItem(r.kind, r.id)
      toast.success(t('已永久删除「{name}」', { name: r.name }))
      setConfirm('')
      await load()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy('')
    }
  }

  if (!rows.length && !loading) return null
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center">
        <h3 className="text-body font-semibold">{t('删除的角色、工作流和项目')}</h3>
        {loading && <Loader2 className="ml-2 h-3.5 w-3.5 animate-spin text-subtle" />}
      </div>
      <p className="text-body leading-relaxed text-subtle">
        {t('{days} 天内可以恢复；恢复项目时它的对话一起回来。', { days: TRASH_RETENTION_DAYS })}
      </p>
      <Card className="overflow-hidden">
        {rows.map((r) => {
          const Icon = KIND[r.kind].icon
          return (
            <div
              key={key(r)}
              className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0"
              onMouseLeave={() => confirm === key(r) && setConfirm('')}
            >
              <Icon className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-body">{r.name}</span>
                <span className="text-xs leading-relaxed text-subtle">
                  {KIND[r.kind].label()}
                  {' · '}
                  {t('{time}删除', { time: shortTime(r.deletedAt) })}
                  {r.tasks > 0 && t(' · 含 {n} 个对话', { n: r.tasks })}
                  {' · '}
                  {r.leftDays > 0 ? t('{n} 天后永久删除', { n: r.leftDays }) : t('即将永久删除')}
                </span>
              </span>
              <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => void restore(r)}>
                <RotateCcw className="h-3.5 w-3.5" />
                {t('恢复')}
              </Button>
              <Button
                variant={confirm === key(r) ? 'danger' : 'ghost'}
                size="sm"
                className={cn('shrink-0', confirm === key(r) && 'min-w-[92px]')}
                disabled={!!busy}
                onClick={() => void purge(r)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {confirm === key(r) ? t('再点一次') : t('永久删除')}
              </Button>
            </div>
          )
        })}
      </Card>
    </section>
  )
}
