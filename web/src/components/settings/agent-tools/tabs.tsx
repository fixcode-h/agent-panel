import type { ReactNode } from 'react'
import { t } from '@shared/i18n'
import { CallLogTab } from './CallLogTab'
import { RoutesTab } from './RoutesTab'

/**
 * 设置 →「Agent 工具」的页签：一个页签一行，按 order 排。加页签只加一行，AgentToolsSection 不按页签名写分支。
 * 「技能」页签（技能按情境推送，另一路在做）排第一，order 用 10；工具路由 20、调用记录 30
 */
export interface AgentToolsTab {
  id: string
  label: () => string
  order: number
  render: () => ReactNode
}

export const AGENT_TOOLS_TABS: AgentToolsTab[] = [
  { id: 'routes', label: () => t('工具路由'), order: 20, render: () => <RoutesTab /> },
  { id: 'calls', label: () => t('调用记录'), order: 30, render: () => <CallLogTab /> },
]

export const agentToolsTabs = () => [...AGENT_TOOLS_TABS].sort((a, b) => a.order - b.order)
