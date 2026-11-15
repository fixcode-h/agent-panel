import { Globe, Plug, Server, SquareSlash, TestTube2, Variable, Webhook } from 'lucide-react'
import { t } from '@shared/i18n'
import type { PluginManifest } from '@shared/plugins/types'
import { Hint } from '@/components/ui/hint'

/**
 * 插件带进面板机制里的东西（插件接口 3）：钩子、测试步骤、「/」命令各几个，悬停看名字。
 * 插件卡片上用；打开插件后它们分别出现在设置 →「钩子」、项目设置 →「测试步骤」和输入框的「/」菜单里。
 * 接口 11 的声明式字段（环境变量、外部 MCP、托管进程、网页页面）也列在这里：装之前就看得到它会给 Agent 带什么、在本机起什么
 */
export function PluginContributions({
  manifest,
}: {
  manifest: Pick<PluginManifest, 'hooks' | 'testSteps' | 'commands'> &
    Partial<Pick<PluginManifest, 'env' | 'mcp' | 'services' | 'webPages'>>
}) {
  const env = Object.entries(manifest.env ?? {}).map(([k, v]) =>
    typeof v === 'string' ? k : t('PATH 前置 {dirs}', { dirs: v.prepend.join(t('、')) }),
  )
  const items = [
    { icon: Webhook, label: t('钩子'), names: (manifest.hooks ?? []).map((h) => t(h.name)) },
    { icon: TestTube2, label: t('测试步骤'), names: (manifest.testSteps ?? []).map((s) => t(s.name)) },
    { icon: SquareSlash, label: t('命令'), names: (manifest.commands ?? []).map((c) => `/${c.name}`) },
    { icon: Variable, label: t('环境变量'), names: env },
    {
      icon: Plug,
      label: t('MCP 服务'),
      names: (manifest.mcp ?? []).map((m) => m.name),
      // 每轮注入；CLI 定义里没有每轮注入的 Agent（例如 Pi）只能写进它的全局配置，所有项目都会加载
      note: t('每轮对话注入；不支持每轮注入的 Agent 退回全局写入'),
    },
    { icon: Server, label: t('托管进程'), names: (manifest.services ?? []).map((s) => s.id) },
    { icon: Globe, label: t('网页页面'), names: (manifest.webPages ?? []).map((w) => t(w.label)) },
  ].filter((x) => x.names.length)
  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
      <span>{t('带来：')}</span>
      {items.map((x) => (
        <Hint
          key={x.label}
          content={
            'note' in x && x.note ? (
              <span className="flex flex-col gap-0.5">
                <span>{x.names.join(t('、'))}</span>
                <span className="text-subtle">{x.note}</span>
              </span>
            ) : (
              x.names.join(t('、'))
            )
          }
        >
          <span className="inline-flex cursor-default items-center gap-1 hover:text-fg">
            <x.icon className="h-3.5 w-3.5" />
            {x.label} {x.names.length}
          </span>
        </Hint>
      ))}
    </div>
  )
}
