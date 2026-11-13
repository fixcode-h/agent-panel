import { useState } from 'react'
import type { Audience, CatalogAction, CatalogServer, CatalogSource, CatalogTool } from '@shared/mcp-catalog/types'
import { AUDIENCES } from '@shared/mcp-catalog/types'
import { t } from '@shared/i18n'
import { Segmented } from '@/components/ui/segmented'
import { StatusPill } from '@/components/ui/status-pill'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { CapabilityGroup, CapabilityRow, audienceLabel, effectLabel } from '@/components/ui/capability-row'
import { CapabilityServerHeader } from '@/components/ui/capability-server-header'
import { pluginIcon } from '@/plugins/icon'
import { sourceIcon } from './source-icon'

type GroupBy = 'use' | 'effect' | 'who'

/** 一个来源的页（设置 →「MCP」的二级页）：每个 MCP 服务一个头 + 工具列表，有面板动作的再列一段 */
export function McpSourcePage({ s }: { s: CatalogSource }) {
  const [by, setBy] = useState<GroupBy>('use')
  const Icon = s.kind === 'plugin' ? pluginIcon(s.icon ?? '') : sourceIcon(s.kind)
  const hasTools = s.servers.some((x) => x.tools.length)
  return (
    <div className="flex max-w-[960px] flex-col gap-6 pt-1">
      {s.error && <p className="text-body text-danger">{s.error}</p>}
      {s.servers.map((srv) => (
        <div key={srv.name} className="flex flex-col gap-5">
          <CapabilityServerHeader
            icon={Icon}
            name={s.name}
            meta={[
              s.kind === 'plugin' ? t('插件 {v}', { v: s.version ?? '' }) : t('面板自带'),
              t('MCP 服务 {name}', { name: srv.name }),
            ].join(' · ')}
            status={
              s.kind === 'panel' ? (
                <StatusPill tone="ok">{t('总是挂')}</StatusPill>
              ) : (
                <StatusPill tone="ok">{t('插件已开启')}</StatusPill>
              )
            }
            summary={srv.summary || s.summary}
            rows={[{ label: t('什么时候挂'), value: srv.attach }]}
            hint={srv.hint}
          />
          {srv.error && <p className="text-body text-danger">{srv.error}</p>}
          {srv.tools.length > 0 && (
            <>
              <Segmented
                size="sm"
                label={t('分组')}
                value={by}
                onChange={setBy}
                options={[
                  { id: 'use', label: t('按用途') },
                  { id: 'effect', label: t('按会不会改东西') },
                  ...(s.kind === 'panel' ? [{ id: 'who' as const, label: t('按对话类型') }] : []),
                ]}
              />
              <ToolList server={srv} by={by} />
            </>
          )}
        </div>
      ))}
      {s.kind === 'app' && (
        <CapabilityServerHeader
          icon={Icon}
          name={s.name}
          meta={t('面板自带 · 经 app_actions / app_do')}
          summary={s.summary}
        />
      )}
      {s.actions.length > 0 && (
        <ActionList actions={s.actions} title={s.kind === 'app' ? '' : t('面板动作（经 app_do）')} />
      )}
      {!hasTools && !s.actions.length && !s.error && (
        <EmptyPanel size="md">{t('这个插件没有给 Agent 的工具或面板动作')}</EmptyPanel>
      )}
    </div>
  )
}

/** 按选的方式分组：用途取声明的 group；会不会改东西取第一个徽标；对话类型一个工具可以在几组里 */
function groupTools(tools: CatalogTool[], by: GroupBy): [string, CatalogTool[]][] {
  const out = new Map<string, CatalogTool[]>()
  const put = (k: string, x: CatalogTool) => out.set(k, [...(out.get(k) ?? []), x])
  for (const x of tools) {
    if (by === 'use') put(x.guide?.group || t('其他'), x)
    else if (by === 'effect') put(x.effects[0] ? effectLabel(x.effects[0]) : t('没声明'), x)
    else for (const a of x.audience ?? []) put(a, x)
  }
  if (by === 'who') return AUDIENCES.filter((a) => out.has(a)).map((a: Audience) => [audienceLabel(a), out.get(a)!])
  return [...out]
}

function ToolList({ server, by }: { server: CatalogServer; by: GroupBy }) {
  return (
    <div className="flex flex-col gap-5">
      {groupTools(server.tools, by).map(([title, list]) => (
        <CapabilityGroup key={title} title={title} count={list.length}>
          {list.map((x) => (
            <CapabilityRow
              key={x.name}
              title={x.title}
              name={x.name}
              summary={x.guide?.summary}
              useWhen={x.guide?.useWhen}
              avoidWhen={x.guide?.avoidWhen}
              effects={x.effects}
              tags={x.deferred ? [t('收进 more_tools')] : undefined}
              audience={by === 'who' ? undefined : x.audience}
              description={x.description}
              params={x.params}
              missing={!x.guide}
            />
          ))}
        </CapabilityGroup>
      ))}
    </div>
  )
}

const LEVEL = { read: 'read', write: 'edit', danger: 'danger' } as const

function ActionList({ actions, title }: { actions: CatalogAction[]; title: string }) {
  const groups = new Map<string, CatalogAction[]>()
  for (const a of actions) groups.set(a.group, [...(groups.get(a.group) ?? []), a])
  return (
    <div className="flex flex-col gap-5">
      {title && <h3 className="text-body font-semibold">{title}</h3>}
      {[...groups].map(([g, list]) => (
        <CapabilityGroup key={g} title={g} count={list.length}>
          {list.map((a) => (
            <CapabilityRow
              key={a.name}
              title={a.title}
              name={a.name}
              summary={a.description}
              useWhen={a.useWhen}
              avoidWhen={a.avoidWhen}
              effects={[LEVEL[a.level]]}
              description=""
            />
          ))}
        </CapabilityGroup>
      ))}
    </div>
  )
}
