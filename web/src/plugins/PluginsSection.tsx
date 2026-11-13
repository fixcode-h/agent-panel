import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Group } from '@/components/settings/parts'
import { pluginApi, type InstallPreview } from './api'
import { InstallConfirm } from './InstallConfirm'
import { MarketBar } from './MarketBar'
import { MarketTile } from './MarketTile'
import { PluginCard } from './PluginCard'
import { upgradeFor } from './PluginUpdates'
import { openMarket, useMarket } from './market'
import { loadPlugins, usePlugins, type PluginRow } from './registry'
import { canCheck, checkUpdates, usePluginUpdates } from './updates'

/**
 * 设置 →「插件」（ADR 0059）：一份卡片列表，分「已安装」和「可安装」两段，装过的不在市场里重复出现。
 * 已安装的卡片上直接开关、进参数、升级；可安装的是当前插件市场里还没装的。
 * 市场结果服务端缓存着，打开先显示缓存，太旧才后台重读；顶上一行换市场仓库、刷新、其他方式安装。
 * 安装一律先预览：服务端下载、校验好清单，弹窗写明来源、版本、会不会在本机运行代码，用户确认后才写进去。
 */
export function PluginsSection() {
  const { rows, broken, loaded } = usePlugins()
  const { result, error } = useMarket()
  const [preview, setPreview] = useState<InstallPreview>()
  useEffect(() => void loadPlugins().catch(() => {}), [])
  useEffect(() => void openMarket(), [])
  // 打开插件页时查一次更新（十分钟内不重复查），之后靠「刷新」
  const checkable = canCheck(rows)
  useEffect(() => {
    if (checkable) void checkUpdates({ auto: true })
  }, [checkable])
  const available = (result?.plugins ?? []).filter((e) => !rows.some((r) => r.manifest.id === e.id))
  return (
    <>
      <p className="text-body leading-relaxed text-subtle">
        {t(
          '插件给面板加上一组能力（工具、技能、角色、工作流、页面），装在数据目录里，可以随时关掉或删除，删掉后面板其他功能不受影响。',
        )}
      </p>
      <MarketBar onPreview={setPreview} />
      <Group title={t('已安装')} plain aside={<InstalledAside rows={rows} n={rows.length + broken.length} />}>
        {!loaded ? (
          <p className="text-body text-subtle">{t('读取中…')}</p>
        ) : rows.length + broken.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {rows.map((r) => (
              <PluginCard key={r.manifest.id} row={r} onPreview={setPreview} />
            ))}
            {broken.map((b) => (
              <BrokenCard key={b.id} id={b.id} error={b.error} />
            ))}
          </div>
        ) : (
          <EmptyPanel as="div" size="md" className="text-body text-subtle">
            {t('还没有安装插件。从下面挑一个，或者用「其他方式安装」上传插件压缩包。')}
          </EmptyPanel>
        )}
      </Group>
      <Group title={t('可安装')} plain aside={result?.plugins && <span>· {available.length}</span>}>
        {!result ? (
          error ? (
            <p className="text-xs break-all text-danger">{error}</p>
          ) : (
            <p className="text-body text-subtle">{t('读取中…')}</p>
          )
        ) : result.plugins === null ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <MarketTile repo={result.repo} onPreview={setPreview} />
          </div>
        ) : available.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {available.map((e) => (
              <MarketTile key={e.id} repo={result.repo} entry={e} onPreview={setPreview} />
            ))}
          </div>
        ) : (
          <p className="pl-1 text-body text-subtle">
            {result.plugins.length ? t('这个市场里的插件都装好了。') : t('这个仓库的插件目录是空的。')}
          </p>
        )}
        {result && error && <p className="mt-2 text-xs break-all text-danger">{error}</p>}
      </Group>
      <InstallConfirm preview={preview} onClose={() => setPreview(undefined)} />
    </>
  )
}

/** 「已安装」标题后面：个数，有新版本时写几个 */
function InstalledAside({ rows, n }: { rows: PluginRow[]; n: number }) {
  const { updates } = usePluginUpdates()
  const { result } = useMarket()
  const newer = rows.filter((r) => upgradeFor(r, updates, result)).length
  return (
    <>
      <span>· {n}</span>
      {!!newer && <span className="font-normal text-accent-text">· {t('{n} 个有新版本', { n: newer })}</span>}
    </>
  )
}

/** 读不出来的插件（目录坏了、清单不对、要求更新的面板）：只能删 */
function BrokenCard({ id, error }: { id: string; error: string }) {
  return (
    <Card padding="md" className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-danger/10 text-danger">
          <ShieldAlert className="h-4.5 w-4.5" />
        </span>
        <p className="min-w-0 flex-1 pt-1.5 text-prose font-semibold">{id}</p>
      </div>
      <p className="text-xs break-all text-danger">{error}</p>
      <div className="mt-auto pt-1">
        <Button
          size="sm"
          variant="danger-outline"
          onClick={() =>
            void pluginApi
              .remove(id)
              .then(() => loadPlugins())
              .catch((e: Error) => toast.error(e.message))
          }
        >
          {t('删除')}
        </Button>
      </div>
    </Card>
  )
}
