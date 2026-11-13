import { useState } from 'react'
import { Download, ExternalLink, FolderGit, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { pluginApi, type InstallPreview, type MarketEntry } from './api'
import { pluginIcon } from './icon'

/** 「可安装」里的一张卡：和已安装的卡同样的头部，没有开关；底部「安装」和主页 */
export function MarketTile({
  repo,
  entry,
  onPreview,
}: {
  repo: string
  /** 不传：这个仓库没有插件目录，整个仓库当作一个插件 */
  entry?: MarketEntry
  onPreview: (p: InstallPreview) => void
}) {
  const [busy, setBusy] = useState(false)
  const install = async () => {
    setBusy(true)
    try {
      onPreview(await pluginApi.fromGithub({ repo, id: entry?.id }))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const Icon = entry ? pluginIcon(entry.icon) : FolderGit
  return (
    <Card padding="md" className="flex flex-col gap-2" data-market-plugin={entry?.id ?? repo}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sel text-subtle">
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pt-1.5">
          <span className="truncate text-prose font-semibold">{entry?.name ?? repo}</span>
          {entry && <Badge>v{entry.version}</Badge>}
        </div>
      </div>
      <p className="line-clamp-2 text-body leading-relaxed text-muted">
        {entry
          ? entry.description && t(entry.description)
          : t('这个仓库没有插件目录，可以直接把整个仓库当作插件安装。')}
      </p>
      <div className="mt-auto flex items-center gap-1 pt-1">
        <Button size="sm" onClick={() => void install()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {t('安装')}
        </Button>
        {entry?.homepage && (
          <Button size="sm" variant="ghost" onClick={() => window.open(entry.homepage, '_blank', 'noreferrer')}>
            <ExternalLink className="h-3.5 w-3.5" />
            {t('主页')}
          </Button>
        )}
      </div>
    </Card>
  )
}
