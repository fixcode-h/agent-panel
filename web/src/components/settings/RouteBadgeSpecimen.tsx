import { useState, type ComponentType, type ReactNode } from 'react'
import type { CompName } from '@shared/component-style'
import { KnowledgeTagsSpecimen } from './KnowledgeTagsSpecimen'
import { GrantBadgeSpecimen } from './GrantBadgeSpecimen'
import { Search } from 'lucide-react'
import type { ToolRoute } from '@shared/capability-router/tool-route'
import { t } from '@shared/i18n'
import { RouteBadge, RouteSteps } from '@/components/ui/route-badge'
import { RowShell } from '@/components/tasks/ToolRow'

// 示例数据（路的名字、原因照真实的写，不翻译）
const TEXT: ToolRoute = {
  capability: 'find',
  served: [{ source: 'panel.text', label: '面板按文本找', via: 'panel' }],
  steps: [
    {
      source: 'ue:uetovs.search_symbols',
      label: 'search_symbols',
      via: 'mcp',
      outcome: 'skipped',
      why: '没有接 search_symbols 所在的服务（没装，或服务没开）',
    },
    { source: 'panel.text', label: '面板按文本找', via: 'panel', outcome: 'used', ms: 380 },
  ],
  ms: 406,
}
const LUA: ToolRoute = {
  capability: 'find',
  served: [{ source: 'ue:idea.lua_code', label: 'idea · lua_code', via: 'mcp' }],
  steps: [{ source: 'ue:idea.lua_code', label: 'idea · lua_code', via: 'mcp', outcome: 'used', ms: 120 }],
  ms: 126,
}

/** 设置 → 组件里「工具卡片的路由小标」示例：上一行是收着的，下一行点开看路由步骤 */
export function RouteBadgeSpecimen() {
  const [open, setOpen] = useState(true)
  return (
    <div className="proc-list flex w-full flex-col">
      <RowShell
        glyph={<Search className="h-3.5 w-3.5" />}
        verb={t('查找')}
        title="symbol OnSellAll"
        tail={<RouteBadge route={LUA} />}
        ms={126}
        open={false}
      />
      <RowShell
        glyph={<Search className="h-3.5 w-3.5" />}
        verb={t('查找')}
        title="text BagPanel"
        tail={<RouteBadge route={TEXT} />}
        ms={406}
        open={open}
        onToggle={() => setOpen(!open)}
      >
        <RouteSteps route={TEXT} />
      </RowShell>
    </div>
  )
}

/** 工具行上挂的几种小字（放行小标见 GrantBadgeSpecimen）：下面一行的教训、经验，耗时旁的路由小标。Specimen 由组件页传进来，这里只管内容 */
export function ToolRowTagSpecimens({
  Specimen,
}: {
  Specimen: ComponentType<{ name: string; tune?: CompName[]; children: ReactNode }>
}) {
  return (
    <>
      <Specimen name="KnowledgeTags" tune={['row']}>
        <KnowledgeTagsSpecimen />
      </Specimen>
      <Specimen name="RouteBadge · RouteSteps" tune={['routeBadge']}>
        <RouteBadgeSpecimen />
      </Specimen>
      <Specimen name="GrantBadge · GrantSection · GrantRunRow" tune={['grantBadge']}>
        <GrantBadgeSpecimen />
      </Specimen>
    </>
  )
}
