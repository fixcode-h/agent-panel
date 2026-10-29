import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/menu'
import { ChevronRight, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
  compact,
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
  /**
   * 行更紧凑的列表（角色页）：头部、搜索框和行一起收紧，一屏能放下更多条目。
   * 只改变间距和字号，不传时保持各页原来的观感。
   */
  compact?: boolean
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
      <div className={cn('flex flex-col px-4', compact ? 'gap-2.5 pt-4 pb-2.5' : 'gap-3 pt-5 pb-3')}>
        <div className="flex items-center gap-2">
          {/* 标题可以被压缩：不放 min-w-0 + truncate 时它按内容宽度撑着，后面的按钮会被顶出左栏 */}
          <h1 title={title} className="min-w-0 truncate text-lg font-semibold">
            {title}
          </h1>
          <Badge className="shrink-0">{count}</Badge>
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
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={placeholder}
            className={cn('pr-3 pl-9 text-[0.8125rem]', compact ? 'h-[34px]' : 'h-[38px]')}
          />
        </label>
        {tabs}
      </div>
      <div
        className={cn(
          'flex max-h-[50vh] flex-1 flex-col gap-0.5 overflow-y-auto px-2 md:max-h-none',
          compact ? 'pb-2' : 'pb-3',
        )}
      >
        {children}
      </div>
      {footer && <div className={cn('border-t px-4', compact ? 'pt-2.5 pb-3' : 'pt-3 pb-4')}>{footer}</div>}
    </section>
  )
}

export function ListGroup({
  header,
  children,
  label,
  groupId,
  collapsed,
}: {
  header: React.ReactNode
  children?: React.ReactNode
  /** 分组的可访问名称：屏幕阅读器和界面检查靠它认出是哪一组，不传就不加 role */
  label?: string
  /** 稳定的分组标识（渲染成 data-group-id，只给自动化定位用，不写 DOM 的 id） */
  groupId?: string
  /** 收起时不渲染子项；组头照常显示（「新建」「分类操作」还在），不传表示这一组不能收起 */
  collapsed?: boolean
}) {
  return (
    <div
      className="group/g"
      data-group-id={groupId}
      data-collapsed={collapsed ? '' : undefined}
      {...(label ? { role: 'group', 'aria-label': label } : {})}
    >
      {header}
      {!collapsed && <div className="flex flex-col gap-0.5">{children}</div>}
    </div>
  )
}

export function GroupHeader({
  label,
  count,
  actions,
  compact,
  collapsed,
  onToggle,
}: {
  label: React.ReactNode
  count?: number
  actions?: React.ReactNode
  compact?: boolean
  /** 收起状态：箭头指右，展开时指下 */
  collapsed?: boolean
  /** 传了才能点组头展开 / 收起（角色页的分类组）；不传时组头只是标题 */
  onToggle?: () => void
}) {
  const head = (
    <>
      {onToggle && (
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', !collapsed && 'rotate-90')} aria-hidden />
      )}
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="shrink-0">· {count}</span>}
    </>
  )
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2 text-subtle',
        // 紧凑档要装得下 h-7 的图标按钮（分类视图的「新建」「分类操作」）：28 + pt-1 正好是 h-8
        compact ? 'h-8 pt-1 text-[0.6875rem]' : 'h-9 pt-2 text-xs',
      )}
    >
      {onToggle ? (
        // 整条组头（标题 + 条数）都是折叠开关：只点箭头太小，点名字也是自然操作
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="-mx-1 flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1 text-left hover:text-fg"
        >
          {head}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">{head}</span>
      )}
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
  compact,
}: {
  /** 副标题下面的一行标签 */
  tags?: React.ReactNode
  /** 更紧凑的一行（角色页）：更小的内边距、头像、字号和间距，选中态改成整行浅底 */
  compact?: boolean
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
        'flex w-full cursor-pointer items-center border border-transparent text-left transition-colors',
        compact ? 'gap-2 rounded-lg px-2.5 py-[5px]' : 'gap-3 rounded-[10px] p-2.5',
        selected ? (compact ? 'bg-sel' : 'border-sel-line bg-sel shadow-card') : 'hover:bg-sel/60',
      )}
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate font-medium', compact && 'text-[0.8125rem] leading-tight')}>{title}</span>
        <span
          className={cn(
            'truncate text-muted',
            compact ? 'text-[0.6875rem] leading-tight' : 'text-xs',
            monoSubtitle && 'font-mono',
          )}
        >
          {subtitle}
        </span>
        {tags && <span className={cn('flex min-w-0', compact ? 'mt-0.5' : 'mt-1')}>{tags}</span>}
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
