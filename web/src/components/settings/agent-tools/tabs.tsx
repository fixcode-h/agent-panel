import type { ReactNode } from 'react'
import { t } from '@shared/i18n'
import { CallLogTab } from './CallLogTab'
import { RoutesTab } from './RoutesTab'
import { SkillsTab } from './SkillsTab'

/**
 * 设置 →「Agent 工具」的页签：一个页签一行，按 order 排。加页签只加一行，AgentToolsSection 不按页签名写分支。
 * 「技能」（ADR 0084）排第一，order 10；工具路由 20、调用记录 30（ADR 0084）
 */
export interface AgentToolsTab {
  id: string
  label: () => string
  order: number
  render: () => ReactNode
}

export const AGENT_TOOLS_TABS: AgentToolsTab[] = [
  { id: 'skills', label: () => t('技能'), order: 10, render: () => <SkillsTab /> },
  { id: 'routes', label: () => t('工具路由'), order: 20, render: () => <RoutesTab /> },
  { id: 'calls', label: () => t('调用记录'), order: 30, render: () => <CallLogTab /> },
]

export const agentToolsTabs = () => [...AGENT_TOOLS_TABS].sort((a, b) => a.order - b.order)
