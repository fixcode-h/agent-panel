import { useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { fileIndexContract as C } from '@shared/api-contract/file-index'
import type { FileIndexOverview } from '@shared/file-index/types'
import { formatBytes } from '@shared/memory'
import { timeAgo } from '@shared/children/activity'
import { t } from '@shared/i18n'
import { call } from '@/lib/api/call'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { StatusPill } from '@/components/ui/status-pill'

/**
 * 设置 →「数据」里的「文件索引」：每份落盘的索引一行（一个根目录一份，几个项目共用同一个根时只有一份），
 * 可以单独重建、删除；用它的项目都删了的标「无主」，删掉就好
 */
export function FileIndexData({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<FileIndexOverview>()
  const [dropping, setDropping] = useState<string>()
  const load = () =>
    call(C.overview)
      .then(setData)
      .catch((e) => toast.error((e as Error).message))
  useEffect(() => {
    void load()
  }, [])

  const rebuild = async (key: string) => {
    try {
      await call(C.rebuildKey, { params: { key }, body: {} })
      toast.success(t('已开始重建，建好后自动替换'))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const drop = async (key: string) => {
    try {
      await call(C.drop, { params: { key } })
      await load()
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDropping(undefined)
    }
  }

  if (!data?.entries.length) return null
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-body font-semibold">{t('文件索引')}</h3>
        <span className="text-xs text-subtle">
          {t('{n} 份，共 {size}', { n: data.entries.length, size: formatBytes(data.bytes) })}
        </span>
      </div>
      <Card className="overflow-hidden">
        {data.entries.map((e) => {
          const orphan = !e.projects.length
          return (
            <div key={e.key} className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-footnote" title={e.root}>
                    {e.root}
                  </span>
                  {orphan ? (
                    <StatusPill tone="idle">{t('无主')}</StatusPill>
                  ) : e.state === 'building' ? (
                    <StatusPill tone="run" spin>
                      {t('建立中')}
                    </StatusPill>
                  ) : e.state === 'error' ? (
                    <StatusPill tone="err">{t('出错')}</StatusPill>
                  ) : null}
                </span>
                <span className="truncate text-xs text-subtle">
                  {[
                    orphan ? t('用它的项目已经删了') : e.projects.map((p) => p.name).join(t('、')),
                    t('{files} 个文件', { files: e.files.toLocaleString() }),
                    e.changedAt ? t('更新于 {ago}', { ago: timeAgo(new Date(e.changedAt).toISOString()) }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="shrink-0 font-mono text-footnote text-muted">{formatBytes(e.bytes)}</span>
              {!orphan && (
                <Button variant="secondary" size="sm" className="shrink-0" onClick={() => rebuild(e.key)}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('重建')}
                </Button>
              )}
              <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setDropping(e.key)}>
                <Trash2 className="h-3.5 w-3.5" />
                {t('删除')}
              </Button>
            </div>
          )
        })}
      </Card>
      <ConfirmDialog
        open={!!dropping}
        onOpenChange={(o) => !o && setDropping(undefined)}
        title={t('删除这份文件索引？')}
        description={t('只删索引，不动项目里的文件。还有项目在用时，下次用到会自动重建。')}
        onConfirm={() => dropping && drop(dropping)}
      />
    </section>
  )
}
