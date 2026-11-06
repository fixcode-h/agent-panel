import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { IconButton } from './icon-button'
import { Spinner } from './status-pill'
import { revealTab, useTabScroll } from './use-tab-scroll'

/**
 * 页签条（照 Proma 的 TabBar）：直角、等宽，选中的页签不加底色，只在底部画一条 3px 指示条；
 * 没选中的是灰字，悬停有浅底；关闭按钮悬停才出现，选中的页签半透明常驻。
 * 页签要平分整条宽度时给 TabItem 传 fill；对话右栏「项目文件 / 本对话改动」用户要求固定宽度，不传。
 * variant="underline"：详情页、设置小节那种页内切换——没有条底色、页签按文字宽度排，选中是 2px 圆头强调色下划线
 * variant="fit"：对话右栏「项目文件 / 本对话改动」——条和 bar 一样，页签按内容宽度左对齐、间距 20px、两头留 16px，
 * 指示条和内容同宽（设计稿 `.ptab.sm`）
 * 页签放不下时可以左右滚：滚轮横向滚、两端出箭头按钮和渐隐，选中的页签自动滚进可见区（use-tab-scroll.ts）。
 */
type TabVariant = 'bar' | 'underline' | 'fit'
/** TabItem 跟着所在 TabBar 的样式画，不用每个页签再传一遍 */
const TabVariantContext = createContext<TabVariant>('bar')

export function TabBar({
  label,
  as: Root = 'div',
  className,
  children,
  leading,
  trailing,
  trailingLabel,
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
  /**
   * 给了就把右端包成一个 toolbar（读屏名用它），并把页签条设成容器：
   * 右栏的工具区跟着页签换内容，里面的按钮按页签条宽度收缩（@container 查询），不看窗口宽度
   */
  trailingLabel?: string
  variant?: TabVariant
}) {
  const underline = variant === 'underline'
  const fit = variant === 'fit'
  const scroll = useTabScroll()
  // 放不下时两端各一个箭头；滚到头的那一端变灰不可点，不隐藏，免得页签区宽度跟着来回跳
  const arrow = (dir: -1 | 1) =>
    scroll.overflow && (
      <div className="flex shrink-0 items-center px-0.5">
        <IconButton
          icon={dir < 0 ? ChevronLeft : ChevronRight}
          label={dir < 0 ? t('向左滚动') : t('向右滚动')}
          tone="bare"
          disabled={dir < 0 ? !scroll.start : !scroll.end}
          onClick={() => scroll.scrollBy(dir)}
          className="disabled:pointer-events-none disabled:opacity-30"
        />
      </div>
    )
  return (
    <TabVariantContext.Provider value={variant}>
      <Root
        className={cn(
          'flex shrink-0 items-stretch border-b',
          underline ? 'h-10' : 'h-9 bg-bg',
          trailingLabel && '@container',
          className,
        )}
      >
        {leading && <div className={cn('flex shrink-0 items-center px-1.5', !underline && 'border-r')}>{leading}</div>}
        {arrow(-1)}
        <div
          ref={scroll.ref}
          role="tablist"
          aria-label={label}
          data-fade-start={scroll.start || undefined}
          data-fade-end={scroll.end || undefined}
          className={cn(
            'tab-scroll relative flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            underline && 'gap-1',
            fit && 'gap-5 px-4',
          )}
        >
          {children}
        </div>
        {arrow(1)}
        {trailing &&
          (trailingLabel ? (
            <div role="toolbar" aria-label={trailingLabel} className="flex shrink-0 items-center gap-0.5 px-2">
              {trailing}
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5 px-2">{trailing}</div>
          ))}
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
  extra,
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
  /** 标题和关闭按钮之间的附加按钮（右栏子对话页签的切换下拉）：自己处理点击，不触发选中 */
  extra?: ReactNode
  /** 预览页签：标题斜体，下一次单击会替换它 */
  preview?: boolean
  /** 平分页签条的宽度，标题居中 */
  fill?: boolean
  title?: string
  className?: string
  children: ReactNode
}) {
  const variant = useContext(TabVariantContext)
  const underline = variant === 'underline'
  const fit = variant === 'fit'
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active && ref.current) revealTab(ref.current)
  }, [active])
  return (
    <div
      ref={ref}
      className={cn(
        'group/tab relative flex min-w-0 items-center transition-colors',
        fit
          ? // 按内容宽度：不留左右内边距，指示条和内容同宽；没选中灰字、悬停变深，不出底色
            cn(
              'shrink-0 text-body',
              active
                ? 'font-medium text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-[3px] after:bg-fg'
                : 'text-subtle hover:text-fg',
            )
          : underline
            ? // 页内切换：字号和正文一样、按文字宽度排；选中只有一条细下划线，没选中灰字、悬停变深，不出底色
              cn(
                'shrink-0 text-body font-medium',
                fill && 'flex-1 basis-0',
                active
                  ? 'text-fg after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent'
                  : 'text-muted hover:text-fg',
              )
            : cn(
                'text-footnote',
                fill ? 'flex-1 basis-0' : 'max-w-60 shrink-0 basis-[8.25rem]',
                // 选中只画底部指示条：左右各缩进 6px，盖住页签条的底线
                active
                  ? 'font-medium text-fg after:absolute after:inset-x-1.5 after:-bottom-px after:h-[3px] after:bg-primary'
                  : 'text-subtle hover:bg-hover hover:text-fg',
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
          fit ? 'px-0' : underline ? 'px-2.5' : 'pr-1 pl-3',
          fill && 'justify-center px-3',
        )}
      >
        {busy ? <Spinner className="text-run" /> : icon && <span className="flex shrink-0 items-center">{icon}</span>}
        {/* 文字在固定高度的条里居中时会浮在上半部（字形比盒子中心高），往下补一档（index.css 的 text-optical-center） */}
        <span
          className={cn(
            'min-w-0 truncate',
            // 只有对话页签这种固定高度的条需要往下补一档；fit / underline 变体的页签高度跟着内容走，本来就居中
            !fit && !underline && 'text-optical-center',
            !fill && !underline && !fit && 'flex-1',
            preview && 'italic',
          )}
        >
          {children}
        </span>
        {tag && (
          <span
            className={cn(
              'text-optical-center shrink-0 rounded-full bg-sel px-1.5 text-caption leading-4 font-normal text-muted',
              // 右栏的计数是 18px 的圆角小块（设计稿），一位数时是正圆
              fit && 'grid h-[1.125rem] min-w-[1.125rem] place-items-center px-[0.3125rem] leading-none',
            )}
          >
            {tag}
          </span>
        )}
      </button>
      {extra && <span className="ml-0.5 flex shrink-0 items-center">{extra}</span>}
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel ?? t('关闭页签')}
          title={closeLabel ?? t('关闭页签')}
          onClick={onClose}
          className={cn(
            'mr-2 flex h-[1.125rem] w-[1.125rem] shrink-0 cursor-pointer items-center justify-center rounded-sm transition-opacity hover:bg-hover',
            active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100',
          )}
        >
          <X className="h-2.5 w-2.5" strokeWidth={2.6} />
        </button>
      ) : (
        !fill && !underline && !fit && <span className="w-2 shrink-0" />
      )}
    </div>
  )
}
