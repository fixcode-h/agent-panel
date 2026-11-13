import { Blocks, LayoutDashboard, PanelsTopLeft, Plug, type LucideIcon } from 'lucide-react'
import type { CatalogSource } from '@shared/mcp-catalog/types'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { NavRow } from '@/components/ui/sidebar'
import { pluginIcon } from '@/plugins/icon'
import { usePlugins } from '@/plugins/registry'
import { useMcpCatalog } from './mcp-store'

/**
 * 设置 →「MCP」的左栏入口和二级列表（设计稿：MCP能力菜单）：
 * 总览与自检（页 id 就是 mcp），面板自带的两项、开着的插件各一项、你装的 MCP。
 * 设置页一打开就要画左栏，这部分不带页面本身（McpSection 按需加载）
 */
export const MCP = 'mcp'
const PREFIX = 'mcp:'
export const mcpPageId = (source: string) => PREFIX + source
export const mcpPage = (id: string) => id === MCP || id.startsWith(PREFIX)
/** 只是二级列表里的页（左栏不单独列出） */
export const mcpSub = (id: string) => id.startsWith(PREFIX)
export const MINE = 'mine'

interface McpPage {
  id: string
  label: string
  icon: LucideIcon
  group?: string
}

/** 二级列表的各页：插件按开着的列（不等目录读完），名字和图标取清单 */
export function useMcpPages(): McpPage[] {
  const { rows } = usePlugins()
  return [
    { id: mcpPageId('panel'), label: t('Agent 面板'), icon: PanelsTopLeft, group: t('面板自带') },
    { id: mcpPageId('app'), label: t('操控软件'), icon: Blocks },
    ...rows
      .filter((r) => r.enabled)
      .map((r, i) => ({
        id: mcpPageId(`plugin:${r.manifest.id}`),
        label: r.manifest.name,
        icon: pluginIcon(r.manifest.icon),
        ...(i === 0 && { group: t('插件') }),
      })),
    { id: mcpPageId(MINE), label: t('你装的 MCP'), icon: Plug, group: t('你装的') },
  ]
}

/** 一个来源有几个能力（工具 + 动作）、几个没写使用时机 */
export function sourceCounts(s: CatalogSource) {
  const tools = s.servers.flatMap((x) => x.tools)
  return { n: tools.length + s.actions.length, missing: tools.filter((x) => !x.guide).length }
}

export function McpNav({ current, onSection }: { current: string; onSection: (id: string) => void }) {
  const pages = useMcpPages()
  const { data } = useMcpCatalog()
  const row = (p: McpPage) => {
    const on = p.id === current
    const src = data?.sources.find((s) => mcpPageId(s.id) === p.id)
    const c = src && sourceCounts(src)
    const n = p.id === mcpPageId(MINE) ? data?.mine : c?.n
    return (
      <div key={p.id} className="contents">
        {p.group && (
          <span className="hidden px-2.5 pt-3 pb-1.5 text-caption font-medium tracking-wide text-subtle md:flex">
            {p.group}
          </span>
        )}
        <NavRow
          onClick={() => onSection(p.id)}
          on={on}
          className="w-auto shrink-0 whitespace-nowrap md:w-full"
          icon={<p.icon className={cn('h-4 w-4 shrink-0', on && 'text-accent-text')} strokeWidth={2.2} />}
          label={p.label}
          trailing={
            <span className="hidden items-center gap-1.5 md:flex">
              {!!c?.missing && (
                <span title={t('有工具没写「什么时候用」')} className="h-1.5 w-1.5 rounded-full bg-warning" />
              )}
              {src?.error && <span title={src.error} className="h-1.5 w-1.5 rounded-full bg-danger" />}
              {n !== undefined && <span className="text-caption text-subtle tabular-nums">{n}</span>}
            </span>
          }
        />
      </div>
    )
  }
  return (
    <nav
      aria-label={t('MCP 能力')}
      className="flex shrink-0 gap-0.5 overflow-x-auto border-b p-2 md:w-[232px] md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-3 md:pt-6"
    >
      {row({ id: MCP, label: t('总览与自检'), icon: LayoutDashboard })}
      {pages.map(row)}
    </nav>
  )
}
