import { SquareSlash, TestTube2, Webhook } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PluginManifest } from '@shared/plugins/types'
import { Hint } from '@/components/ui/hint'

/**
 * 插件带进面板机制里的东西（插件接口 3）：钩子、测试步骤、「/」命令各几个，悬停看名字。
 * 插件卡片上用；打开插件后它们分别出现在设置 →「钩子」、项目设置 →「测试步骤」和输入框的「/」菜单里
 */
export function PluginContributions({
  manifest,
}: {
  manifest: Pick<PluginManifest, 'hooks' | 'testSteps' | 'commands'>
}) {
  const items = [
    { icon: Webhook, label: t('钩子'), names: (manifest.hooks ?? []).map((h) => t(h.name)) },
    { icon: TestTube2, label: t('测试步骤'), names: (manifest.testSteps ?? []).map((s) => t(s.name)) },
    { icon: SquareSlash, label: t('命令'), names: (manifest.commands ?? []).map((c) => `/${c.name}`) },
  ].filter((x) => x.names.length)
  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
      <span>{t('带来：')}</span>
      {items.map((x) => (
        <Hint key={x.label} content={x.names.join(t('、'))}>
          <span className="inline-flex cursor-default items-center gap-1 hover:text-fg">
            <x.icon className="h-3.5 w-3.5" />
            {x.label} {x.names.length}
          </span>
        </Hint>
      ))}
    </div>
  )
}
