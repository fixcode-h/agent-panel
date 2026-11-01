import { useEffect, useState } from 'react'
import { Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { TRASH_RETENTION_DAYS, type TrashRow } from '@shared/task'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Card } from '@/components/ui/card'
import { shortTime } from '@/components/layout/SidebarTasks'

/**
 * 设置 →「数据」→ 回收站：删掉的对话先在这里放 TRASH_RETENTION_DAYS 天（常量见 shared/task.ts），
 * 过期后由服务端的清理任务物理删除。这里只做两件事：恢复、永久删除（要确认两次）。
 */
export function TrashSection() {
  const { reloadTasks } = useData()
  const [rows, setRows] = useState<TrashRow[]>([])
  const [loading, setLoading] = useState(false)
  // 永久删除点两次：第一次把这一行的按钮换成「再点一次」，第二次才真删
  const [confirmId, setConfirmId] = useState('')
  const [busy, setBusy] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      setRows(await api.trash())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const restore = async (row: TrashRow) => {
    setBusy(row.id)
    try {
      const res = await api.restoreTask(row.id)
      toast.success(t('已恢复「{title}」', { title: row.title }))
      // 分支目录已经被面板回收：明确告诉用户恢复后要重新执行，不能留一个指向不存在目录的状态
      if (res.worktreeCleared)
        toast.warning(t('「{title}」的独立分支目录已经清理，恢复后需要重新执行', { title: row.title }))
      setConfirmId('')
      await load()
      void reloadTasks()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const purge = async (row: TrashRow) => {
    if (confirmId !== row.id) {
      setConfirmId(row.id)
      return
    }
    setBusy(row.id)
    try {
      await api.permanentDeleteTask(row.id)
      toast.success(t('已永久删除「{title}」', { title: row.title }))
      setConfirmId('')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center">
        <h3 className="text-body font-semibold">{t('回收站')}</h3>
        {rows.length > 0 && <span className="ml-2 text-xs text-subtle">{t('{n} 个对话', { n: rows.length })}</span>}
        {loading && <Loader2 className="ml-2 h-3.5 w-3.5 animate-spin text-subtle" />}
      </div>
      <p className="text-body leading-relaxed text-subtle">
        {t(
          '删除的对话先进回收站，{days} 天后自动永久删除。恢复后能接着对话；永久删除会清掉对话内容、附件和独立分支。',
          { days: TRASH_RETENTION_DAYS },
        )}
      </p>
      {rows.length === 0 ? (
        <EmptyPanel size="sm">{t('回收站是空的')}</EmptyPanel>
      ) : (
        <Card className="overflow-hidden">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0"
              onMouseLeave={() => confirmId === row.id && setConfirmId('')}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-body">{row.title}</span>
                <span className="text-xs leading-relaxed text-subtle">
                  {t('{time}删除', { time: shortTime(row.deletedAt) })}
                  {row.children > 0 && t(' · 含 {n} 个子对话', { n: row.children })}
                  {' · '}
                  {/* 剩余天数由服务端按同一个保留期算好，前端不再自己推一遍 */}
                  {row.leftDays > 0 ? t('{n} 天后永久删除', { n: row.leftDays }) : t('即将永久删除')}
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={!!busy}
                onClick={() => void restore(row)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('恢复')}
              </Button>
              <Button
                variant={confirmId === row.id ? 'danger' : 'ghost'}
                size="sm"
                className={cn('shrink-0', confirmId === row.id && 'min-w-[92px]')}
                disabled={!!busy}
                onClick={() => void purge(row)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {confirmId === row.id ? t('再点一次') : t('永久删除')}
              </Button>
            </div>
          ))}
        </Card>
      )}
    </section>
  )
}
