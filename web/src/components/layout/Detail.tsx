import { cn } from '@/lib/utils'
import { Check, CircleAlert, Loader2, MoreHorizontal, TriangleAlert } from 'lucide-react'
import type { SaveStatus } from '@/lib/useAutosave'
import { t } from '@shared/i18n'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuTrigger } from '@/components/ui/menu'

/** 右侧详情：头部 + 两栏内容（表单 / 辅助信息） */
export function Detail({
  header,
  tabs,
  body,
  form,
  aside,
}: {
  header: React.ReactNode
  /** 头部下面的标签栏 */
  tabs?: React.ReactNode
  /** 传了就整块替换下面的两栏内容（例如全宽的流程图） */
  body?: React.ReactNode
  form?: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      {header}
      {tabs}
      {body ?? (
        <div className="flex flex-wrap items-start gap-8 px-4 pt-6 pb-10 md:px-8 md:pt-7">
          <div className="flex max-w-[760px] min-w-0 flex-[999_1_440px] flex-col gap-7">{form}</div>
          {/* 不传 aside 就是单栏（角色页）：空的 aside 也会按 flex-basis 占一块位置，所以整个不渲染 */}
          {aside && (
            <aside className="flex max-w-[380px] min-w-0 flex-[1_1_280px] flex-col gap-4 xl:sticky xl:top-7">
              {aside}
            </aside>
          )}
        </div>
      )}
    </main>
  )
}

/** 详情页头部下面的标签栏 */
export function DetailTabs<T extends string>({
  value,
  onChange,
  items,
  label = t('详情页签'),
}: {
  value: T
  onChange: (v: T) => void
  items: { id: T; label: string; icon: React.ComponentType<{ className?: string }>; extra?: React.ReactNode }[]
  /** 页签条的读屏名 */
  label?: string
}) {
  return (
    <TabBar label={label} variant="underline" className="frost sticky top-0 z-10 px-4 md:px-8">
      {items.map(({ id, label, icon: Icon, extra }) => (
        <TabItem key={id} active={value === id} onSelect={() => onChange(id)} icon={<Icon className="h-4 w-4" />}>
          {/* 计数等附加信息跟在名字后面，不套 TabItem 的 tag 胶囊（调用方自己画好了） */}
          <span className="inline-flex items-center gap-1.5">
            {label}
            {extra}
          </span>
        </TabItem>
      ))}
    </TabBar>
  )
}

export function DetailHeader({
  leading,
  title,
  meta,
  subtitle,
  actions,
  save,
  more,
  quietSave,
  compact,
}: {
  leading: React.ReactNode
  title: string
  meta?: React.ReactNode
  subtitle: string
  actions: React.ReactNode
  save: { status: SaveStatus; error: string; invalid?: string }
  /** 「⋯」菜单里的项（MenuItem）：复制、导出、删除这类不常用的操作收进去，头部只留主操作 */
  more?: React.ReactNode
  /** 自动保存成功时不显示「已自动保存」，只在保存中、失败、名称为空时出来（一切正常不占位置） */
  quietSave?: boolean
  /** 紧凑头部（角色页、技能页）：上下留白收小，简介最多两行，按钮用 sm 档 */
  compact?: boolean
}) {
  return (
    <header
      className={cn('flex flex-wrap items-center border-b bg-bg px-4 md:px-8', compact ? 'gap-3 py-4' : 'gap-4 py-5')}
    >
      {leading}
      <div className="min-w-0 flex-[1_1_240px]">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-xl font-semibold">{title}</h2>
          {meta}
        </div>
        <p
          className={cn('text-body text-muted', compact ? 'line-clamp-2 leading-relaxed' : 'truncate')}
          title={subtitle}
        >
          {subtitle}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!(quietSave && (save.status === 'saved' || save.status === 'idle') && !save.invalid) && (
          <SaveIndicator {...save} />
        )}
        {actions}
        {more && (
          <Menu>
            <MenuTrigger asChild>
              <Button
                variant="secondary"
                size={compact ? 'icon-sm' : 'icon'}
                aria-label={t('更多操作')}
                title={t('更多操作')}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </MenuTrigger>
            <MenuContent className="min-w-[180px]">{more}</MenuContent>
          </Menu>
        )}
      </div>
    </header>
  )
}

/** 详情页头部下面的一行问题提示：只在有问题时出现，一切正常不占位置（替代常驻的「就绪检查」卡片） */
export function IssueBar({
  issues,
}: {
  issues: { label: string; hint?: string; action?: { label: string; onClick: () => void } }[]
}) {
  if (!issues.length) return null
  return (
    <div role="status" className="flex flex-col gap-1 border-b bg-warning/8 px-4 py-2 md:px-8">
      {issues.map((i) => (
        <div key={i.label} className="flex min-w-0 items-center gap-2 text-body text-warning">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0 font-medium">{i.label}</span>
          {i.hint && <span className="min-w-0 truncate text-footnote text-muted">{i.hint}</span>}
          {i.action && (
            <Button variant="link" tone="warning" className="ml-auto shrink-0 text-footnote" onClick={i.action.onClick}>
              {i.action.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

export function SaveIndicator({ status, error, invalid }: { status: SaveStatus; error: string; invalid?: string }) {
  if (invalid)
    return (
      <span className="flex items-center gap-1.5 text-xs text-warning">
        <CircleAlert className="h-3.5 w-3.5" />
        {invalid}
      </span>
    )
  if (status === 'error')
    return (
      <span className="flex max-w-60 items-center gap-1.5 truncate text-xs text-danger" title={error}>
        <CircleAlert className="h-3.5 w-3.5 shrink-0" />
        {t('保存失败：{error}', { error })}
      </span>
    )
  if (status === 'pending' || status === 'saving')
    return (
      <span className="flex items-center gap-1.5 text-xs text-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('保存中')}
      </span>
    )
  return (
    <span className="flex items-center gap-1.5 text-xs text-subtle">
      <Check className="h-3.5 w-3.5" />
      {t('已自动保存')}
    </span>
  )
}

export function DetailEmpty({
  icon,
  title,
  children,
  desktopOnly,
}: {
  icon: React.ReactNode
  title: string
  children?: React.ReactNode
  /** 只是「请在左边选一项」的提示：手机上列表已经占满屏幕，不再显示 */
  desktopOnly?: boolean
}) {
  return (
    <main className={cn('flex min-h-[420px] flex-1 items-center justify-center p-8', desktopOnly && 'hidden md:flex')}>
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-accent-soft text-accent-text">{icon}</div>
        <h2 className="mt-4 text-base font-semibold">{title}</h2>
        <div className="mt-2 text-body leading-relaxed text-muted">{children}</div>
      </div>
    </main>
  )
}
