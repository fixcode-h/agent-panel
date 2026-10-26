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
  tabs,
  hideNew,
  compactNew,
}: {
  title: string
  count: number
  onNew: () => void
  /** 这一页没有可新建的东西时隐藏「新建」（例如技能页的「自带 Skill」分页） */
  hideNew?: boolean
  /**
   * 窄栏里按钮很多时把「新建」收成图标（文字放进 title / aria-label）：
   * 技能页头部有「AI 创建」+「新建」两个按钮，300px 宽时文字按钮会顶出左栏。
   * 调用方要把自己的 extra 也换成图标按钮，整体才放得下。
   */
  compactNew?: boolean
  query: string
  onQuery: (q: string) => void
  placeholder: string
  children: React.ReactNode
  footer?: React.ReactNode
  /** 新建按钮左边的额外操作 */
  extra?: React.ReactNode
  /** 搜索框下面的分页（例如技能页的 Skill / 命令 / 自带 Skill） */
  tabs?: React.ReactNode
}) {
  return (
    <section
      aria-label={t('{title}列表', { title })}
      className="flex w-full shrink-0 flex-col border-b bg-panel md:h-full md:w-[300px] md:border-r md:border-b-0 lg:w-[320px]"
    >
      <div className="flex flex-col gap-3 px-4 pt-5 pb-3">
        <div className="flex items-center gap-2">
          {/* 标题可以被压缩：不放 min-w-0 + truncate 时它按内容宽度撑着，后面的按钮会被顶出左栏 */}
          <h1 title={title} className="min-w-0 truncate text-lg font-semibold">
            {title}
          </h1>
          <span className="shrink-0 rounded-full border bg-card px-2 text-xs text-muted">{count}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {extra}
            {!hideNew &&
              (compactNew ? (
                <Button size="icon-sm" onClick={onNew} aria-label={t('新建')} title={t('新建')}>
                  <Plus className="h-4 w-4" />
                </Button>
              ) : (
                <Button size="sm" onClick={onNew}>
                  <Plus className="h-4 w-4" />
                  {t('新建')}
                </Button>
              ))}
          </div>
        </div>
        <label className="relative block">
          <span className="sr-only">{t('搜索')}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={placeholder}
            className="h-[38px] w-full rounded-lg border border-line-strong bg-field pr-3 pl-9 text-[0.8125rem] outline-none placeholder:text-subtle focus:border-focus focus:ring-[3px] focus:ring-focus-soft"
          />
        </label>
        {tabs}
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
  tags,
}: {
  /** 副标题下面的一行标签 */
  tags?: React.ReactNode
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
        {tags && <span className="mt-1 flex min-w-0">{tags}</span>}
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
  return <div className="px-2 py-8 text-center text-[0.8125rem] text-subtle">{children}</div>
}
