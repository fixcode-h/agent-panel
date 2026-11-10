import { useEffect, useState } from 'react'
import { ArrowUpCircle, Loader2, RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import { timeAgo } from '@shared/task'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { pluginApi, type InstallPreview } from './api'
import type { PluginRow } from './registry'
import { canCheck, checkUpdates, usePluginUpdates } from './updates'

/** 「已安装」上方的一行：上次检查的结果和「检查更新」按钮；打开插件页时自动查一次 */
export function UpdateBar({ rows }: { rows: PluginRow[] }) {
  const { updates, errors, checking, checkedAt } = usePluginUpdates()
  const show = canCheck(rows)
  useEffect(() => {
    if (show) void checkUpdates({ auto: true })
  }, [show])
  if (!show) return null
  const n = updates.size
  const summary = checking
    ? t('正在检查更新…')
    : !checkedAt
      ? ''
      : n
        ? t('{n} 个插件有新版本', { n })
        : errors.length
          ? ''
          : t('都是最新版本')
  return (
    <div className="mb-2 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={cn('min-w-0 flex-1 text-xs', n && !checking ? 'text-accent-text' : 'text-subtle')}>
          {summary}
          {checkedAt && !checking && (
            <span className="text-subtle">
              {summary && ' · '}
              {t('上次检查 {time}', { time: timeAgo(checkedAt) })}
            </span>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void checkUpdates()} disabled={checking}>
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
          {t('检查更新')}
        </Button>
      </div>
      {!checking &&
        errors.map((e) => (
          <p key={e.repo} className="text-xs break-all text-danger">
            {e.repo ? t('检查 {repo} 失败：{error}', { repo: e.repo, error: e.error }) : e.error}
          </p>
        ))}
    </div>
  )
}

/** 插件卡片里的升级提示：点「升级」先下载新版本、弹安装确认（写明会不会运行代码），确认后换上，参数保留 */
export function UpdateNotice({ row, onPreview }: { row: PluginRow; onPreview?: (p: InstallPreview) => void }) {
  const { updates } = usePluginUpdates()
  const [busy, setBusy] = useState(false)
  const u = updates.get(row.manifest.id)
  if (!u || !onPreview) return null
  const upgrade = async () => {
    setBusy(true)
    try {
      onPreview(await pluginApi.fromGithub(u.install))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent-soft px-3 py-2" data-plugin-update={u.id}>
      <ArrowUpCircle className="h-4 w-4 shrink-0 text-accent-text" />
      <span className="min-w-0 flex-1 text-body">
        {t('有新版本')} <span className="font-mono font-medium">v{u.latest}</span>
        <span className="text-subtle"> · {t('现在是 v{v}', { v: u.current })}</span>
      </span>
      <Button size="sm" onClick={() => void upgrade()} disabled={busy}>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t('升级到 v{v}', { v: u.latest })}
      </Button>
    </div>
  )
}
