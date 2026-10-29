import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { UnreadDot } from './badge'
import { StatusPill } from './status-pill'

// 侧栏的部件（对应组件库「侧栏」卡片：ModeSwitch · NavRow · ProjectRow · TaskRow）。
// 侧栏贴着底色，行与行之间只靠底色分：选中是 bg-sel，不描边、不加阴影，没有竖引导线

/**
 * 侧栏一行的选中 / 悬停外观：导航、项目行、任务行和设计行都引用这里，选中态只定义一次。
 * 用的时候基础类里要带 `border`（透明边只占位，拖拽插入提示等场景切换时行高不跳）
 */
export const SIDEBAR_ROW_ON = 'border-transparent bg-sel text-fg'
export const SIDEBAR_ROW_OFF = 'border-transparent text-muted hover:bg-sel/60 hover:text-fg'

/**
 * 任务块里的选中行：块本身已经垫了一层浅底，选中要比块更亮，用卡片底。
 * 深色下 card 反而比 sel 暗、和块底几乎一样，改用 sel 掺一点前景色提亮（只由 token 混出来）
 */
export const SIDEBAR_BLOCK_ROW_ON =
  'border-transparent bg-card text-fg dark:bg-[color-mix(in_oklab,var(--sel)_88%,var(--fg))]'
export const SIDEBAR_BLOCK_ROW_OFF = 'border-transparent text-muted hover:bg-sel/80 hover:text-fg'

/** 分组标题（项目 / 对话内容 / 按天）：小一号的次要色，和可点的行靠字号和颜色拉开，不加粗 */
export const SIDEBAR_GROUP_LABEL = 'text-[0.6875rem] text-subtle'

/** 导航行：32 高、13.5px，选中 bg-sel + 500 字重 */
export const NAV_ROW =
  'flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[7px] border px-[9px] text-[0.8125rem] transition-colors'

/**
 * 模式切换（Agent / Chat / 设计）：槽里平分三段，选中段是浮起的小块。
 * 槽和选中块用 seg-track / seg-thumb（index.css）：深色下 bg-sel 和 bg-card 色阶太近，选中项看不出来
 */
export function ModeTabs({
  modes,
  onPick,
  label,
  className,
}: {
  modes: { id: string; name: string; label?: string; on: boolean }[]
  onPick: (id: string) => void
  label: string
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('seg-track flex shrink-0 gap-0.5 rounded-[9px] p-[3px]', className)}
    >
      {modes.map((m) => (
        <button
          key={m.id}
          role="radio"
          aria-checked={m.on}
          aria-label={m.label}
          title={m.label}
          onClick={() => !m.on && onPick(m.id)}
          className={cn(
            'h-[1.625rem] min-w-0 flex-1 cursor-pointer truncate rounded-md px-1 text-[0.75rem] transition-colors',
            // 未选中用 muted 不用 subtle：深色下 subtle 太暗，像禁用
            m.on ? 'seg-thumb font-medium' : 'text-muted hover:text-fg',
          )}
        >
          {m.name}
        </button>
      ))}
    </div>
  )
}

/** 导航行的纯外观：图标 + 名字 + 行尾（快捷键、提示点），侧栏的 Row 在它外面加悬停提示和收起态 */
export function NavRow({
  icon,
  label,
  on,
  trailing,
  className,
  ...rest
}: {
  icon: ReactNode
  label: ReactNode
  on?: boolean
  trailing?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      aria-current={on ? 'page' : undefined}
      className={cn(NAV_ROW, on ? cn(SIDEBAR_ROW_ON, 'font-medium') : SIDEBAR_ROW_OFF, className)}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
    </button>
  )
}

/** 项目行右边的对话数：小圆角底，选中行（bg-sel）上换成卡片底，不然和行底糊在一起 */
export function SidebarCount({ n, on, className }: { n: number; on?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'grid h-[1.125rem] min-w-[1.125rem] shrink-0 place-items-center rounded-full px-1 text-[0.6875rem] text-subtle tabular-nums',
        on ? 'bg-card' : 'bg-sel/80',
        className,
      )}
    >
      {n}
    </span>
  )
}

/** 项目下的任务列表：缩进成一块浅底，块里的行选中时用卡片底（SIDEBAR_BLOCK_ROW_ON） */
export function SidebarTaskBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-0.5 ml-3 flex flex-col gap-0.5 rounded-lg bg-sel/40 p-0.5', className)}>{children}</div>
}

/** 侧栏行尾用的小号状态胶囊：和 StatusPill 同一套状态色，只是矮一号 */
const SMALL_PILL = 'h-[1.125rem] gap-1 px-1.5 text-[0.6875rem]'

/**
 * 任务行右边的状态：同一时刻只出一个，优先级 等你回复 > 子对话在跑 > 自己在跑 > 失败 > 未读。
 * 判定由调用方从 taskState / taskDoneDot 取（一个状态只在一处算），这里只管画
 */
export function TaskRowStatus({
  needs,
  kids = 0,
  running,
  failed,
  unread,
}: {
  /** 有没回答的提问、待确认的请求 */
  needs?: boolean
  /** 名下正在执行的子对话数 */
  kids?: number
  /** 自己在执行或在等会推回来的结果 */
  running?: boolean
  failed?: boolean
  unread?: boolean
}) {
  if (needs)
    return (
      <StatusPill tone="wait" className={SMALL_PILL}>
        {t('等你回复')}
      </StatusPill>
    )
  if (kids > 0)
    return (
      <StatusPill tone="run" spin className={SMALL_PILL}>
        {t('{n} 子对话', { n: kids })}
      </StatusPill>
    )
  if (running)
    return (
      <StatusPill tone="run" spin className={SMALL_PILL}>
        {t('执行中')}
      </StatusPill>
    )
  if (failed)
    return (
      <StatusPill tone="err" className={SMALL_PILL}>
        {t('失败')}
      </StatusPill>
    )
  if (unread) return <UnreadDot className="mr-1 h-[7px] w-[7px]" />
  return null
}

/** 项目行右边「N 个执行中」的胶囊 */
export function ProjectRunning({ n, className }: { n: number; className?: string }) {
  return (
    <StatusPill tone="run" className={cn(SMALL_PILL, className)}>
      {t('{n} 个执行中', { n })}
    </StatusPill>
  )
}
