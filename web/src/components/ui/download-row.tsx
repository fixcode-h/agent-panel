import type { ReactNode } from 'react'
import { FileDown } from 'lucide-react'
import { t } from '@shared/i18n'
import { formatBytes } from '@shared/memory'
import { cn } from '@/lib/utils'
import { Progress } from './progress'
import { StatusPill, type StatusTone } from './status-pill'

export type DownloadRowState = 'running' | 'done' | 'failed' | 'cancelled'

const TONE: Record<DownloadRowState, StatusTone> = { running: 'run', done: 'ok', failed: 'err', cancelled: 'idle' }

/**
 * 一条下载：文件名、状态、进度条、已下 / 总大小和速度、正在用的来源，失败时的原因和放弃过的来源。
 * 小工具「GitHub 加速下载」的下载记录用它；以后别的下载列表（模型、插件包）也用这一个，
 * 样子在「设置 · 组件」里看得到。actions 放行尾的按钮（取消、打开文件夹、移除）
 */
export function DownloadRow({
  name,
  detail,
  state,
  received,
  total,
  speed,
  source,
  attempts,
  error,
  actions,
  className,
}: {
  name: string
  /** 文件名下面的一行小字：存在哪 */
  detail?: string
  state: DownloadRowState
  received: number
  total?: number
  /** 字节 / 秒；下载中才显示 */
  speed?: number
  /** 正在用（或最后用成）的来源 */
  source?: string
  /** 放弃过的来源和原因 */
  attempts?: { source: string; error: string }[]
  error?: string
  actions?: ReactNode
  className?: string
}) {
  const label = {
    running: t('下载中'),
    done: t('已完成'),
    failed: t('失败'),
    cancelled: t('已取消'),
  }[state]
  const size = total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received)
  return (
    <div
      data-download-row={state}
      className={cn('flex flex-col gap-2 rounded-lg px-3 py-2.5 hover:bg-sel/40', className)}
    >
      <div className="flex min-w-0 items-center gap-3">
        <FileDown className="h-4 w-4 shrink-0 text-subtle" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-body font-medium" title={name}>
              {name}
            </span>
            <StatusPill tone={TONE[state]} spin={state === 'running'}>
              {label}
            </StatusPill>
          </span>
          {detail && (
            <span className="truncate font-mono text-caption text-subtle" title={detail}>
              {detail}
            </span>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {state === 'running' && (
        <Progress size="xs" label={t('下载进度')} value={received} max={total || 1} indeterminate={!total} tone="run" />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 pl-7 text-caption text-muted">
        <span className="tabular-nums">{size}</span>
        {state === 'running' && speed !== undefined && (
          <span className="tabular-nums">{t('{speed}/秒', { speed: formatBytes(speed) })}</span>
        )}
        {source && <span className="truncate">{t('来源：{source}', { source })}</span>}
      </div>
      {error && <p className="pl-7 text-caption break-all text-danger">{error}</p>}
      {!error && !!attempts?.length && (
        <ul className="flex flex-col gap-0.5 pl-7 text-caption text-subtle">
          {attempts.map((a, i) => (
            <li key={i} className="truncate" title={a.error}>
              {t('已换掉 {source}：{error}', a)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
