import { useState } from 'react'
import { t } from '@shared/i18n'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { agentToolsTabs } from './tabs'

/**
 * 设置 →「Agent 工具」（ADR 0083）：技能、工具路由、调用记录几个页签。页签来自注册表（./tabs.tsx），默认打开第一个
 */
export function AgentToolsSection() {
  const tabs = agentToolsTabs()
  const [cur, setCur] = useState(tabs[0]?.id ?? '')
  const tab = tabs.find((x) => x.id === cur) ?? tabs[0]
  return (
    <div className="flex flex-col gap-4">
      <TabBar label={t('Agent 工具')} variant="underline">
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
