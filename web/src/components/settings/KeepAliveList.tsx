import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Eye, Loader2, Power } from 'lucide-react'
import { formatBytes, formatSampleTime } from '@shared/memory'
import { getCli } from '@shared/clis'
import { api, type KeepAliveItem } from '@/lib/api'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { t } from '@shared/i18n'

/** 刷新间隔：进程数量和内存变化不快，开着设置页时偶尔看一眼就够 */
const REFRESH_MS = 10_000

/**
 * 保活中的会话：回复完停在等下一句、CLI 进程还留着的对话，各占多少内存。
 * 用户可以逐个释放或一键释放所有没开着页面的；释放后下次发消息冷启动续接原会话，不会多花 Token
 */
export function KeepAliveList() {
  const { projects } = useData()
  const [items, setItems] = useState<KeepAliveItem[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = async () => {
    try {
      setItems(await api.keepAlive())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  const release = async (ids?: string[]) => {
    setBusy(ids?.[0] ?? '*')
    try {
      const r = await api.releaseKeepAlive(ids)
      toast.success(r.released.length ? t('已释放 {n} 个会话', { n: r.released.length }) : t('没有可以释放的会话'))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const idle = items?.filter((x) => !x.viewing) ?? []
  const total = items?.reduce((a, x) => a + (x.rss ?? 0), 0) ?? 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[0.8125rem] font-medium">{t('保活中的会话')}</span>
        {!!items?.length && (
          <span className="text-xs text-subtle">
            {t('{n} 个 · 共 {size}', { n: items.length, size: formatBytes(total) })}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          disabled={!idle.length || !!busy}
          onClick={() => void release()}
        >
          {busy === '*' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
          {t('释放全部闲置')}
        </Button>
      </div>
      {error ? (
        <p className="text-xs leading-relaxed text-danger">{t('读取保活的会话失败：{msg}', { msg: error })}</p>
      ) : items === null ? (
        <p className="text-xs text-subtle">{t('正在读取…')}</p>
      ) : !items.length ? (
        <p className="text-xs text-subtle">{t('现在没有保活中的会话')}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          {items.map((x) => {
            const project = projects.find((p) => p.id === x.projectId)?.name
            return (
              <div key={x.id} className="flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[0.8125rem]">{x.title}</span>
                    {x.viewing && (
                      <span className="flex shrink-0 items-center gap-1 rounded-md bg-accent/10 px-1.5 py-px text-[0.6875rem] text-accent-text">
                        <Eye className="h-3 w-3" />
                        {t('正在看')}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-subtle">
                    {[getCli(x.cli)?.name ?? x.cli, project, t('{time} 回复完', { time: formatSampleTime(x.since) })]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[0.75rem] text-muted">
                  {x.rss === null ? t('未采集') : formatBytes(x.rss)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  disabled={!!busy}
                  onClick={() => void release([x.id])}
                >
                  {busy === x.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('释放')}
                </Button>
              </div>
            )
          })}
        </div>
      )}
      <p className="text-xs leading-relaxed text-subtle">
        {t(
          '回复完、CLI 进程还留着等下一句的对话。释放后进程结束，下次发消息时重新启动并续接原来的会话（多等几秒，不会多花 Token）。「释放全部闲置」不动正开着的对话。',
        )}
      </p>
    </div>
  )
}
