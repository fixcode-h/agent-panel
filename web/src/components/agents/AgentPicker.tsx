import { useState } from 'react'
import { type Agent } from '@shared/schema'
import { useData } from '@/lib/data'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { MenuSearch } from '@/components/ui/menu-search'
import { AgentAvatar } from './AgentAvatar'
import { useAgentView } from '@/lib/agent-view'
import { t } from '@shared/i18n'
import { listableAgents } from '@shared/builtin/core'

/** 从已有 Agent 中选一个，按分类分组，可搜索 */
export function AgentPicker({
  exclude = [],
  onPick,
  onNone,
  noneLabel,
  children,
  align,
}: {
  exclude?: string[]
  onPick: (a: Agent) => void
  /** 选「无」：不用 Agent 角色，直接用 CLI */
  onNone?: () => void
  noneLabel?: string
  children: React.ReactNode
  align?: 'start' | 'end'
}) {
  const { modelOf } = useAgentView()
  const { agents, categories } = useData()
  const [q, setQ] = useState('')
  const pool = listableAgents(agents).filter(
    (a) => !exclude.includes(a.id) && a.name.toLowerCase().includes(q.trim().toLowerCase()),
  )
  const groups = [
    ...categories.filter((c) => c.scope !== 'workflow').map((c) => ({ id: c.id, name: c.name })),
    { id: '', name: t('未分类') },
  ]
    .map((g) => ({ ...g, items: pool.filter((a) => a.categoryId === g.id) }))
    .filter((g) => g.items.length)

  return (
    <Popover onOpenChange={(o) => o && setQ('')}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-[300px]">
        <MenuSearch value={q} onChange={setQ} placeholder={t('搜索角色')} />
        <div className="max-h-72 overflow-y-auto">
          {onNone && (
            <PopoverClose className={menuItem} onClick={onNone}>
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-field text-xs text-subtle">
                —
              </span>
              <span className="truncate">{noneLabel || t('无角色，直接用 Agent')}</span>
            </PopoverClose>
          )}
          {groups.map((g) => (
            <div key={g.id || 'none'}>
              <div className="px-2.5 pt-2 pb-1 text-xs text-subtle">{g.name}</div>
              {g.items.map((a) => (
                <PopoverClose key={a.id} className={menuItem} onClick={() => onPick(a)}>
                  <AgentAvatar icon={a.icon} cli={a.cli} size="sm" dim={!a.enabled} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{a.name}</span>
                    <span className="truncate font-mono text-[0.6875rem] text-subtle">{modelOf(a)}</span>
                  </span>
                </PopoverClose>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2.5 py-3 text-xs text-subtle">{t('没有可选的角色，先去角色页面创建')}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
