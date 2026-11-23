import { useEffect, useState } from 'react'
import { ArrowRight, Database, Eye, RefreshCw } from 'lucide-react'
import { fileIndexContract as C } from '@shared/api-contract/file-index'
import type { FileIndexStatus } from '@shared/file-index/types'
import { formatBytes } from '@shared/memory'
import { fmtDuration } from '@shared/duration'
import { timeAgo } from '@shared/children/activity'
import { t } from '@shared/i18n'
import { call } from '@/lib/api/call'
import { openPageStream } from '@/lib/live/page-stream'
import { useNav } from '@/lib/data'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { StatusPill } from '@/components/ui/status-pill'

const demo = !!import.meta.env.VITE_DEMO
const ago = (ms?: number) => (ms ? timeAgo(new Date(ms).toISOString()) : '')

const BY: Record<string, () => string> = {
  agent: () => t('Agent 改了文件'),
  panel: () => t('面板里改了文件'),
  watch: () => t('系统通知'),
  verify: () => t('定时核对'),
  build: () => t('全量重建'),
}

/**
 * 项目设置里文件索引的状态卡：数量、大小、最后更新、上次全量；增量更新 / 全量重建。
 * 状态由服务端推（server/file-index/registry.ts 的 file-index 事件），建立进度跟着走，不轮询
 */
export function FileIndexStatusCard({ projectId }: { projectId: string }) {
  const { openSettings } = useNav()
  const [s, setS] = useState<FileIndexStatus>()
  const [busy, setBusy] = useState<'refresh' | 'rebuild'>()
  useEffect(() => {
    call(C.status, { params: { id: projectId } })
      .then(setS)
      .catch((e) => toast.error((e as Error).message))
    if (demo) return
    const stream = openPageStream()
    stream.on('file-index', (e) => {
      try {
        const m = JSON.parse(e.data) as { projectId: string; status: FileIndexStatus }
        if (m.projectId === projectId) setS(m.status)
      } catch {
        // 坏的一条推送不影响下一条
      }
    })
    return () => stream.close()
  }, [projectId])

  const refresh = async () => {
    setBusy('refresh')
    try {
      const r = await call(C.refresh, { params: { id: projectId }, body: {} })
      toast.success(t('核对了 {n} 个目录：新增 {a} 个、删除 {r} 个文件', { n: r.checked, a: r.added, r: r.removed }))
      setS(await call(C.status, { params: { id: projectId } }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }
  const rebuild = async () => {
    setBusy('rebuild')
    try {
      setS(await call(C.rebuild, { params: { id: projectId }, body: {} }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  if (!s || !s.enabled) return null
  const main = s.roots.find((r) => r.source === 'project') ?? s.roots[0]
  const building = s.state === 'building'
  const prog = s.roots.find((r) => r.progress)?.progress
  const latest = Math.max(0, ...s.roots.map((r) => r.changedAt ?? 0))
  const latestBy = s.roots.find((r) => r.changedAt === latest)?.lastBy
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote">
        {building ? (
          <StatusPill tone="run" spin>
            {t('建立中')}
          </StatusPill>
        ) : s.state === 'error' ? (
          <StatusPill tone="err">{t('出错')}</StatusPill>
        ) : (
          <StatusPill tone="ok">{t('已就绪')}</StatusPill>
        )}
        <span className="font-mono text-muted">
          {t('{files} 个文件', { files: s.files.toLocaleString() })} ·{' '}
          {t('{dirs} 个目录', { dirs: s.dirs.toLocaleString() })} · {formatBytes(s.bytes)}
        </span>
      </div>
      {building && prog && (
        <div className="flex items-center gap-3">
          <Progress
            value={prog.dirs}
            max={prog.expect || prog.dirs * 2 || 1}
            indeterminate={!prog.expect}
            label={t('文件索引建立进度')}
            className="flex-1"
          />
          <span className="shrink-0 font-mono text-xs text-subtle">
            {t('已读 {dirs} 个目录', { dirs: prog.dirs.toLocaleString() })}
          </span>
        </div>
      )}
      {s.state === 'error' && <span className="text-xs text-danger">{s.roots.find((r) => r.error)?.error}</span>}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        {latest > 0 && (
          <span>
            {t('最后更新 {ago}', { ago: ago(latest) })}
            {latestBy && BY[latestBy] ? t('（{by}）', { by: BY[latestBy]() }) : ''}
          </span>
        )}
        {main?.builtAt && (
          <span>
            {t('上次全量 {ago}', { ago: ago(main.builtAt) })}
            {main.buildMs ? t('，用时 {d}', { d: fmtDuration(main.buildMs) }) : ''}
          </span>
        )}
      </div>
      <span className="flex items-center gap-1.5 text-xs text-subtle">
        <Eye className="h-3.5 w-3.5" />
        {main?.watching === 'system'
          ? t('盯着改动：系统文件通知，另外每 10 分钟按目录核对一次')
          : t('盯着改动：不用系统通知，查询时超过 1 分钟没核对就先按目录核对')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={refresh} disabled={!!busy || building}>
          <RefreshCw className={busy === 'refresh' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {t('增量更新')}
        </Button>
        <Button variant="secondary" size="sm" onClick={rebuild} disabled={!!busy || building}>
          <Database className="h-3.5 w-3.5" />
          {t('全量重建')}
        </Button>
        <Button variant="link" className="ml-auto text-xs" onClick={() => openSettings('data')}>
          {t('在「数据」里管理')}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
