import { useState } from 'react'
import { ArrowUpCircle, Check, Clock, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { isNewerPlugin, type PluginUpdate } from '@shared/plugins/version'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { pluginApi, type InstallPreview, type MarketEntry, type MarketResult } from './api'
import { useMarket } from './market'
import type { PluginRow } from './registry'
import { usePluginUpdates } from './updates'

/** 这个插件在当前市场里的条目（从这个市场仓库装的才算） */
export function marketEntryOf(row: PluginRow, market?: MarketResult): MarketEntry | undefined {
  if (row.source.kind !== 'github' || row.source.ref !== market?.repo) return undefined
  return market.plugins?.find((e) => e.id === row.manifest.id)
}
export const useMarketEntry = (row: PluginRow) => marketEntryOf(row, useMarket().result)

/**
 * 能升到哪个版本：检查更新的结果优先；还没查完时，从当前市场列表里直接比版本
 * （市场仓库里的插件刷新市场就知道有没有新版本，不用等检查更新）。卡片的按钮和「已安装」标题的计数都按它算
 */
export function upgradeFor(
  row: PluginRow,
  updates: Map<string, PluginUpdate>,
  market?: MarketResult,
): PluginUpdate | undefined {
  const u = updates.get(row.manifest.id)
  if (u) return u
  const entry = marketEntryOf(row, market)
  if (entry && isNewerPlugin(entry.version, row.manifest.version))
    return {
      id: row.manifest.id,
      current: row.manifest.version,
      latest: entry.version,
      install: { repo: row.source.ref, id: row.manifest.id },
    }
  return undefined
}
export const useUpgrade = (row: PluginRow) => upgradeFor(row, usePluginUpdates().updates, useMarket().result)

/** 卡片底部的「升级到 vX」：先下载新版本、弹安装确认（写明会不会运行代码），确认后换上，参数保留 */
export function UpgradeButton({ row, onPreview }: { row: PluginRow; onPreview?: (p: InstallPreview) => void }) {
  const u = useUpgrade(row)
  const step = usePluginUpdates().bulk.get(row.manifest.id)
  const [busy, setBusy] = useState(false)
  // 一键更新排着队、正在装或已经装好时，卡片上显示进度（BulkStepLine），不再给单独升级的按钮；失败了留着按钮好重试
  if (step && step.status !== 'failed') return <BulkStepLine status={step.status} to={step.to} />
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
    <Button size="sm" onClick={() => void upgrade()} disabled={busy} data-plugin-update={u.id}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
      {t('升级到 v{v}', { v: u.latest })}
    </Button>
  )
}

/** 一键更新时卡片上的进度：排队、正在更新、已更新 */
function BulkStepLine({ status, to }: { status: 'waiting' | 'updating' | 'done'; to: string }) {
  const Icon = status === 'done' ? Check : status === 'updating' ? Loader2 : Clock
  return (
    <span
      className={cn(
        'inline-flex h-8 items-center gap-1.5 px-1 text-body',
        status === 'done' ? 'text-success' : 'text-subtle',
      )}
      data-plugin-bulk={status}
    >
      <Icon className={cn('h-3.5 w-3.5', status === 'updating' && 'animate-spin')} />
      {status === 'done'
        ? t('已更新到 v{v}', { v: to })
        : status === 'updating'
          ? t('正在更新到 v{v}…', { v: to })
          : t('等待更新到 v{v}', { v: to })}
    </span>
  )
}

/** 一键更新失败的原因，显示在卡片的错误行（和开关、删除的错误同一处） */
export function useBulkError(row: PluginRow) {
  const step = usePluginUpdates().bulk.get(row.manifest.id)
  return step?.status === 'failed' ? t('更新到 v{v} 失败：{error}', { v: step.to, error: step.error ?? '' }) : ''
}
