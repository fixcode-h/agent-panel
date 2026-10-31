import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { ChevronRight, Folder, Workflow, type LucideIcon } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Spinner, StatusPill } from './status-pill'
import { UnreadDot } from './badge'

// 侧栏的部件（对应组件库「侧栏」卡片：ModeSwitch · NavRow · ProjectRow · TaskRow）。
// 侧栏贴着底色，行与行之间只靠底色分：导航选中是 bg-sel，项目选中是很淡的蓝底，项目下选中的对话是一张白卡片，都不描边

/**
 * 侧栏一行的选中 / 悬停外观：导航、项目行、任务行和设计行都引用这里，选中态只定义一次。
 * 用的时候基础类里要带 `border`（透明边只占位，拖拽插入提示等场景切换时行高不跳）
 */
export const SIDEBAR_ROW_ON = 'border-transparent bg-sel text-fg'
export const SIDEBAR_ROW_OFF = 'border-transparent text-muted hover:bg-hover hover:text-fg'

/**
 * 项目下的对话行（照设计稿 Workspace 侧栏）：平时无底、次要色，悬停浅底；
 * 选中是一张白卡片（深色比 card 再亮一档，见 --conv-sel）+ 极淡投影，不描边
 */
export const SIDEBAR_BLOCK_ROW_ON = 'border-transparent bg-conv font-semibold text-fg shadow-conv'
export const SIDEBAR_BLOCK_ROW_OFF = 'border-transparent text-muted hover:bg-hover hover:text-fg'

/** 分组标题（项目 / 对话内容 / 按天）：小一号的次要色，和可点的行靠字号和颜色拉开，不加粗 */
export const SIDEBAR_GROUP_LABEL = 'text-[0.6875rem] text-subtle'

/** 导航行：32 高、14px、500 字重，图标 16px 线宽 1.8；选中 bg-sel */
export const NAV_ROW =
  'flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--c-nav-radius) border px-2 text-[0.875rem] font-medium transition-colors'

/**
 * 侧栏顶部的模式切换（照 Claude 桌面版左上角）：一组小图标按钮靠左排，点哪个切到哪个模式，名字放在悬停提示里。
 * 轨道是比侧栏亮一层的浅底，选中项用 seg-thumb-strong（描边 + 投影），深色下也一眼看得出选的是哪个。
 * 跳转由调用方在 onPick 里做；功能页不属于任何模式，几个都不亮
 */
export function SidebarModeTabs({
  modes,
  onPick,
}: {
  /** label 是完整说明，当作按钮的可访问名称和悬停提示（界面检查按「Agent 模式」这样的前缀定位） */
  modes: { id: string; name: string; label?: string; icon: LucideIcon; on: boolean }[]
  onPick: (id: string) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={t('模式')}
      className="flex shrink-0 gap-0.5 rounded-[calc(var(--c-nav-radius)+2px)] bg-fg/[0.05] p-0.5"
    >
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={m.on}
          aria-label={m.label ?? m.name}
          title={m.label ?? m.name}
          onClick={() => !m.on && onPick(m.id)}
          className={cn(
            'grid h-7 w-9 cursor-pointer place-items-center rounded-(--c-nav-radius) transition-[background-color,color,transform] duration-150 active:scale-[0.94]',
            m.on ? 'seg-thumb-strong' : 'text-muted hover:bg-fg/[0.06] hover:text-fg',
          )}
        >
          {/* 和图标栏同一套线性图标，小一号：模式是次一级的切换；小图标线要粗一点才不显得发虚 */}
          <m.icon className="h-4 w-4" strokeWidth={2.5} />
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
 * 项目行（照设计稿 Workspace 侧栏）：33 高、8px 圆角、不描边，折叠箭头在行外。
 * 未选中无底、悬停浅底；选中是很淡的蓝底（--proj-bg）+ 前景色加粗，文件夹图标换成项目蓝（SidebarProjectName）
 */
export const PROJECT_CARD =
  'flex h-[33px] min-w-0 flex-1 items-center gap-2 rounded-(--c-nav-radius) pr-2 pl-2.5 text-[0.84375rem] transition-colors'
export const PROJECT_CARD_ON = 'bg-proj font-semibold text-fg'
export const PROJECT_CARD_OFF = 'font-medium text-fg hover:bg-hover'

/** 项目行右边的对话数：次要色的纯数字，选中时跟着行加一点字重 */
export function SidebarCount({ n, on, className }: { n: number; on?: boolean; className?: string }) {
  return (
    <span
      className={cn('shrink-0 text-[0.75rem] text-subtle tabular-nums', on ? 'font-medium' : 'font-normal', className)}
    >
      {n}
    </span>
  )
}

/**
 * 项目下的对话列表：左边一道 1px 细竖线把它们挂在项目下面，竖线落在文件夹图标正下方，
 * 行里的文字和项目名的文字左对齐（33px = 折叠箭头 12 + 间距 4 + 行内边距 10 + 图标中线 7）
 */
export function SidebarTaskBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-0.5 ml-[33px] flex flex-col gap-px border-l border-line', className)}>{children}</div>
}

/** 侧栏行尾的浅色小胶囊（等你回复、失败）：18 高、浅底同色字，不用实心底，免得一列里太抢眼 */
const SMALL_PILL = 'h-[18px] gap-1 px-[7px] text-[0.6875rem] font-medium'

/** 行尾的「运行中」类状态：次要色小字 + 运行色小转圈（设计稿：行尾状态做轻） */
function RunTag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        // 不跟着选中行加粗：行尾状态只是次要信息
        'inline-flex shrink-0 items-center gap-[5px] text-[0.71875rem] font-normal whitespace-nowrap text-subtle',
        className,
      )}
    >
      <Spinner className="h-[7px] w-[7px] border-[1.5px] text-run" />
      {children}
    </span>
  )
}

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
  if (kids > 0) return <RunTag>{t('{n} 子对话', { n: kids })}</RunTag>
  if (running) return <RunTag>{t('执行中')}</RunTag>
  if (failed)
    return (
      <StatusPill tone="err" className={SMALL_PILL}>
        {t('失败')}
      </StatusPill>
    )
  // 未读只是一个 6px 强调色圆点（带读屏说明），不写字
  if (unread) return <UnreadDot className="mr-1 h-1.5 w-1.5" />
  return null
}

/** 项目行右边「N 个执行中」：和对话行的运行状态同一个样子（次要色小字 + 小转圈） */
export function ProjectRunning({ n, className }: { n: number; className?: string }) {
  return <RunTag className={className}>{t('{n} 个执行中', { n })}</RunTag>
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
          'grid h-6 w-3 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:text-fg',
          !canToggle && 'invisible',
        )}
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} strokeWidth={2.3} />
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

/**
 * 项目行里的文件夹图标 + 名字。图标统一用合着的文件夹（展开与否看左边的箭头）：
 * 选中的项目是项目蓝，其余是次要色；字重跟着行走（PROJECT_CARD_*）
 */
export function SidebarProjectName({ on, name }: { open?: boolean; on?: boolean; name: ReactNode }) {
  return (
    <>
      <Folder className={cn('h-[15px] w-[15px] shrink-0', on ? 'text-proj-ico' : 'text-subtle')} strokeWidth={2.2} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </>
  )
}

/** 项目下对话行的外框：块里的行（项目下）和不在块里的行（搜索结果）选中时底色不同 */
export function sidebarTaskRowClass(active: boolean, inBlock: boolean) {
  return cn(
    'group/row flex w-full cursor-pointer items-center gap-2 border text-left text-[0.8125rem] transition-colors',
    // 项目下的对话 31 高、离竖线 4px（ml-1，宽度扣掉这 4px）；搜索结果等其他地方还是 32 高的紧凑行
    inBlock
      ? 'ml-1 h-[31px] w-[calc(100%-4px)] rounded-(--c-nav-radius)'
      : 'h-8 rounded-[min(7px,var(--c-nav-radius))]',
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
            'shrink-0 pl-1.5 text-[0.6875rem] font-normal tabular-nums transition-colors',
            active ? 'text-muted' : 'text-subtle group-hover/row:text-muted',
          )}
        >
          {time}
        </span>
      )}
    </span>
  )
}
