import { useState } from 'react'
import { DEFAULT_AGENT_ID, type Agent } from '@shared/schema'
import { useData } from '@/lib/data'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { AgentAvatar } from './AgentAvatar'
import { useAgentView } from '@/lib/agent-view'
import { t } from '@shared/i18n'

/** 从已有 Agent 中选一个，按分类分组，可搜索 */
export function AgentPicker({
  exclude = [],
  onPick,
  children,
  align,
}: {
  exclude?: string[]
  onPick: (a: Agent) => void
  children: React.ReactNode
  align?: 'start' | 'end'
}) {
  const { modelOf } = useAgentView()
  const { agents, categories } = useData()
  const [q, setQ] = useState('')
  const pool = agents.filter((a) => !exclude.includes(a.id) && a.name.toLowerCase().includes(q.trim().toLowerCase()))
  const groups = [
    { id: DEFAULT_AGENT_ID, name: t('默认'), items: pool.filter((a) => a.id === DEFAULT_AGENT_ID) },
    ...[...categories.map((c) => ({ id: c.id, name: c.name })), { id: '', name: t('未分类') }].map((g) => ({
      ...g,
      items: pool.filter((a) => a.id !== DEFAULT_AGENT_ID && a.categoryId === g.id),
    })),
  ].filter((g) => g.items.length)

  return (
    <Popover onOpenChange={(o) => o && setQ('')}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-[300px]">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('搜索 Agent')}
          className="mb-1 h-9 w-full rounded-lg border-0 bg-field px-2.5 text-[13px] outline-none placeholder:text-subtle"
        />
        <div className="max-h-72 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.id || 'none'}>
              <div className="px-2.5 pt-2 pb-1 text-xs text-subtle">{g.name}</div>
              {g.items.map((a) => (
                <PopoverClose key={a.id} className={menuItem} onClick={() => onPick(a)}>
                  <AgentAvatar icon={a.icon} cli={a.cli} size="sm" dim={!a.enabled} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{a.name}</span>
                    <span className="truncate font-mono text-[11px] text-subtle">{modelOf(a)}</span>
                  </span>
                </PopoverClose>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2.5 py-3 text-xs text-subtle">{t('没有可选的 Agent，先去 Agent 页面创建')}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
