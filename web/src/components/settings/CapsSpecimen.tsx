import { useState } from 'react'
import { Film, Gamepad2, Plug, Sparkles, Table2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { CapabilityCard } from '@/components/ui/capability-card'
import { CapabilityBlockHeader, CapabilityItem, CapabilityItemList } from '@/components/ui/capability-item'
import { AgentLoadSummary } from '@/components/ui/agent-load-summary'

/**
 * 设置 → 组件里的项目能力样例（项目设置 →「能力」和「技能与 MCP」页用的同一套部件）：示例数据不翻译。
 * 外观跟卡片、开关、小标签的调节走
 */
export function CapsSpecimen() {
  const [tables, setTables] = useState(true)
  const [ue, setUe] = useState(false)
  const [mcp, setMcp] = useState(true)
  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <CapabilityCard
          icon={Table2}
          name="表格"
          description="读写、比较游戏配置表；项目工具里出现「表格」页。"
          on={tables}
          onChange={setTables}
          badge={t('推荐')}
          note="找到 Content/Data 下 312 张 xlsx"
          missing="还要选表格目录"
          fixLabel={t('去设置')}
          onFix={() => {}}
        />
        <CapabilityCard
          icon={Gamepad2}
          name="UE"
          description="连上 UE 编辑器读写资源、蓝图，抓性能数据。"
          on={ue}
          onChange={setUe}
          note="没在目录里找到 .uproject"
        />
        <CapabilityCard
          icon={Film}
          name="视频截帧"
          description="把录屏拖进输入框，选几帧当图片发给 Agent。"
          on={false}
          onChange={() => {}}
          disabled
          note={t('插件页里全局关着，先去插件页打开')}
        />
        <AgentLoadSummary
          rows={[
            { label: t('插件'), value: '表格、视频截帧' },
            { label: 'MCP', value: 'playwright + 面板自带' },
            { label: t('技能'), value: '2' },
          ]}
          tools={38}
          tokens={4800}
          allTools={132}
          allTokens={19000}
        />
      </div>
      <CapabilityBlockHeader title="MCP 工具" meta="2 / 3 生效" />
      <CapabilityItemList>
        <CapabilityItem
          icon={Plug}
          name="playwright"
          description="npx @playwright/mcp@0.0.41"
          where="全局 MCP 库"
          whereNote="Claude Code、Codex"
          trailing={<Switch checked={mcp} onCheckedChange={setMcp} aria-label="playwright" />}
          muted={!mcp}
        />
        <CapabilityItem
          icon={Sparkles}
          name="ue-blueprint-review"
          kind={t('技能')}
          description="审查蓝图改动：命名、事件图、性能热点"
          where=".agents/skills"
          whereNote="Claude Code、Codex 能读到"
          trailing={<Badge>{t('项目里')}</Badge>}
        />
        <CapabilityItem
          icon={Plug}
          name="agent-panel"
          description="派子对话、问你、等你操作"
          where="面板自带"
          trailing={<Badge tone="success">{t('始终启用')}</Badge>}
        />
      </CapabilityItemList>
    </div>
  )
}
