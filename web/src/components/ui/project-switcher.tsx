import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronsUpDown, Folder, FolderPlus, Loader2, Settings } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { IconButton } from './icon-button'
import { NAV_ROW, SIDEBAR_GROUP_LABEL, SIDEBAR_ROW_OFF, SIDEBAR_ROW_ON } from './sidebar'
import { menuItem } from './menu'

// 方案 B 侧栏（设计稿：Agent侧栏与项目管理重设计）的部件：顶上的项目切换器、下拉里的项目行和「新建项目」行、
// 「项目工具」的标题和工具行、没有项目时的大按钮。侧栏和设置 →「组件」的样例都用这一份，外观只在这里定义。
// 行高、圆角跟着侧栏导航行走（--c-nav-radius，设置 →「组件」里调 nav 时一起变）

/**
 * 侧栏顶上的当前项目切换器：文件夹图标（项目蓝）+ 项目名 + 一行小字（分类、执行中数量），行尾上下箭头。
 * 平时是比侧栏亮一层的底（bg-sel），点开是项目下拉；alert 时右上角一个黄点：别的项目有事等你处理
 */
export const ProjectSwitcherButton = forwardRef<
  HTMLButtonElement,
  {
    name: ReactNode
    meta?: ReactNode
    /** 别的项目有对话在等你处理：给文字时写进悬停提示和读屏说明 */
    alert?: string
  } & ButtonHTMLAttributes<HTMLButtonElement>
>(function ProjectSwitcherButton({ name, meta, alert, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'press flex h-12 w-full cursor-pointer items-center gap-2.5 rounded-(--c-nav-radius) bg-sel pr-2 pl-2.5 text-left transition-colors hover:bg-hover',
        'outline-none focus-visible:ring-2 focus-visible:ring-focus-soft',
        className,
      )}
      {...rest}
    >
      <Folder className="h-4 w-4 shrink-0 text-proj-ico" strokeWidth={2.2} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-prose font-semibold text-fg">{name}</span>
        {meta && <span className="truncate text-caption text-subtle">{meta}</span>}
      </span>
      <span className="relative grid h-6 w-5 shrink-0 place-items-center text-subtle">
        <ChevronsUpDown className="h-3.5 w-3.5" strokeWidth={2.2} />
        {alert && (
          <span
            aria-hidden
            title={alert}
            className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-warning ring-2 ring-rail"
          />
        )}
      </span>
      {alert && <span className="sr-only">{alert}</span>}
    </button>
  )
})

/**
 * 盖住侧栏的项目工具页（UE、表格）导航栏顶上的项目卡片：和项目切换器同一个外形（bg-sel、导航行圆角），
 * 左边一个返回箭头，点一下回到项目对话。icon 换成工具自己的图标（UE 是手柄），meta 写工具自己的一行小字
 */
export function ProjectBackButton({
  name,
  meta,
  icon: Icon = Folder,
  className,
  ...rest
}: {
  name: ReactNode
  meta?: ReactNode
  icon?: (p: { className?: string; strokeWidth?: number }) => ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'name'>) {
  return (
    <button
      type="button"
      title={t('回到项目对话')}
      aria-label={typeof name === 'string' ? t('回到项目对话：{name}', { name }) : t('回到项目对话')}
      className={cn(
        'group/back press flex h-12 w-full cursor-pointer items-center gap-1.5 rounded-(--c-nav-radius) bg-sel pr-2.5 pl-1.5 text-left transition-colors hover:bg-hover',
        'outline-none focus-visible:ring-2 focus-visible:ring-focus-soft',
        className,
      )}
      {...rest}
    >
      <ChevronLeft
        className="h-4 w-4 shrink-0 text-subtle transition-transform group-hover/back:-translate-x-0.5 group-hover/back:text-fg"
        strokeWidth={2.2}
      />
      <Icon className="mr-1 h-4 w-4 shrink-0 text-proj-ico" strokeWidth={2.2} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-prose font-semibold text-fg">{name}</span>
        {meta && <span className="truncate text-caption text-subtle">{meta}</span>}
      </span>
    </button>
  )
}

/** 下拉里的一个项目：文件夹 + 名字 + 行尾状态（执行中、等你处理、对话数），当前项目打勾 */
export function ProjectPickerRow({
  name,
  status,
  on,
  className,
  ...rest
}: {
  name: ReactNode
  status?: ReactNode
  on?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-current={on ? 'true' : undefined}
      className={cn(menuItem, 'h-9 py-0', on && 'bg-sel font-medium', className)}
      {...rest}
    >
      <Folder className={cn('h-4 w-4 shrink-0', on ? 'text-proj-ico' : 'text-subtle')} strokeWidth={2.1} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {status}
      <Check className={cn('h-3.5 w-3.5 shrink-0', on ? 'text-fg' : 'invisible')} strokeWidth={2.4} />
    </button>
  )
}

/** 下拉里搜索框下面第一行「新建项目」：描边、项目蓝图标，右边一句小字说明要做什么 */
export function ProjectNewRow({
  hint,
  className,
  ...rest
}: { hint?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cn(menuItem, 'h-9 border border-line py-0 font-medium', className)} {...rest}>
      <FolderPlus className="h-4 w-4 shrink-0 text-proj-ico" strokeWidth={2.1} />
      <span className="min-w-0 flex-1 truncate">{t('新建项目')}</span>
      {hint && <span className="shrink-0 text-caption text-subtle">{hint}</span>}
    </button>
  )
}

/** 下拉里的分组标题（项目分类） */
export function ProjectPickerGroup({ label }: { label: ReactNode }) {
  return <p className={cn('px-2.5 pt-2 pb-1', SIDEBAR_GROUP_LABEL)}>{label}</p>
}

/** 「项目工具」的标题：小字标题，右边齿轮打开项目设置 */
export function ProjectToolsHeader({ onSettings, label }: { onSettings?: () => void; label?: ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center pr-1 pl-2">
      <span className={cn('flex-1', SIDEBAR_GROUP_LABEL)}>{label ?? t('项目工具')}</span>
      {onSettings && <IconButton icon={Settings} label={t('项目设置')} size="sm" onClick={onSettings} />}
    </div>
  )
}

/**
 * 项目工具的一行（表格、UE、技能与 MCP、经验与文档）：和导航行一样高、一样的选中底，
 * 行尾是这项工具的状态小字（「312 张」「已连接」）或提示点
 */
export function ProjectToolRow({
  icon: Icon,
  label,
  on,
  meta,
  dot,
  className,
  ...rest
}: {
  icon: (p: { className?: string; strokeWidth?: number }) => ReactNode
  label: string
  on?: boolean
  meta?: ReactNode
  /** 提示点：给文字时写进悬停提示 */
  dot?: string | boolean
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const hint = typeof dot === 'string' ? dot : undefined
  return (
    <button
      type="button"
      aria-current={on ? 'page' : undefined}
      title={hint}
      className={cn(NAV_ROW, on ? cn(SIDEBAR_ROW_ON, 'font-medium') : SIDEBAR_ROW_OFF, className)}
      {...rest}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={2.1} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {meta && <span className="shrink-0 text-caption font-normal text-subtle tabular-nums">{meta}</span>}
      {dot && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
    </button>
  )
}

/** 项目列表还在取：占住切换器的位置（同样高），取到后换成切换器或「添加第一个项目」 */
export function ProjectPickerLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex h-12 w-full items-center gap-2 rounded-(--c-nav-radius) px-3 text-prose text-subtle"
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      {t('正在读取项目…')}
    </div>
  )
}

/** 一个项目都没有时，切换器的位置换成这个大按钮和一句说明 */
export function AddFirstProject({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onClick}
        className="press flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-(--c-nav-radius) border border-dashed border-line-strong text-prose font-medium text-fg transition-colors hover:bg-hover"
      >
        <FolderPlus className="h-4 w-4 text-proj-ico" strokeWidth={2.1} />
        {t('添加第一个项目')}
      </button>
      <p className="px-1 text-caption leading-relaxed text-subtle">
        {t('项目就是本机上的一个代码目录，Agent 会在里面执行任务。')}
      </p>
    </div>
  )
}
