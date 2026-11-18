import type { ComponentType, CSSProperties, ReactNode } from 'react'
import { PanelLeftClose } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

/**
 * 分区导航（UE 页这类盖住侧栏的项目工具页用，设计稿 designs/UE页左侧导航重设计-设计稿.md 方案 B）：
 * 一条图标轨 + 旁边可收起的二级面板。图标轨一个分区一个图标，分组之间一道细线，徽标变成角标：
 * 要紧的（错误）写数字，其余是圆点；图标下面一行小字（可关）。宽度、圆角、要不要写数字、二级面板底色在设置 → 组件 →「分区导航」里调（--c-sectionRail-*）。
 * 经 host.ui 交给插件（SectionRail、SidePanel、StatusChip），旧面板没有时插件照旧画自己的左栏
 */

export type RailTone = 'danger' | 'warn' | 'muted' | 'accent'

export interface SectionRailItem {
  id: string
  label: string
  /** 函数组件（lucide 图标或自己画的 svg），按 18px、线宽 1.75 画 */
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  /** 同组的挨着放，组和组之间画一道细线 */
  group?: string
  /** 放到轨道底部（项目设置、插件管理这类偶尔去的） */
  end?: boolean
  /**
   * 角标：count 大于 0 且 tone 是 danger 时写数字（设置里关掉数字就只剩圆点），其余只画圆点；
   * text 写进悬停提示（「22 错误」）
   */
  badge?: { count?: number; tone?: RailTone; text?: string }
  /** 图标下面的小字，不给用 label（label 太长时给个短的） */
  short?: string
}

/**
 * 图标轨按钮：图标下面一行小字（用户 2026-11-18 要的，光看图标认不出），设置里能关掉（--c-sectionRail-labels）。
 * 关掉文字时按钮缩回 36px 见方
 */
const RAIL_BTN =
  'press relative flex min-h-9 w-full shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-(--c-sectionRail-radius) px-0.5 py-1.5 transition-colors max-md:w-auto max-md:px-2'

function RailCaption({ children }: { children: ReactNode }) {
  return (
    <span className="max-w-full truncate text-caption leading-tight [display:var(--c-sectionRail-labels)]">
      {children}
    </span>
  )
}

const DOT: Record<RailTone, string> = {
  danger: 'bg-danger',
  warn: 'bg-warning',
  muted: 'bg-subtle',
  accent: 'bg-accent',
}

function RailButton({ item, on, onPick }: { item: SectionRailItem; on: boolean; onPick: (id: string) => void }) {
  const Icon = item.icon
  const b = item.badge
  const tone = b?.tone ?? 'muted'
  const num = b?.count && b.count > 0 && tone === 'danger' ? (b.count > 99 ? '99+' : String(b.count)) : ''
  return (
    <button
      type="button"
      onClick={() => onPick(item.id)}
      aria-label={item.label}
      aria-current={on ? 'page' : undefined}
      title={b?.text ? `${item.label} · ${b.text}` : item.label}
      className={cn(RAIL_BTN, on ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      <span className="relative grid size-5 place-items-center">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        {b && (
          <>
            {/* 圆点总是在；写数字时数字盖在圆点上面（设置里关掉数字，数字 display:none 就只剩圆点） */}
            <span
              data-rail-dot=""
              className={cn(
                'absolute -top-0.5 -right-1 size-2 rounded-full ring-2 ring-(--c-sectionRail-bg)',
                DOT[tone],
              )}
            />
            {num && (
              <span
                data-rail-count=""
                className="absolute -top-1.5 -right-3 h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-caption leading-none font-semibold text-(--on-danger) tabular-nums ring-2 ring-(--c-sectionRail-bg) [display:var(--c-sectionRail-count)]"
              >
                {num}
              </span>
            )}
          </>
        )}
      </span>
      <RailCaption>{item.short ?? item.label}</RailCaption>
    </button>
  )
}

const Sep = () => (
  <span aria-hidden className="activity-sep my-1 h-px w-5 shrink-0 max-md:mx-1 max-md:h-5 max-md:w-px" />
)

/**
 * 图标轨：宽屏竖排贴左边，窄屏横排一行可以左右滚。top 放在最上面（例如收起二级面板后再展开的按钮），
 * end 的项和 bottom 放在底部
 */
export function SectionRail({
  items,
  current,
  onPick,
  top,
  bottom,
  label,
  className,
}: {
  items: SectionRailItem[]
  current?: string
  onPick: (id: string) => void
  top?: ReactNode
  bottom?: ReactNode
  /** 导航的可访问名称 */
  label?: string
  className?: string
}) {
  const main = items.filter((x) => !x.end)
  const end = items.filter((x) => x.end)
  const list = (xs: SectionRailItem[]) =>
    xs.map((x, i) => (
      <span key={x.id} className="contents">
        {i > 0 && x.group !== xs[i - 1].group && <Sep />}
        <RailButton item={x} on={x.id === current} onPick={onPick} />
      </span>
    ))
  return (
    <nav
      aria-label={label ?? t('分区')}
      data-section-rail=""
      className={cn(
        'flex shrink-0 items-center gap-0.5 bg-(--c-sectionRail-bg) p-1.5',
        'max-md:overflow-x-auto max-md:border-b max-md:border-line',
        'md:w-(--c-sectionRail-width) md:flex-col md:overflow-y-auto md:border-r md:border-line md:py-2.5',
        className,
      )}
    >
      {top}
      {top && main.length > 0 && <Sep />}
      {list(main)}
      <span className="md:mt-auto" />
      {end.length > 0 && <Sep />}
      {list(end)}
      {bottom}
    </nav>
  )
}

/** 图标轨上的普通按钮（不是分区：截视口、展开二级面板），和分区按钮一样大 */
export function RailAction({
  icon: Icon,
  label,
  onClick,
  on,
  dot,
  short,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  label: string
  /** 图标下面的小字（label 是悬停提示，常常较长），不给就不写字 */
  short?: string
  onClick: () => void
  on?: boolean
  /** 右上角的状态点（连接状态） */
  dot?: RailTone | 'ok'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={on}
      className={cn(RAIL_BTN, on ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}
    >
      <span className="relative grid size-5 place-items-center">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        {dot && (
          <span
            className={cn(
              'absolute -top-0.5 -right-1 size-2 rounded-full ring-2 ring-(--c-sectionRail-bg)',
              dot === 'ok' ? 'bg-success' : DOT[dot],
            )}
          />
        )}
      </span>
      {short && <RailCaption>{short}</RailCaption>}
    </button>
  )
}

/**
 * 二级面板：图标轨右边的一栏，标题 + 收起按钮，下面放这一页自己的导航（日志的级别、对象页的浏览方式……）。
 * 宽度由调用方给（插件自己记拖动的宽度）
 */
export function SidePanel({
  title,
  onCollapse,
  children,
  className,
  style,
}: {
  title: ReactNode
  onCollapse?: () => void
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <aside
      data-side-panel=""
      style={style}
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col gap-2 bg-(--c-sectionRail-panelBg) p-2.5 max-md:border-b max-md:border-line md:overflow-y-auto md:border-r md:border-line',
        className,
      )}
    >
      <div className="flex min-h-7 items-center gap-2 px-1">
        <h2 className="min-w-0 flex-1 truncate text-heading font-semibold text-fg">{title}</h2>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t('收起二级面板')}
            title={t('收起二级面板')}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-(--c-iconButton-radius) text-subtle hover:bg-hover hover:text-fg max-md:hidden"
          >
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
          </button>
        )}
      </div>
      {children}
    </aside>
  )
}

/** 二级面板里的分组标题 */
export function SidePanelLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 pt-2 pb-0.5 text-caption text-subtle">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </div>
  )
}

/** 二级面板里的一行：28 高，选中 bg-active，右边是「数字 + 一个词」的徽标 */
export function SidePanelRow({
  icon: Icon,
  label,
  on,
  onClick,
  meta,
  tone,
  title,
}: {
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>
  label: ReactNode
  on?: boolean
  onClick: () => void
  meta?: ReactNode
  tone?: RailTone
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={on ? 'true' : undefined}
      className={cn(
        'flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-(--c-nav-radius) px-2 text-left text-body whitespace-nowrap',
        on ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta != null && meta !== '' && (
        <span
          className={cn(
            'shrink-0 font-mono text-caption',
            tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-subtle',
          )}
        >
          {meta}
        </span>
      )}
    </button>
  )
}

export type ChipTone = 'ok' | 'run' | 'warn' | 'danger' | 'muted'
const CHIP_DOT: Record<ChipTone, string> = {
  ok: 'bg-success',
  run: 'bg-run',
  warn: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-line-strong',
}

/**
 * 状态小块（目标卡上的「PIE 18616」「VS 调试」「后台」）：圆点 + 几个字，灰点表示没开。
 * 给 onClick 时可以点（点了直接做对应的事，例如启动 / 关掉后台编辑器），title 写清楚点了会怎样
 */
export function StatusChip({
  tone = 'muted',
  icon: Icon,
  children,
  onClick,
  title,
  busy,
}: {
  tone?: ChipTone
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>
  children: ReactNode
  onClick?: () => void
  title?: string
  /** 在启动、编译：圆点换成转圈的点 */
  busy?: boolean
}) {
  const body = (
    <>
      <span className={cn('size-1.5 shrink-0 rounded-full', CHIP_DOT[tone], busy && 'animate-pulse')} />
      {Icon && <Icon className="h-3 w-3 shrink-0" strokeWidth={2} />}
      <span className="min-w-0 truncate">{children}</span>
    </>
  )
  const cls =
    'inline-flex h-[22px] max-w-full min-w-0 items-center gap-1.5 rounded-(--c-chip-radius) bg-sel/70 px-2 text-caption text-muted'
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(cls, 'cursor-pointer hover:bg-hover hover:text-fg disabled:opacity-50')}
    >
      {body}
    </button>
  ) : (
    <span title={title} className={cls}>
      {body}
    </span>
  )
}
