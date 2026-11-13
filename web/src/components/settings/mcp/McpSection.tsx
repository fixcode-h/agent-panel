import { Plug } from 'lucide-react'
import { t } from '@shared/i18n'
import { useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { CapabilityServerHeader } from '@/components/ui/capability-server-header'
import { MCP, MINE, mcpPageId } from './McpNav'
import { McpOverview } from './McpOverview'
import { McpSourcePage } from './McpSourcePage'
import { useMcpCatalog } from './mcp-store'

/** 设置 →「MCP」的内容区：总览、一个来源的页、你装的 MCP（设计稿：MCP能力菜单） */
export function McpSection({ section, onSection }: { section: string; onSection: (id: string) => void }) {
  const { data, loading } = useMcpCatalog()
  if (section === MCP) return <McpOverview onSection={onSection} />
  if (section === mcpPageId(MINE)) return <MinePage n={data?.mine} />
  const src = data?.sources.find((s) => mcpPageId(s.id) === section)
  if (!src) return loading ? null : <EmptyPanel size="md">{t('这个插件已经关掉了')}</EmptyPanel>
  return <McpSourcePage s={src} />
}

/** 你自己装的 MCP 在图标栏的「MCP 工具」页管，这里只说明并给入口 */
function MinePage({ n }: { n?: number }) {
  const { go, closeSettings } = useNav()
  return (
    <div className="flex max-w-[880px] flex-col gap-4 pt-1">
      <CapabilityServerHeader
        icon={Plug}
        name={t('你装的 MCP')}
        meta={n === undefined ? undefined : t('{n} 个', { n })}
        summary={t(
          '你自己写进各 CLI 配置的 MCP 服务（claude mcp add 这类加的也算）。它们由 CLI 自己连接，说明由服务自己提供，面板不改写。',
        )}
      />
      <Button
        variant="secondary"
        className="w-fit gap-1.5"
        onClick={() => {
          closeSettings()
          go({ page: 'mcp' })
        }}
      >
        <Plug className="h-4 w-4" />
        {t('打开「MCP 工具」页')}
      </Button>
    </div>
  )
}
