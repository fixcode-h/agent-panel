/**
 * 「对话」来源要分析的项目：加进来的项目留在面板上（存在服务端，下次打开还在），
 * 不用再挑对话，提炼时取这些项目在所选时间段内执行过的全部对话。
 */
import { useMemo, useState } from 'react'
import { FolderKanban, Plus, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { MenuSearch } from '@/components/ui/menu-search'
import { Popover, PopoverContent, PopoverTrigger, menuItem } from '@/components/ui/menu'
import { cn } from '@/lib/utils'

export function ProjectShelf({
  projects,
  ids,
  counts,
  disabled,
  onChange,
}: {
  projects: { id: string; name: string }[]
  /** 已加入的项目（顺序就是报告里分节的顺序） */
  ids: string[]
  /** 各项目在当前时间段里执行过几条对话：提炼前就让人看出哪个项目这段时间没事可写 */
  counts: Map<string, number>
  disabled?: boolean
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rest = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter((p) => !ids.includes(p.id) && (!q || p.name.toLowerCase().includes(q)))
  }, [projects, ids, query])
  const added = ids.map((id) => projects.find((p) => p.id === id)).filter((p): p is { id: string; name: string } => !!p)

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={t('要总结的项目')} role="group">
      {added.map((p) => {
        const n = counts.get(p.id) ?? 0
        return (
          <span
            key={p.id}
            data-summary-project
            className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-card pr-1 pl-2.5 text-body"
          >
            <FolderKanban className="h-3.5 w-3.5 text-subtle" />
            <span className="max-w-[200px] truncate">{p.name}</span>
            <span
              className={cn('text-xs tabular-nums', n ? 'text-subtle' : 'text-warning')}
              title={n ? t('这段时间 {n} 个对话', { n }) : t('这段时间没有对话')}
            >
              {n}
            </span>
            <IconButton
              size="2xs"
              icon={X}
              label={t('移除项目 {name}', { name: p.name })}
              disabled={disabled}
              onClick={() => onChange(ids.filter((x) => x !== p.id))}
            />
          </span>
        )
      })}
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) setQuery('')
        }}
      >
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" disabled={disabled} className="border border-dashed border-line-strong">
            <Plus className="h-3.5 w-3.5" />
            {t('添加项目')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[260px] p-1" align="start">
          <MenuSearch value={query} onChange={setQuery} placeholder={t('搜索项目')} />
          <div className="max-h-[280px] overflow-y-auto">
            {!rest.length ? (
              <p className="px-2.5 py-3 text-xs text-subtle">
                {projects.length ? t('没有可添加的项目') : t('还没有项目，先在侧栏添加一个项目。')}
              </p>
            ) : (
              rest.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={menuItem}
                  onClick={() => {
                    onChange([...ids, p.id])
                    setOpen(false)
                    setQuery('')
                  }}
                >
                  <FolderKanban className="h-4 w-4 text-subtle" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {!!counts.get(p.id) && <span className="text-xs text-subtle tabular-nums">{counts.get(p.id)}</span>}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
