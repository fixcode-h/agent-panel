import { CheckSquare, Folder, MessageSquare, SquareArrowOutUpRight } from 'lucide-react'
import { t } from '@shared/i18n'
import type { OverviewRow } from '@shared/overview'
import { timeAgo } from '@shared/task'
import { liveWaitText } from '@shared/live/task-live'
import { useLive } from '@/lib/live/store'
import { fmtTokens } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { StatusPill } from '@/components/ui/status-pill'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/menu'
import { TaskRenameInput, useTaskRowMenu } from '@/components/tasks/TaskMenu'

/**
 * 对话总览里的一行。右键菜单和侧栏任务行同一份（useTaskRowMenu：暂停 / 继续、激活 / 关闭 Agent、重命名、
 * 置顶、归档、删除），前面加总览自己的「打开」「选择」：总览是从这里批量管对话的，右键也能进多选
 */
export function OverviewTaskRow({
  r,
  project,
  picked,
  selecting,
  onPick,
  onOpen,
}: {
  r: OverviewRow
  project: string
  picked: boolean
  /** 已经勾了别的行：所有行都直接露出勾选框，不用一行行悬停 */
  selecting: boolean
  onPick: () => void
  onOpen: () => void
}) {
  const { task, state, plan } = r
  const menu = useTaskRowMenu(task)
  const busy = state === 'running' || state === 'waiting'
  const live = useLive(task)
  const note = state === 'waiting' ? liveWaitText(live) : r.group === 'stalled' ? t('没在执行') : ''
  const ProjectIcon = task.projectId ? Folder : MessageSquare
  const showBox = picked || selecting
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <li
            className={cn(
              'group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-sel/60',
              picked && 'bg-accent-soft/70 hover:bg-accent-soft',
            )}
            data-overview-row={task.id}
          >
            {/* 行首平时是对话类型的图标，悬停或进入多选后换成勾选框 */}
            <span className="relative grid h-8 w-8 shrink-0 place-items-center">
              <span
                aria-hidden
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-lg bg-sel text-muted transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 [@media(hover:none)]:opacity-0',
                  showBox && 'opacity-0',
                )}
              >
                <ProjectIcon className="h-4 w-4" />
              </span>
              <Checkbox
                checked={picked}
                onChange={onPick}
                ariaLabel={t('选择「{title}」', { title: task.title })}
                className={cn(
                  'absolute inset-0 grid place-items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
                  showBox && 'opacity-100',
                )}
              />
            </span>
            {menu.renaming ? (
              // 重命名时标题换成行内输入框，项目名那一行先收起：输入框和侧栏同一个
              <span className="flex min-w-0 flex-1">
                <TaskRenameInput
                  task={task}
                  onCommit={menu.rename}
                  onCancel={() => menu.setRenaming(false)}
                  className="flex-1"
                />
              </span>
            ) : (
              <button
                type="button"
                onClick={onOpen}
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
              >
                <span className="truncate text-prose text-fg">{task.title}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                  <span className="truncate">{project}</span>
                  {note && (
                    <>
                      <span className="text-subtle">·</span>
                      <span className={cn('truncate', r.group === 'stalled' && 'text-warning')}>{note}</span>
                    </>
                  )}
                </span>
              </button>
            )}
            <span className="hidden w-28 shrink-0 flex-col gap-1 md:flex">
              {plan && (
                <>
                  <span className="text-caption text-subtle tabular-nums">
                    {t('计划 {done}/{total}', { done: plan.done, total: plan.total })}
                  </span>
                  <Progress
                    value={plan.done}
                    max={plan.total}
                    size="xs"
                    raw
                    tone={r.group === 'stalled' ? 'warning' : busy ? 'run' : 'accent'}
                    label={t('计划进度')}
                  />
                </>
              )}
            </span>
            <span className="hidden w-16 shrink-0 text-right font-mono text-xs text-subtle tabular-nums sm:block">
              {r.tokens ? fmtTokens(r.tokens) : ''}
            </span>
            <span className="w-16 shrink-0 text-right text-xs text-subtle tabular-nums">{timeAgo(task.updatedAt)}</span>
            <span className="flex w-24 shrink-0 justify-end max-sm:w-auto">
              <RowStatus r={r} busy={busy} />
            </span>
          </li>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOpen}>
            <SquareArrowOutUpRight className="h-4 w-4" />
            {t('打开')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onPick}>
            <CheckSquare className="h-4 w-4" />
            {picked ? t('取消选择') : t('选择')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {menu.items}
        </ContextMenuContent>
      </ContextMenu>
      {menu.confirm}
    </>
  )
}

/** 行尾状态：口径和侧栏的 TaskRowStatus 一样，这里统一画成胶囊，做完没看也写出字来，扫一眼就知道是哪种 */
function RowStatus({ r, busy }: { r: OverviewRow; busy: boolean }) {
  const { state } = r
  if (state === 'needs') return <StatusPill tone="wait">{t('等你回复')}</StatusPill>
  if (busy && r.kidsBusy > 0)
    return (
      <StatusPill tone="run" spin>
        {t('{n} 子对话', { n: r.kidsBusy })}
      </StatusPill>
    )
  if (busy)
    return (
      <StatusPill tone="run" spin>
        {t('执行中')}
      </StatusPill>
    )
  if (state === 'failed') return <StatusPill tone="err">{t('失败')}</StatusPill>
  if (r.group === 'you' && state === 'done') return <StatusPill tone="ok">{t('待查看')}</StatusPill>
  return null
}
