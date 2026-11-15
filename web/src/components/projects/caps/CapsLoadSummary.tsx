import type { CapabilityPluginRow } from '@shared/projects/capability-probe'
import type { ProjectCapabilities } from '@shared/projects/capabilities'
import { sourceCost } from '@shared/mcp-catalog/cost'
import { t } from '@shared/i18n'
import { AgentLoadSummary } from '@/components/ui/agent-load-summary'
import { useMcpCatalog } from '@/components/settings/mcp/mcp-store'
import { itemOn, type CapItem } from './caps-items'

/**
 * 能力页右栏「交给 Agent 的」：按草稿里的开关现算。工具数和 tokens 来自 MCP 能力目录（设置 →「MCP」同一份）：
 * 面板自带的始终算，全局生效的插件开着就算，按项目的插件看这个项目打开了没有；全局 MCP 库里的工具
 * 要连上服务才知道有几个，只列名字不算个数
 */
export function CapsLoadSummary({
  rows,
  caps,
  mcp,
  skills,
}: {
  rows: CapabilityPluginRow[]
  caps: Partial<ProjectCapabilities> | undefined
  mcp: CapItem[]
  skills: CapItem[]
}) {
  const { data } = useMcpCatalog()
  const projectPlugins = new Set(rows.map((r) => r.id))
  const sources = data?.sources ?? []
  const pluginId = (id: string) => (id.startsWith('plugin:') ? id.slice(7) : '')
  const counted = sources.filter((s) => {
    const id = pluginId(s.id)
    return !id || !projectPlugins.has(id) || !!caps?.plugins?.includes(id)
  })
  const sum = (list: typeof sources) =>
    list.map(sourceCost).reduce((a, b) => ({ tools: a.tools + b.tools, tokens: a.tokens + b.tokens }), {
      tools: 0,
      tokens: 0,
    })
  const now = sum(counted)
  const all = sum(sources)
  // 插件：按项目的打开了的 + 全局生效、开着的（全局的写在后面）
  const names = [
    ...rows.filter((r) => caps?.plugins?.includes(r.id)).map((r) => t(r.name)),
    ...sources.filter((s) => s.kind === 'plugin' && !projectPlugins.has(pluginId(s.id))).map((s) => t(s.name)),
  ]
  const mcpOn = mcp.filter((x) => x.scope !== 'always' && itemOn(x, caps)).map((x) => x.name)
  const skillsOn = skills.filter((x) => itemOn(x, caps)).length
  return (
    <AgentLoadSummary
      rows={[
        { label: t('插件'), value: names.join(t('、')) || t('无') },
        {
          label: 'MCP',
          value: mcpOn.length ? t('{names} + 面板自带', { names: mcpOn.join(t('、')) }) : t('面板自带'),
        },
        { label: t('技能'), value: t('{n} 个', { n: skillsOn }) },
      ]}
      tools={now.tools}
      tokens={now.tokens}
      allTools={all.tools}
      allTokens={all.tokens}
    />
  )
}
