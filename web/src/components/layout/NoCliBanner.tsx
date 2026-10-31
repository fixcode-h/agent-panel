import { SquareTerminal } from 'lucide-react'
import { useData, useNav } from '@/lib/data'
import { orderClis } from '@shared/settings'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import type { CliStatus, Settings } from '@shared/schema'

/** 没有启用的 CLI 时引导用户去启用哪一个：优先已经装好的，没有就是排在最前面的 */
export function cliToEnable(clis: CliStatus[], settings: Settings | null) {
  const ordered = settings ? orderClis(clis, settings.cliOrder) : clis
  return ordered.find((c) => c.installed) ?? ordered[0]
}

/** 一个 CLI 都没启用时的顶部提示：新装的面板 CLI 默认都不启用，要用户自己去设置里打开一个 */
export function NoCliBanner() {
  const { clis, settings } = useData()
  const { openSettings } = useNav()
  // 检测结果还没回来时不提示，免得一打开就闪一下
  if (!settings || !clis.length || clis.some((c) => c.enabled)) return null
  const target = cliToEnable(clis, settings)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-accent-soft px-4 py-2 text-body text-fg">
      <SquareTerminal className="h-4 w-4 shrink-0 text-accent-text" strokeWidth={2.2} />
      <span className="min-w-0 flex-1">
        <b className="font-medium">{t('还没有启用 Agent')}</b>
        <span className="text-subtle">
          {target.installed
            ? t('：检测到本机已安装 {name}，启用后就能运行角色和工作流。', { name: target.name })
            : t('：先安装并启用一个 Agent，才能运行角色和工作流。')}
        </span>
      </span>
      <Button variant="link" onClick={() => openSettings(`cli:${target.id}`)}>
        {t('去启用 {name}', { name: target.name })}
      </Button>
    </div>
  )
}
