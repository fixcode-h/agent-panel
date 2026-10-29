import { createContext, useContext, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Spinner } from './status-pill'

/**
 * 页签条（照 Proma 的 TabBar）：直角、等宽，选中的页签不加底色，只在底部画一条 3px 指示条；
 * 没选中的是灰字，悬停有浅底；关闭按钮悬停才出现，选中的页签半透明常驻。
 * 页签平分整条宽度（右栏「项目文件 / 本对话改动」这种固定的两三个）时给 TabItem 传 fill。
 * variant="underline"：详情页、设置小节那种页内切换——没有条底色、页签按文字宽度排，选中是 2px 圆头强调色下划线
 */
type TabVariant = 'bar' | 'underline'
/** TabItem 跟着所在 TabBar 的样式画，不用每个页签再传一遍 */
const TabVariantContext = createContext<TabVariant>('bar')

export function TabBar({
  label,
  as: Root = 'div',
  className,
  children,
  leading,
  trailing,
  variant = 'bar',
}: {
  /** 读屏名，如「对话页签」 */
  label: string
  /** 页面的标题栏用 header（对话页），面板里的页签条用 div */
  as?: 'div' | 'header'
  className?: string
  children: ReactNode
  /** 页签前面的入口（对话页的项目名） */
  leading?: ReactNode
  /** 页签条右端的操作（状态、开关右栏） */
  trailing?: ReactNode
  variant?: TabVariant
}) {
  const underline = variant === 'underline'
  return (
    <TabVariantContext.Provider value={variant}>
      <Root className={cn('flex shrink-0 items-stretch border-b', underline ? 'h-10' : 'h-9 bg-rail', className)}>
        {leading && <div className={cn('flex shrink-0 items-center px-1.5', !underline && 'border-r')}>{leading}</div>}
        <div
          role="tablist"
          aria-label={label}
          className={cn(
            'flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]',
            underline && 'gap-1',
          )}
        >
          {children}
        </div>
        {trailing && <div className="flex shrink-0 items-center gap-1.5 px-2">{trailing}</div>}
      </Root>
    </TabVariantContext.Provider>
  )
}

export function TabItem({
  active,
  onSelect,
  onDoubleClick,
  onClose,
  closeLabel,
  icon,
  busy,
  tag,
  preview,
  fill,
  title,
  className,
  children,
}: {
  active: boolean
  onSelect: () => void
  onDoubleClick?: () => void
  /** 不给就不能关（父对话、固定页签） */
  onClose?: () => void
  /** 关闭按钮的读屏名，默认「关闭页签」 */
  closeLabel?: string
  icon?: ReactNode
  /** 在跑：图标位置换成转圈 */
  busy?: boolean
  /** 标题后面的小标签（子对话、工作流、计数） */
  tag?: ReactNode
  /** 预览页签：标题斜体，下一次单击会替换它 */
  preview?: boolean
  /** 平分页签条的宽度，标题居中 */
  fill?: boolean
  title?: string
  className?: string
  children: ReactNode
}) {
  const underline = useContext(TabVariantContext) === 'underline'
  return (
    <div
      className={cn(
        'group/tab relative flex min-w-0 items-center transition-colors',
        underline
          ? // 页内切换：字号和正文一样、按文字宽度排；选中只有一条细下划线，没选中灰字、悬停变深，不出底色
            cn(
              'shrink-0 text-[0.8125rem] font-medium',
              fill && 'flex-1 basis-0',
              active
                ? 'text-fg after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent'
                : 'text-muted hover:text-fg',
            )
          : cn(
              'text-[0.75rem]',
              fill ? 'flex-1 basis-0' : 'max-w-60 shrink-0 basis-[8.25rem]',
              // 选中只画底部指示条：左右各缩进 6px，盖住页签条的底线
              active
                ? 'font-medium text-fg after:absolute after:inset-x-1.5 after:-bottom-px after:h-[3px] after:bg-primary'
                : 'text-subtle hover:bg-sel/60 hover:text-fg',
            ),
        className,
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        title={title}
        className={cn(
          'flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left',
          underline ? 'px-2.5' : 'pr-1 pl-3',
          fill && 'justify-center px-3',
        )}
      >
        {busy ? <Spinner className="text-run" /> : icon && <span className="flex shrink-0 items-center">{icon}</span>}
        <span className={cn('min-w-0 truncate', !fill && !underline && 'flex-1', preview && 'italic')}>{children}</span>
        {tag && (
          <span className="shrink-0 rounded-full bg-sel px-1.5 text-[0.6875rem] leading-4 font-normal text-muted">
            {tag}
          </span>
        )}
      </button>
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel ?? t('关闭页签')}
          title={closeLabel ?? t('关闭页签')}
          onClick={onClose}
          className={cn(
            'mr-2 flex h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer items-center justify-center rounded transition-opacity hover:bg-sel',
            active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100',
          )}
        >
          <X className="h-2.5 w-2.5" strokeWidth={2.6} />
        </button>
      ) : (
        !fill && !underline && <span className="w-2 shrink-0" />
      )}
    </div>
  )
}
