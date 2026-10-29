import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { ChevronRight, Folder, FolderOpen, Workflow } from 'lucide-react'
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

/**
 * 项目行：展开箭头 + 文件夹 + 项目名 + 行尾状态（「N 个执行中」或对话数），悬停时行尾状态让位给操作按钮。
 * 侧栏和组件库的示例都用这一个，外观只在这里定义。
 * name 由调用方给：侧栏里是可点的按钮（或改名输入框），里面放 SidebarProjectName
 */
export const SidebarProjectRow = forwardRef<
  HTMLDivElement,
  {
    open: boolean
    /** 当前就在这个项目的首页 */
    on?: boolean
    /** 没有对话的项目不能展开：箭头隐藏但占位，名字对齐不变 */
    canToggle?: boolean
    onToggle?: () => void
    name: ReactNode
    /** 收起时下面有对话在等你处理：名字后面一个提示图标 */
    alert?: ReactNode
    /** 在跑的对话数；为 0 时显示对话数 */
    running?: number
    count?: number
    /** 悬停才出现的操作（拖动手柄、新建对话），行尾状态在悬停时让位 */
    actions?: ReactNode
  } & Omit<HTMLAttributes<HTMLDivElement>, 'children'>
>(function SidebarProjectRow(
  { open, on, canToggle = true, onToggle, name, alert, running = 0, count = 0, actions, className, ...rest },
  ref,
) {
  return (
    // 折叠箭头在卡片外，卡片里是文件夹、名字和行尾（照设计稿 Workspace 侧栏）
    <div ref={ref} className={cn('group/proj flex items-center gap-1', className)} {...rest}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? t('收起') : t('展开')}
        disabled={!canToggle}
        className={cn(
          'grid h-6 w-4 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:text-fg',
          !canToggle && 'invisible',
        )}
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} strokeWidth={2.2} />
      </button>
      <div className={cn(PROJECT_CARD, on ? PROJECT_CARD_ON : PROJECT_CARD_OFF)}>
        {name}
        {alert}
        {/* 行尾：有对话在跑写「N 个执行中」（和 StatusPill 同一套运行色），否则是对话数 */}
        {running > 0 ? (
          <ProjectRunning n={running} className="group-hover/proj:hidden" />
        ) : (
          count > 0 && <SidebarCount n={count} on={on} className="group-hover/proj:hidden" />
        )}
        {actions}
      </div>
    </div>
  )
})

/** 项目行里的文件夹图标 + 名字：展开时是打开的文件夹 */
export function SidebarProjectName({ open, name }: { open: boolean; name: ReactNode }) {
  const Icon = open ? FolderOpen : Folder
  return (
    <>
      {/* 图标跟卡片文字同色：选中卡片上是项目蓝，其余卡片上是 muted（由 PROJECT_CARD_* 定） */}
      <Icon className="h-[15px] w-[15px] shrink-0 opacity-80" strokeWidth={1.9} />
      <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
    </>
  )
}

/** 项目下对话行的外框：块里的行（项目下）和不在块里的行（搜索结果）选中时底色不同 */
export function sidebarTaskRowClass(active: boolean, inBlock: boolean) {
  return cn(
    'group/row flex w-full cursor-pointer items-center gap-2 border text-left text-[0.8125rem] transition-colors',
    // 项目下的对话是一张张卡片（36 高、10px 圆角），搜索结果等其他地方还是紧凑行
    inBlock ? 'h-9 rounded-[10px]' : 'h-8 rounded-[7px]',
    active
      ? inBlock
        ? SIDEBAR_BLOCK_ROW_ON
        : cn(SIDEBAR_ROW_ON, 'font-medium')
      : inBlock
        ? SIDEBAR_BLOCK_ROW_OFF
        : SIDEBAR_ROW_OFF,
  )
}

/**
 * 对话行的内容：工作流对话前面一个流程图标（普通对话占大多数，不画图标，免得和行尾状态抢眼），
 * 标题、补充说明，行尾一个状态（TaskRowStatus），没有状态时是时间
 */
export function SidebarTaskRowBody({
  workflow,
  active,
  lead,
  title,
  hint,
  status,
  time,
}: {
  workflow?: boolean
  active?: boolean
  /** 标题前的标记（AI 分析的标签） */
  lead?: ReactNode
  /** 标题：调用方可以传带悬停说明、流光的 span */
  title: ReactNode
  hint?: ReactNode
  status?: ReactNode
  time?: ReactNode
}) {
  return (
    // 内容整体右缩一点，标题不至于顶到右边的状态上。缩进不能写进行上的 pl-*：行样式后跟调用方传的 px-*，
    // cn 走 twMerge 会把它覆盖掉。放在行内这一层，选中 / 悬停的背景（画在行上）仍然铺满整行
    <span className="flex min-w-0 flex-1 items-center gap-2 pl-[3px]">
      {workflow && (
        <Workflow
          aria-label={t('工作流')}
          className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-muted' : 'text-subtle')}
        />
      )}
      {lead}
      {typeof title === 'string' ? <span className="min-w-0 flex-1 truncate">{title}</span> : title}
      {hint && <span className="max-w-[40%] shrink truncate text-[0.6875rem] text-subtle">{hint}</span>}
      {status}
      {/* 时间格自己留一段左间距（在 gap-2 之外再加 6px）：标题截断后和时间之间也有明显间隔 */}
      {time && (
        <span
          className={cn(
            'shrink-0 pl-1.5 text-[0.6875rem] tabular-nums transition-colors',
            active ? 'text-muted' : 'text-subtle group-hover/row:text-muted',
          )}
        >
          {time}
        </span>
      )}
    </span>
  )
}
