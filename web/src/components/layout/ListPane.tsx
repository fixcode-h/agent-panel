import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/menu'
import { Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

/** 中间的列表栏：标题、新建按钮、搜索框、列表和底部信息 */
export function ListPane({
  title,
  count,
  onNew,
  query,
  onQuery,
  placeholder,
  children,
  footer,
  extra,
}: {
  title: string
  count: number
  onNew: () => void
  query: string
  onQuery: (q: string) => void
  placeholder: string
  children: React.ReactNode
  footer?: React.ReactNode
  /** 新建按钮左边的额外操作 */
  extra?: React.ReactNode
}) {
  return (
    <section
      aria-label={t('{title}列表', { title })}
      className="flex w-full shrink-0 flex-col border-b bg-panel md:h-full md:w-[300px] md:border-r md:border-b-0 lg:w-[320px]"
    >
      <div className="flex flex-col gap-3 px-4 pt-5 pb-3">
        <div className="flex items-center gap-2">
          <h1 className="shrink-0 text-lg font-semibold whitespace-nowrap">{title}</h1>
          <span className="shrink-0 rounded-full border bg-card px-2 text-xs text-muted">{count}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {extra}
            <Button size="sm" onClick={onNew}>
              <Plus className="h-4 w-4" />
              {t('新建')}
            </Button>
          </div>
        </div>
        <label className="relative block">
          <span className="sr-only">{t('搜索')}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={placeholder}
            className="h-[38px] w-full rounded-lg border border-line-strong bg-field pr-3 pl-9 text-[13px] outline-none placeholder:text-subtle focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
          />
        </label>
      </div>
      <div className="flex max-h-[50vh] flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3 md:max-h-none">
        {children}
      </div>
      {footer && <div className="border-t px-4 pt-3 pb-4">{footer}</div>}
    </section>
  )
}

export function ListGroup({ header, children }: { header: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="group/g">
      {header}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

export function GroupHeader({
  label,
  count,
  actions,
}: {
  label: React.ReactNode
  count?: number
  actions?: React.ReactNode
}) {
  return (
    <div className="flex h-9 items-center gap-1.5 px-2 pt-2 text-xs text-subtle">
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="shrink-0">· {count}</span>}
      {actions && (
        <span className="ml-auto flex items-center opacity-0 transition-opacity [@media(hover:none)]:opacity-100 group-hover/g:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
          {actions}
        </span>
      )}
    </div>
  )
}

export function ListItem({
  selected,
  onClick,
  leading,
  title,
  subtitle,
  trailing,
  monoSubtitle = true,
  menu,
}: {
  monoSubtitle?: boolean
  /** 右键菜单的菜单项 */
  menu?: React.ReactNode
  selected: boolean
  onClick: () => void
  leading: React.ReactNode
  title: React.ReactNode
  subtitle: React.ReactNode
  trailing?: React.ReactNode
}) {
  const item = (
    <button
      onClick={onClick}
      aria-current={selected || undefined}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-[10px] border border-transparent p-2.5 text-left transition-colors',
        selected ? 'border-sel-line bg-sel shadow-card' : 'hover:bg-sel/60',
      )}
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        <span className={cn('truncate text-xs text-muted', monoSubtitle && 'font-mono')}>{subtitle}</span>
      </span>
      {trailing}
    </button>
  )
  if (!menu) return item
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  )
}

export function ListEmpty({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-8 text-center text-[13px] text-subtle">{children}</div>
}
