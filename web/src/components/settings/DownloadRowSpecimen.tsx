import { t } from '@shared/i18n'
import { DownloadRow } from '@/components/ui/download-row'

/** 「设置 · 组件」里的下载行样张：下载中（换过一次来源）、完成、失败三种 */
export function DownloadRowSpecimen() {
  return (
    <div className="flex w-full max-w-xl flex-col">
      <DownloadRow
        name="app-v1.2.0.zip"
        detail="~/Downloads/app-v1.2.0.zip"
        state="running"
        received={18_400_000}
        total={52_000_000}
        speed={6_300_000}
        source={t('gh-proxy 加速（IPv6）')}
        attempts={[{ source: t('原地址'), error: t('{n} 秒没有收到数据', { n: 60 }) }]}
      />
      <DownloadRow name="catalog.json" state="done" received={4_200} total={4_200} source="jsDelivr" />
      <DownloadRow
        name="repo-HEAD.zip"
        state="failed"
        received={0}
        error={t(
          '下载失败，试过的来源都不行：{list}。可以换一个来源，或在「设置 · 网络与代理 · GitHub 下载来源」里加镜像前缀。',
          {
            list: 'GitHub：ECONNRESET',
          },
        )}
      />
    </div>
  )
}
