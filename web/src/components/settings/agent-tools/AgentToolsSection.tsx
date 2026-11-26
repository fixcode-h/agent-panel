import { useState, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { SkillsTab } from './SkillsTab'

/**
 * 设置 →「Agent 工具」（设计稿《技能由面板推送》第五部分）：面板替 Agent 管的技能和工具调用，一页一个页签。
 * 页签是一张小注册表：加一页只加一行（「调用记录」「工具路由」以后加在这里），页面本身不按页签名写分支
 */
export interface AgentToolsTab {
  id: string
  label: () => string
  render: () => ReactNode
}

export const AGENT_TOOLS_TABS: AgentToolsTab[] = [{ id: 'skills', label: () => t('技能'), render: () => <SkillsTab /> }]

export function AgentToolsSection({ tabs = AGENT_TOOLS_TABS }: { tabs?: AgentToolsTab[] }) {
  const [cur, setCur] = useState(tabs[0]?.id ?? '')
  const tab = tabs.find((x) => x.id === cur) ?? tabs[0]
  return (
    <div className="flex flex-col gap-4" data-agent-tools={tab?.id}>
      <TabBar label={t('Agent 工具页签')} variant="underline">
        {tabs.map((x) => (
          <TabItem key={x.id} active={x.id === tab?.id} onSelect={() => setCur(x.id)}>
            {x.label()}
          </TabItem>
        ))}
      </TabBar>
      {tab?.render()}
    </div>
  )
}
