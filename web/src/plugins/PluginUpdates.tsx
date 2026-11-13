import { useState } from 'react'
import { ArrowUpCircle, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { isNewerPlugin, type PluginUpdate } from '@shared/plugins/version'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
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
  const [busy, setBusy] = useState(false)
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
