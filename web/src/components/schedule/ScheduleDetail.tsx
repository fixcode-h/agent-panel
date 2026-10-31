import { useEffect } from 'react'
import { Check, ChevronRight, MoreHorizontal, Play, Settings2, Trash2, X } from 'lucide-react'
import {
  durationLabel,
  outcomeLabel,
  outcomeOf,
  relativeFuture,
  runLabel,
  scheduleEnded,
  SCHEDULE_WEEKDAYS,
  type Schedule,
  type ScheduleRun,
} from '@shared/schedule'
import { t } from '@shared/i18n'
import { listableAgents } from '@shared/builtin/core'
import { openAiFix } from '@/lib/ai-fix'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { EndChoice } from './EndChoice'
import { dayTimeLabel, scheduleDot, upcomingRuns } from './occurrences'
import { durationOptions, REPEAT_OPTIONS, useScheduleForm } from './use-schedule-form'

/** 字段名：小号、加粗、淡色，和设计稿的分组标签一致 */
function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-caption font-semibold tracking-wide text-subtle">
      {children}
    </label>
  )
}

/** 一个字段：标签在上、控件在下（照设计稿的 .fld） */
function Field({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

/** 一次运行算不算「没跑成」：启动失败，或启动了但对话这一轮以失败结束——这两种给「AI 分析」 */
const runFailed = (run: ScheduleRun) => run.event === 'fail' || (run.event === 'run' && !!run.failed)

/**
 * 计划页右侧的详情面板（照设计稿）：字段直接改——要做什么、项目、开始日期、时间、重复、结束、启停，
 * 底部「现在运行一次」和「保存」（有改动才可点）。保存和编辑弹窗走同一个 useScheduleForm，
 * 排期冲突、结束日期、依赖成环的校验都是那一套。上游和执行上限字段多、改得少，留在「更多设置」弹窗里。
 */
export function ScheduleDetail({
  schedule: s,
  schedules,
  now,
  upstreams,
  busy,
  taskTitle,
  onEdit,
  onRun,
  onDelete,
  onOpenTask,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  schedule: Schedule
  /** 全部计划：保存前查依赖成环 */
  schedules: Schedule[]
  now: number
  upstreams: string[]
  busy: boolean
  taskTitle: (taskId: string) => string
  /** 打开编辑弹窗（上游、执行上限在那里改） */
  onEdit: () => void
  onRun: () => void
  onDelete: () => void
  onOpenTask: (taskId: string) => void
  /** 窄屏时面板是滑出来的浮层，要能关掉；宽屏常驻，不给关闭按钮 */
  onClose: () => void
  onSaved: (s: Schedule) => void
  /** 有没有没保存的改动：页面切换到别的计划前据此确认 */
  onDirtyChange: (dirty: boolean) => void
}) {
  const { projects, agents } = useData()
  const { form, set, setRepeat, setAtLocal, toggleWeekday, dirty, saving, save } = useScheduleForm({
    schedule: s,
    schedules,
    onSaved,
    inline: true,
  })
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  // 面板没了（计划被删、切到列表）就不再有没保存的改动，别让页面一直以为还有
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const next = upcomingRuns(s)
  const ended = scheduleEnded(s)
  const outcome = outcomeOf(s)
  const date = form.atLocal.slice(0, 10)
  const time = form.atLocal.slice(11, 16)
  // 「子任务」不再作为可选角色展示，但老计划可能已经选过它：补一项显示名字（和编辑弹窗同一口径）
  const pickable = listableAgents(agents)
  const unpickable =
    form.agentId && !pickable.some((a) => a.id === form.agentId) ? agents.find((a) => a.id === form.agentId) : undefined
  const projectName = projects.find((p) => p.id === s.projectId)?.name ?? ''

  /** 没跑成的那次交给 AI 分析：报错原文 + 计划的设置，归属跟着计划走（项目里的开项目对话，其余开 Chat） */
  const analyze = (run: ScheduleRun) =>
    openAiFix({
      title: t('计划「{name}」没有跑成', { name: s.name }),
      error: run.error || t('对话执行失败'),
      context: [
        t('计划：{name}', { name: s.name }),
        t('到点时间：{time}', { time: run.at || run.happenedAt }),
        t('项目：{name}', { name: projectName || t('聊天') }),
        ...(run.taskId ? [t('启动的对话 id：{id}', { id: run.taskId })] : []),
        '',
        t('到点后执行的对话内容：'),
        s.prompt,
      ].join('\n'),
      topic: 'schedule',
      ...(s.projectId ? { home: { kind: 'project' as const, projectId: s.projectId } } : {}),
    })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 rounded-full', scheduleDot(s.id))} />
        {/* 名字也能直接改：平时看着是标题，悬停 / 聚焦才出底色 */}
        <input
          aria-label={t('名称')}
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          className={cn(
            'h-8 min-w-0 flex-1 truncate rounded-md bg-transparent px-1 -ml-1 text-heading font-semibold outline-none hover:bg-field focus:bg-field',
            !form.enabled && 'text-muted',
          )}
        />
        <Switch
          checked={form.enabled}
          onCheckedChange={(on) => set('enabled', on)}
          aria-label={form.enabled ? t('停用') : t('启用')}
          title={form.enabled ? t('停用') : t('启用')}
        />
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('计划操作')} title={t('计划操作')}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={onEdit}>
              <Settings2 className="h-3.5 w-3.5" />
              {t('更多设置')}
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
        <Field label={t('要做什么')} id="schedule-detail-prompt">
          <Textarea
            id="schedule-detail-prompt"
            rows={3}
            className="text-body"
            value={form.prompt}
            placeholder={t('交给 Agent 的一句话目标，例如：总结今天做的工作')}
            onChange={(e) => set('prompt', e.target.value)}
          />
          <Select
            className="h-8 text-body"
            value={form.agentId}
            aria-label={t('用哪个角色')}
            options={[
              { value: '', label: t('不用角色（跟随默认 CLI）') },
              ...pickable.map((a) => ({
                value: a.id,
                label: a.enabled ? a.name : t('{name}（已停用）', { name: a.name }),
              })),
              ...(unpickable
                ? [{ value: unpickable.id, label: t('{name}（不可选）', { name: unpickable.name }) }]
                : []),
            ]}
            onChange={(e) => set('agentId', e.target.value)}
          />
        </Field>
        <Field label={t('项目')}>
          <Select
            className="h-8 text-body"
            value={form.projectId}
            aria-label={t('项目')}
            options={[
              { value: '', label: t('聊天（不属于项目）') },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(e) => set('projectId', e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label={t('开始日期')} id="schedule-detail-date">
            <Input
              id="schedule-detail-date"
              type="date"
              className="h-8 text-body tabular-nums dark:[color-scheme:dark]"
              value={date}
              onChange={(e) => e.target.value && setAtLocal(`${e.target.value}T${time || '09:00'}`)}
            />
          </Field>
          <Field label={t('时间')} id="schedule-detail-time">
            <Input
              id="schedule-detail-time"
              type="time"
              className="h-8 font-mono text-body tabular-nums dark:[color-scheme:dark]"
              value={time}
              onChange={(e) => e.target.value && date && setAtLocal(`${date}T${e.target.value}`)}
            />
          </Field>
        </div>
        {/* 日历上占多长：周视图里拖底边也能改 */}
        <Field label={t('时长')}>
          <Select
            size="sm"
            aria-label={t('时长')}
            value={String(form.durationMin)}
            options={durationOptions(form.durationMin)}
            onChange={(e) => set('durationMin', Number(e.target.value))}
          />
        </Field>
        <Field label={t('重复')}>
          <Segmented fill label={t('重复')} value={form.repeat} onChange={setRepeat} options={REPEAT_OPTIONS} />
        </Field>
        {form.repeat === 'weekly' && (
          <Field label={t('每周哪几天')}>
            <div role="group" aria-label={t('每周哪几天')} className="flex flex-wrap gap-1.5">
              {SCHEDULE_WEEKDAYS.map((d) => {
                const on = form.weekdays.includes(d.id)
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={on}
                    aria-label={d.label}
                    title={d.label}
                    onClick={() => toggleWeekday(d.id)}
                    className={cn(
                      'grid h-8 w-8 cursor-pointer place-items-center rounded-full text-footnote transition-colors',
                      on ? 'bg-fg font-semibold text-bg' : 'bg-sel text-muted hover:text-fg',
                    )}
                  >
                    {/* 圆里只放一个字（一、二…），完整的星期名在 aria-label 里 */}
                    {d.label.slice(-1)}
                  </button>
                )
              })}
            </div>
          </Field>
        )}
        {form.repeat !== 'once' && (
          <Field label={t('结束')}>
            <EndChoice compact value={form.endDate} onChange={(v) => set('endDate', v)} />
          </Field>
        )}
        {!!upstreams.length && (
          <Field label={t('上游')}>
            <button
              type="button"
              onClick={onEdit}
              title={t('更多设置')}
              className="flex min-h-8 cursor-pointer items-center rounded-lg bg-field px-2.5 text-left text-body transition-colors hover:bg-sel"
            >
              <span className="truncate">{upstreams.join(t('、'))}</span>
            </button>
          </Field>
        )}

        {/* 接下来几次：按已保存的排期推出来（和服务端同一套规则）；过了结束日期写「已结束」 */}
        <section className="flex flex-col gap-1.5 rounded-xl bg-panel p-3">
          <span className="text-caption font-semibold tracking-wide text-subtle">{t('接下来')}</span>
          {next.length ? (
            next.map((ms) => (
              <div key={ms} className="flex items-center gap-2 text-footnote">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
                <span className="flex-1 tabular-nums">{dayTimeLabel(ms)}</span>
                <span className="text-caption text-subtle">{relativeFuture(new Date(ms).toISOString(), now)}</span>
              </div>
            ))
          ) : (
            <span className="text-footnote text-subtle">
              {ended && s.enabled ? t('已结束（{date}）', { date: s.endDate }) : t('不会再次执行')}
            </span>
          )}
        </section>

        {/* 最近一次没跑成的原因：直接显示原文，不吞 */}
        {(outcome === 'error' || outcome === 'missed' || outcome === 'blocked') && (
          <p className="text-xs break-words whitespace-pre-wrap text-warning">
            {outcome === 'error' ? s.lastError : outcomeLabel(s, now)}
          </p>
        )}

        <section className="flex flex-col gap-0.5">
          <span className="text-caption font-semibold tracking-wide text-subtle">{t('运行记录')}</span>
          {s.runs.length ? (
            <ul className="flex flex-col">
              {s.runs.map((run, i) => {
                const failed = runFailed(run)
                const ok = run.event === 'run' && !failed
                return (
                  <li key={`${run.happenedAt}-${i}`} className="flex flex-col gap-0.5 py-1.5">
                    <div className="flex items-center gap-2 text-footnote">
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
                      {/* 跑完的写耗时（旧记录、还没跑完的没有就不写）；没跑成的给「AI 分析」 */}
                      {!!run.durationMs && !failed && (
                        <span className="shrink-0 font-mono text-caption text-subtle tabular-nums" title={t('耗时')}>
                          {durationLabel(run.durationMs)}
                        </span>
                      )}
                      {failed ? (
                        <Button
                          variant="link"
                          tone="danger"
                          onClick={() => analyze(run)}
                          className="shrink-0 gap-0.5 text-caption"
                        >
                          {t('失败 · AI 分析')}
                          <ChevronRight className="h-3 w-3" />
                        </Button>
                      ) : run.taskId ? (
                        <Button
                          variant="link"
                          tone="muted"
                          onClick={() => onOpenTask(run.taskId)}
                          className="max-w-[45%] min-w-0 gap-0.5 text-caption"
                        >
                          <span className="truncate">{taskTitle(run.taskId) || t('打开对话')}</span>
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        </Button>
                      ) : (
                        <span className={cn('text-caption', ok ? 'text-subtle' : 'text-danger')}>{runLabel(run)}</span>
                      )}
                    </div>
                    {run.error ? (
                      <p className="pl-6 text-caption break-words whitespace-pre-wrap text-warning">{run.error}</p>
                    ) : run.event === 'miss' ? (
                      <p className="pl-6 text-caption text-subtle">{t('面板当时没在跑，不补跑')}</p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <span className="py-1.5 text-footnote text-subtle">{t('还没执行')}</span>
          )}
        </section>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-3">
        {/* 按已保存的设置跑：改到一半没保存的不算 */}
        <Button size="sm" variant="secondary" disabled={busy} onClick={onRun}>
          <Play className="h-3.5 w-3.5" />
          {t('现在运行一次')}
        </Button>
        {dirty && <span className="ml-auto text-caption text-subtle">{t('有未保存的改动')}</span>}
        <Button size="sm" className={cn(!dirty && 'ml-auto')} disabled={!dirty || saving} onClick={() => void save()}>
          {t('保存')}
        </Button>
      </footer>
    </div>
  )
}
