import { Check, ChevronRight, MoreHorizontal, Pencil, Play, Trash2, X } from 'lucide-react'
import {
  isoWeekday,
  outcomeLabel,
  outcomeOf,
  relativeFuture,
  repeatLabel,
  runLabel,
  SCHEDULE_WEEKDAYS,
  type Schedule,
} from '@shared/schedule'
import { hhmm, ymd } from '@shared/datetime'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { Switch } from '@/components/ui/switch'
import { dayTimeLabel, scheduleDot, upcomingRuns } from './occurrences'

/** 字段名：小号、加粗、淡色，和设计稿的分组标签一致 */
function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.6875rem] font-semibold tracking-wide text-subtle">{children}</span>
}

/**
 * 一个字段：值放在浅底的格子里（不描边，靠底色分）。整格可点，点了打开编辑弹窗——
 * 改计划仍走编辑弹窗那一条保存路径（排期冲突检查、成环检查都在那里），这里只负责看
 */
function Field({
  label,
  onEdit,
  className,
  children,
}: {
  label: string
  onEdit: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      <button
        type="button"
        onClick={onEdit}
        title={t('编辑')}
        className={cn(
          'flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg bg-field px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors hover:bg-sel',
          className,
        )}
      >
        {children}
      </button>
    </div>
  )
}

/** 每周的计划写清是哪几天；没勾星期时按 at 那天（和 shared/schedule 的 repeatDays 同一口径） */
function repeatText(s: Schedule): string {
  if (s.repeat !== 'weekly') return repeatLabel(s.repeat)
  const at = new Date(s.at)
  const days = s.weekdays.length ? s.weekdays : Number.isFinite(at.getTime()) ? [isoWeekday(at)] : []
  const names = days.map((d) => SCHEDULE_WEEKDAYS[d - 1]?.label).filter(Boolean)
  return names.length ? `${repeatLabel(s.repeat)} · ${names.join(t('、'))}` : repeatLabel(s.repeat)
}

/**
 * 计划页右侧的详情面板（照设计稿）：开关、要做什么、项目、日期时间、重复、接下来几次、运行记录，
 * 底部「现在运行一次」和「编辑」。数据和操作都是页面传进来的，和列表卡片同一套。
 */
export function ScheduleDetail({
  schedule: s,
  now,
  projectName,
  agentName,
  upstreams,
  busy,
  taskTitle,
  onEdit,
  onRun,
  onToggle,
  onDelete,
  onOpenTask,
  onClose,
}: {
  schedule: Schedule
  now: number
  projectName: string
  agentName: string
  upstreams: string[]
  busy: boolean
  taskTitle: (taskId: string) => string
  onEdit: () => void
  onRun: () => void
  onToggle: (on: boolean) => void
  onDelete: () => void
  onOpenTask: (taskId: string) => void
  /** 窄屏时面板是滑出来的浮层，要能关掉；宽屏常驻，不给关闭按钮 */
  onClose: () => void
}) {
  const at = new Date(s.at)
  const valid = Number.isFinite(at.getTime())
  const next = upcomingRuns(s)
  const outcome = outcomeOf(s)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 rounded-full', scheduleDot(s.id))} />
        <h2 className={cn('min-w-0 flex-1 truncate text-[0.9375rem] font-semibold', !s.enabled && 'text-muted')}>
          {s.name}
        </h2>
        <Switch
          checked={s.enabled}
          onCheckedChange={onToggle}
          aria-label={s.enabled ? t('停用') : t('启用')}
          title={s.enabled ? t('停用') : t('启用')}
        />
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('计划操作')} title={t('计划操作')}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
              {t('编辑')}
            </MenuItem>
            <MenuItem danger onSelect={onDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('删除')}
            </MenuItem>
          </MenuContent>
        </Menu>
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label={t('关闭')}
          title={t('关闭')}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <Field label={t('要做什么')} onEdit={onEdit}>
          <span className="shrink-0 rounded bg-sel px-1 text-[0.6875rem] text-subtle">
            {agentName || t('跟随默认 CLI')}
          </span>
          <span className="min-w-0 truncate">{s.prompt}</span>
        </Field>
        <Field label={t('项目')} onEdit={onEdit}>
          <span className="truncate">{projectName || t('聊天')}</span>
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label={t('日期')} onEdit={onEdit} className="tabular-nums">
            {valid ? ymd(at) : '—'}
          </Field>
          <Field label={t('时间')} onEdit={onEdit} className="font-mono tabular-nums">
            {valid ? hhmm(at) : '—'}
          </Field>
        </div>
        <Field label={t('重复')} onEdit={onEdit}>
          {repeatText(s)}
        </Field>
        {!!upstreams.length && (
          <Field label={t('上游')} onEdit={onEdit}>
            <span className="truncate">{upstreams.join(t('、'))}</span>
          </Field>
        )}

        {/* 接下来几次：和服务端排期同一套规则推出来；停用或单次跑完时写清不会再跑 */}
        <section className="flex flex-col gap-1.5 rounded-xl bg-panel p-3">
          <Label>{t('接下来')}</Label>
          {next.length ? (
            next.map((ms) => (
              <div key={ms} className="flex items-center gap-2 text-[0.78125rem]">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
                <span className="flex-1 tabular-nums">{dayTimeLabel(ms)}</span>
                <span className="text-[0.6875rem] text-subtle">{relativeFuture(new Date(ms).toISOString(), now)}</span>
              </div>
            ))
          ) : (
            <span className="text-[0.78125rem] text-subtle">{t('不会再次执行')}</span>
          )}
        </section>

        {/* 最近一次没跑成的原因：直接显示原文，不吞 */}
        {(outcome === 'error' || outcome === 'missed' || outcome === 'blocked') && (
          <p className="text-xs break-words whitespace-pre-wrap text-warning">
            {outcome === 'error' ? s.lastError : outcomeLabel(s, now)}
          </p>
        )}

        <section className="flex flex-col gap-0.5">
          <Label>{t('运行记录')}</Label>
          {s.runs.length ? (
            <ul className="flex flex-col">
              {s.runs.map((run, i) => {
                const ok = run.event === 'run'
                return (
                  <li key={`${run.happenedAt}-${i}`} className="flex flex-col gap-0.5 py-1.5">
                    <div className="flex items-center gap-2 text-[0.78125rem]">
                      <span
                        aria-hidden
                        className={cn(
                          'grid h-4 w-4 shrink-0 place-items-center rounded-full',
                          ok ? 'bg-success/12 text-success' : 'bg-danger/10 text-danger',
                        )}
                      >
                        {ok ? (
                          <Check className="h-2.5 w-2.5" strokeWidth={3} />
                        ) : (
                          <X className="h-2.5 w-2.5" strokeWidth={3} />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate tabular-nums">
                        {dayTimeLabel(Date.parse(run.at || run.happenedAt))}
                        {run.manual && <span className="text-subtle"> · {t('手动执行')}</span>}
                      </span>
                      {run.taskId ? (
                        <button
                          type="button"
                          onClick={() => onOpenTask(run.taskId)}
                          className="inline-flex max-w-[45%] min-w-0 cursor-pointer items-center gap-0.5 text-[0.6875rem] text-subtle hover:text-fg"
                        >
                          <span className="truncate">{taskTitle(run.taskId) || t('打开对话')}</span>
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        </button>
                      ) : (
                        <span className={cn('text-[0.6875rem]', ok ? 'text-subtle' : 'text-danger')}>
                          {runLabel(run)}
                        </span>
                      )}
                    </div>
                    {run.error ? (
                      <p className="pl-6 text-[0.6875rem] break-words whitespace-pre-wrap text-warning">{run.error}</p>
                    ) : run.event === 'miss' ? (
                      <p className="pl-6 text-[0.6875rem] text-subtle">{t('面板当时没在跑，不补跑')}</p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <span className="py-1.5 text-[0.78125rem] text-subtle">{t('还没执行')}</span>
          )}
        </section>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-3">
        <Button size="sm" variant="secondary" disabled={busy} onClick={onRun}>
          <Play className="h-3.5 w-3.5" />
          {t('现在运行一次')}
        </Button>
        <Button size="sm" className="ml-auto" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          {t('编辑')}
        </Button>
      </footer>
    </div>
  )
}
