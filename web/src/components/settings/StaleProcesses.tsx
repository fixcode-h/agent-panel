import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/memory'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { toast, toastError } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { IconButton } from '@/components/ui/icon-button'

type Row = Awaited<ReturnType<typeof api.staleProcesses>>['processes'][number]

/**
 * 设置 →「数据」→ 内存下面：所有对话里留下的 CLI 进程（任务已经不在跑、进程还活着）。
 * 以前要打开对应的对话、进标题栏的进程菜单才能清；这里一处看全、一键清理。没有残留时只显示一行说明
 */
export function StaleProcesses() {
  const [rows, setRows] = useState<Row[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [cleaning, setCleaning] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.staleProcesses()
      setRows(r.processes)
      setNote(r.unavailable)
    } catch (e) {
      toastError(e)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const clean = async () => {
    setCleaning(true)
    try {
      const r = await api.cleanStaleProcesses(rows.map((x) => x.pid))
      if (r.skipped.length)
        toast.warning(
          t('结束了 {n} 个，{m} 个没能结束：{why}', {
            n: r.killed.length,
            m: r.skipped.length,
            why: r.skipped[0].reason,
          }),
        )
      else toast.success(t('已结束 {n} 个残留进程', { n: r.killed.length + r.gone.length }))
      await load()
    } catch (e) {
      toastError(e)
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 className="text-body font-medium">{t('残留进程')}</h4>
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-subtle" />
        ) : (
          <IconButton icon={RefreshCw} label={t('重新检查')} size="sm" onClick={() => void load()} />
        )}
        {rows.length > 0 && (
          <Button variant="secondary" size="sm" className="ml-auto" disabled={cleaning} onClick={() => void clean()}>
            <Trash2 className="h-3.5 w-3.5" />
            {t('全部结束')}
          </Button>
        )}
      </div>
      {note ? (
        <p className="text-body text-subtle">{note}</p>
      ) : rows.length === 0 ? (
        <p className="text-body text-subtle">{t('没有残留进程：所有对话的 CLI 都在跑或已经结束。')}</p>
      ) : (
        <Card className="overflow-hidden">
          {rows.map((r) => (
            <div key={r.pid} className="flex items-center gap-3 border-b px-3.5 py-2.5 text-body last:border-b-0">
              <span className="w-16 shrink-0 font-mono text-xs text-subtle">{r.pid}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{r.ownerTitle || t('（不属于任何对话）')}</span>
                <span className="truncate font-mono text-xs text-subtle" title={r.command}>
                  {r.command}
                </span>
              </span>
              {r.rss !== null && <span className="shrink-0 text-xs text-subtle">{formatBytes(r.rss)}</span>}
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
