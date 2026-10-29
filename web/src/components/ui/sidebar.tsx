import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { StatusPill } from './status-pill'

// 侧栏的部件（对应组件库「侧栏」卡片：ModeSwitch · NavRow · ProjectRow · TaskRow）。
// 侧栏贴着底色，行与行之间只靠底色分：选中是 bg-sel，不描边、不加阴影，没有竖引导线

/**
 * 侧栏一行的选中 / 悬停外观：导航、项目行、任务行和设计行都引用这里，选中态只定义一次。
 * 用的时候基础类里要带 `border`（透明边只占位，拖拽插入提示等场景切换时行高不跳）
 */
export const SIDEBAR_ROW_ON = 'border-transparent bg-sel text-fg'
export const SIDEBAR_ROW_OFF = 'border-transparent text-muted hover:bg-sel/60 hover:text-fg'

/** 项目下的对话卡片：平时灰底，选中换卡片底 + 细边 + 投影浮起来（照设计稿 Workspace 侧栏） */
export const SIDEBAR_BLOCK_ROW_ON = 'border-line-strong bg-card font-semibold text-fg shadow-card'
export const SIDEBAR_BLOCK_ROW_OFF = 'border-transparent bg-sel/70 text-fg hover:bg-sel'

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

/**
 * 项目卡片（照设计稿 Workspace 侧栏）：每个项目一张 36 高的圆角卡片，折叠箭头在卡片外。
 * 选中的项目是浅蓝底 + 细蓝边（proj token，不随配色变），其余是灰底细边
 */
export const PROJECT_CARD =
  'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] border pr-1.5 pl-2.5 text-[0.8125rem] transition-[background-color,filter]'
export const PROJECT_CARD_ON = 'border-proj-line bg-proj text-proj-fg'
export const PROJECT_CARD_OFF = 'border-line bg-sel/70 text-fg hover:bg-sel'

/** 项目卡片右边的对话数：选中卡片上是带细边的白色圆片，其余卡片上只是一个次要色数字 */
export function SidebarCount({ n, on, className }: { n: number; on?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[0.6875rem] tabular-nums',
        on ? 'bg-card font-semibold text-fg ring-1 ring-proj-line' : 'text-subtle',
        className,
      )}
    >
      {n}
    </span>
  )
}

/**
 * 项目下的对话列表：缩进，左边一道竖线把它们挂在项目下面；每个对话是一张灰底卡片，
 * 选中的那张换成卡片底 + 细边浮起来（照设计稿 Workspace 侧栏）
 */
export function SidebarTaskBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mt-1.5 ml-5 flex flex-col gap-[5px] border-l-[1.5px] border-line-strong pl-2.5', className)}>
      {children}
    </div>
  )
}

/** 侧栏行尾用的小号状态胶囊：20 高、600 字重；底色比 StatusPill 实（设计稿：等你回复、未读是实心底） */
const SMALL_PILL = 'h-5 gap-1.5 px-2 text-[0.6875rem] font-semibold'
/** 子对话 / 执行中：卡片底 + 细边的白片，转圈用运行色 */
const PILL_RUN = 'bg-card text-fg ring-1 ring-line'

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
      <StatusPill tone="wait" className={cn(SMALL_PILL, 'bg-warning text-bg')}>
        {t('等你回复')}
      </StatusPill>
    )
  if (kids > 0)
    return (
      <StatusPill tone="run" spin className={cn(SMALL_PILL, PILL_RUN)}>
        {t('{n} 子对话', { n: kids })}
      </StatusPill>
    )
  if (running)
    return (
      <StatusPill tone="run" spin className={cn(SMALL_PILL, PILL_RUN)}>
        {t('执行中')}
      </StatusPill>
    )
  if (failed)
    return (
      <StatusPill tone="err" className={SMALL_PILL}>
        {t('失败')}
      </StatusPill>
    )
  if (unread)
    return (
      <StatusPill tone="idle" className={cn(SMALL_PILL, 'bg-accent text-on-accent')}>
        {t('未读')}
      </StatusPill>
    )
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
