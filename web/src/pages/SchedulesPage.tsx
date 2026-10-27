import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { ExternalLink, Pencil, Play, Plus, Power, Trash2 } from 'lucide-react'
import {
  fromLocalInput,
  groupLabel,
  groupSchedules,
  isoWeekday,
  nextRunLabel,
  outcomeLabel,
  outcomeOf,
  outcomeTitle,
  repeatLabel,
  sameMinute,
  scheduleCycle,
  scheduleCycleLabel,
  SCHEDULE_TICK_MS,
  SCHEDULE_WEEKDAYS,
  toLocalInput,
  WORKDAY_PLAN,
  workdayTemplate,
  whenLabel,
  type Schedule,
  type ScheduleInput,
  type ScheduleRepeat,
} from '@shared/schedule'
import { t } from '@shared/i18n'
import { pad2 } from '@shared/datetime'
import { listableAgents } from '@shared/builtin/core'
import { api } from '@/lib/api'
import { useData, useNav } from '@/lib/data'
import { timeAgo } from '@/lib/tasks'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { PageFrame } from '@/components/library/parts'

const DEMO = !!import.meta.env.VITE_DEMO
/** 启动失败的原文超过这个长度才给「展开全文」：窄屏一行大约只放得下这么多字，再长会被截掉 */
const ERROR_PREVIEW_CHARS = 30
/** 模板时间文案：从 WORKDAY_PLAN 算，模板改成别的时刻这里跟着变 */
const WORKDAY_TIME = `${WORKDAY_PLAN.hour}:${pad2(WORKDAY_PLAN.minute)}`

const toInput = (s: Schedule): ScheduleInput => ({
  name: s.name,
  prompt: s.prompt,
  projectId: s.projectId,
  agentId: s.agentId,
  repeat: s.repeat,
  weekdays: s.weekdays,
  at: s.at,
  enabled: s.enabled,
  dependsOn: s.dependsOn,
  budget: s.budget,
})

/** 最近一次结果的色调：问题和错过都要能一眼看见，成功不抢眼 */
const outcomeTone = {
  error: 'warning',
  missed: 'warning',
  blocked: 'warning',
  success: 'success',
  none: 'neutral',
} as const

/** 分组标题：组名 + 数量 */
function GroupHeading({ group, count }: { group: string; count: number }) {
  return (
    <h2 className="flex items-center gap-2 text-[0.8125rem] font-semibold text-muted">
      {group}
      <span className="rounded-full bg-field px-1.5 text-[0.6875rem] font-normal text-subtle tabular-nums">
        {count}
      </span>
    </h2>
  )
}

/** 一张计划卡片：名称 → 下次执行 → 重复 / 项目 / 角色 → 最近一次结果 → 操作 */
function ScheduleCard({
  schedule: s,
  now,
  projectName,
  agentName,
  upstreams,
  busy,
  onEdit,
  onRun,
  onToggle,
  onDelete,
  onOpenTask,
}: {
  schedule: Schedule
  now: number
  projectName: string
  agentName: string
  /** 上游计划的名字；找不到的是已经被删掉的，用占位名字 */
  upstreams: string[]
  busy: boolean
  onEdit: () => void
  onRun: () => void
  onToggle: () => void
  onDelete: () => void
  onOpenTask: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const outcome = outcomeOf(s)
  const next = nextRunLabel(s, now)
  // 实际渲染的文本（错过 / 成功时带「上次启动失败：」前缀）：阈值按它算，
  // 否则前缀会把一行挤满却不出现「展开全文」，触屏上没有 title 可看
  const errorText = outcome === 'error' ? s.lastError : t('上次启动失败：{error}', { error: s.lastError })
  // 失败原文可能很长（带堆栈、带换行）：先显示一行，要看全文再展开
  const longError = errorText.length > ERROR_PREVIEW_CHARS || s.lastError.includes('\n')

  return (
    <li className="flex flex-col rounded-xl border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <h3 className={cn('min-w-0 flex-1 truncate text-[0.9375rem] font-semibold', !s.enabled && 'text-muted')}>
          {s.name}
        </h3>
        <div className="flex flex-wrap items-center gap-0.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRun}>
            <Play className="h-3.5 w-3.5" />
            {t('立即执行')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            {t('编辑')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onToggle}>
            <Power className="h-3.5 w-3.5" />
            {s.enabled ? t('停用') : t('启用')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger hover:bg-danger/10 hover:text-danger"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('删除')}
          </Button>
        </div>
      </div>

      {/* 下次执行：相对时间 + 绝对时间都在这一行；停用 / 单次跑完后只写不会再有下一次，不再加「下次执行」标签 */}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {next ? (
          <>
            <span className="text-xs text-subtle">{t('下次执行')}</span>
            <span className={cn('text-[0.9375rem] font-medium tabular-nums', s.enabled ? 'text-fg' : 'text-subtle')}>
              {next}
            </span>
          </>
        ) : (
          <span className="text-[0.9375rem] font-medium text-subtle">{t('不会再次执行')}</span>
        )}
        <Badge>{repeatLabel(s.repeat)}</Badge>
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span>{projectName || t('聊天')}</span>
        <span className="text-subtle">·</span>
        <span>{agentName || t('跟随默认 CLI')}</span>
      </p>

      {/* 上游依赖：这几条计划这一轮成功启动之后本计划才会启动；名字都找不到说明上游被删了 */}
      {!!upstreams.length && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="text-subtle">{t('上游')}</span>
          <span>{upstreams.join(t('、'))}</span>
        </p>
      )}

      {/* 执行上限：只写设了的项，没设的一项不占位置 */}
      {(s.budget.tokens > 0 || s.budget.minutes > 0) && (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="text-subtle">{t('执行上限')}</span>
          <span>
            {[
              s.budget.tokens > 0 ? t('{n} token', { n: s.budget.tokens.toLocaleString() }) : '',
              s.budget.minutes > 0 ? t('{n} 分钟', { n: s.budget.minutes }) : '',
            ]
              .filter(Boolean)
              .join(t('、'))}
          </span>
        </p>
      )}

      {/* 最近一次结果：成功 / 错过 / 未启动 / 启动失败各说清发生了什么，原因不吞 */}
      <div className="mt-2.5 flex flex-col gap-1.5 border-t pt-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={outcomeTone[outcome]}>{outcomeTitle(s)}</Badge>
          {/* 徽标已经说了结果，正文只补细节；原因类型的在下面单独一段用警告色显示 */}
          {(outcome === 'missed' || outcome === 'success') && (
            <span className="text-muted">{outcomeLabel(s, now)}</span>
          )}
          {outcome === 'success' && <span className="text-subtle">{timeAgo(s.lastRunAt, now)}</span>}
          {!!s.lastTaskId && (
            <button
              type="button"
              onClick={onOpenTask}
              className="inline-flex cursor-pointer items-center gap-1 text-accent hover:underline"
            >
              {t('打开这次执行')}
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>
        {!!s.lastError && (
          <div className="flex flex-col gap-1">
            <p
              className={cn('break-words whitespace-pre-wrap text-warning', !expanded && 'line-clamp-1')}
              title={expanded ? undefined : s.lastError}
            >
              {errorText}
            </p>
            {longError && (
              <button
                type="button"
                className="w-fit cursor-pointer text-subtle hover:text-fg"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? t('收起') : t('展开全文')}
              </button>
            )}
          </div>
        )}
        {/* 上游没成功：写清是哪个上游、什么结果，不静默跳过 */}
        {outcome === 'blocked' && (
          <p className="break-words whitespace-pre-wrap text-warning">
            {s.blockedReason || t('上游没有成功，没有启动')}
          </p>
        )}
        {/* 最近一次 Webhook 投递：没开 Webhook 时没有这条记录，不占位置 */}
        {!!s.lastDelivery && (
          <p className={cn('break-words', s.lastDelivery.ok ? 'text-subtle' : 'text-warning')}>
            {s.lastDelivery.ok
              ? t('Webhook 已投递于 {time}', { time: whenLabel(s.lastDelivery.at, now) })
              : t('Webhook 投递失败：{error}', { error: s.lastDelivery.error })}
          </p>
        )}
      </div>
    </li>
  )
}

/** 编辑表单的值：时间用 datetime-local 的字符串（本机时区） */
interface Form {
  name: string
  prompt: string
  projectId: string
  agentId: string
  repeat: ScheduleRepeat
  /** weekly 时选中的星期（1 = 周一 … 7 = 周日） */
  weekdays: number[]
  atLocal: string
  /** 上游计划 id：这些计划这一轮成功启动之后，本计划到点才会启动 */
  dependsOn: string[]
  /** token 上限（输入框里的原文）；空或 0 表示不限 */
  budgetTokens: string
  /** 时长上限（分钟，输入框里的原文）；空或 0 表示不限 */
  budgetMinutes: string
}

const newForm = (): Form => {
  // 新建时预填「今日工作」模板：每天 19:00 总结当天的工作，用户直接改就行
  const tpl = workdayTemplate(Date.now())
  return {
    name: tpl.name,
    prompt: tpl.prompt,
    repeat: tpl.repeat,
    weekdays: [],
    projectId: '',
    agentId: '',
    atLocal: toLocalInput(tpl.at),
    dependsOn: [],
    budgetTokens: '',
    budgetMinutes: '',
  }
}

const formOf = (s: Schedule): Form => ({
  name: s.name,
  prompt: s.prompt,
  projectId: s.projectId,
  agentId: s.agentId,
  repeat: s.repeat,
  weekdays: s.weekdays,
  atLocal: toLocalInput(s.at),
  dependsOn: s.dependsOn,
  // 0 在界面上显示成空：不限制就别占着输入框写一个 0
  budgetTokens: s.budget.tokens ? String(s.budget.tokens) : '',
  budgetMinutes: s.budget.minutes ? String(s.budget.minutes) : '',
})

function ScheduleDialog({
  schedule,
  schedules,
  onClose,
  onSaved,
}: {
  /** 不传是新建 */
  schedule?: Schedule
  /** 全部计划：选上游时列出来，排除自己 */
  schedules: Schedule[]
  onClose: () => void
  onSaved: (s: Schedule) => void
}) {
  const { projects, agents } = useData()
  const [form, setForm] = useState<Form>(() => (schedule ? formOf(schedule) : newForm()))
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))
  /**
   * 切重复规则：切到「每周」时先把执行时间那天的星期选上，用户能直接看到以后哪天执行；
   * 切到别的规则时清掉残留的星期，下次回到「每周」不会被上一次的选择干扰。
   */
  const setRepeat = (repeat: ScheduleRepeat) => {
    setForm((f) => {
      const at = fromLocalInput(f.atLocal)
      return {
        ...f,
        repeat,
        weekdays: repeat === 'weekly' ? (f.weekdays.length ? f.weekdays : at ? [isoWeekday(new Date(at))] : []) : [],
      }
    })
  }
  /**
   * 改执行时间：weekly 只勾了一个星期时把星期跟着换成新日期那天，
   * 否则两个字段长期不一致（用户把「每周一」的日期改到周三，保存后会被服务端拉回下周一）。
   * 勾了多个星期时不动——用户很可能是想保留那几天、只换时分。
   */
  const setAtLocal = (value: string) => {
    setForm((f) => {
      const at = fromLocalInput(value)
      const weekdays = f.repeat === 'weekly' && f.weekdays.length === 1 && at ? [isoWeekday(new Date(at))] : f.weekdays
      return { ...f, atLocal: value, weekdays }
    })
  }
  /** 勾选 / 取消一个星期（多选） */
  const toggleWeekday = (day: number) =>
    setForm((f) => ({
      ...f,
      weekdays: f.weekdays.includes(day)
        ? f.weekdays.filter((x) => x !== day)
        : [...f.weekdays, day].sort((a, b) => a - b),
    }))
  /** 可选的上游：排除自己，否则一保存就成环 */
  const others = schedules.filter((x) => x.id !== schedule?.id)
  /** 勾选 / 取消一个上游（多选） */
  const toggleUpstream = (id: string) =>
    setForm((f) => ({
      ...f,
      dependsOn: f.dependsOn.includes(id) ? f.dependsOn.filter((x) => x !== id) : [...f.dependsOn, id],
    }))
  /** 一键填入「今日工作」：只改名称、提示词和每天 19:00，用户选的项目和角色保留 */
  const applyTemplate = () => {
    const tpl = workdayTemplate(Date.now())
    setForm((f) => ({
      ...f,
      name: tpl.name,
      prompt: tpl.prompt,
      repeat: tpl.repeat,
      weekdays: [],
      atLocal: toLocalInput(tpl.at),
    }))
  }
  // 「子任务」不再作为可选角色展示，但老计划可能已经选过它：补一项显示名字，
  // 不然 Select 找不到当前项时会把角色 id 直接显示出来，看着像坏数据。保存仍按原值走，用户主动改了才换
  const pickable = listableAgents(agents)
  const unpickable =
    form.agentId && !pickable.some((a) => a.id === form.agentId) ? agents.find((a) => a.id === form.agentId) : undefined

  const save = async () => {
    const at = fromLocalInput(form.atLocal)
    if (!at) {
      toast.error(t('请选择执行时间'))
      return
    }
    // 成环的依赖存不进去：先在本机拦一下，提示比等接口报错快
    const cycle = scheduleCycle(schedules, schedule?.id ?? '', form.dependsOn)
    if (cycle.length) {
      toast.error(t('依赖关系成环：{path}，请去掉一个上游再保存', { path: scheduleCycleLabel(cycle, schedules) }))
      return
    }
    const input: ScheduleInput = {
      name: form.name,
      prompt: form.prompt,
      projectId: form.projectId,
      agentId: form.agentId,
      repeat: form.repeat,
      // 每周没勾星期时按执行时间那天的星期；服务端还会用 alignScheduleAt 把首次执行对齐到选中的星期
      weekdays: form.repeat === 'weekly' && !form.weekdays.length ? [isoWeekday(new Date(at))] : form.weekdays,
      at,
      enabled: schedule?.enabled ?? true,
      dependsOn: form.dependsOn,
      // 输入框只让填数字；空着按 0（不限）
      budget: { tokens: Number(form.budgetTokens) || 0, minutes: Number(form.budgetMinutes) || 0 },
    }
    setSaving(true)
    try {
      if (schedule) {
        // 弹窗开着的时候这条计划可能已经跑过一次、排期变了（每天的计划会自己推到下一次）：
        // 提交打开时那份旧时间，服务端会当成重新排期，让同一次计划再跑一遍。
        // 保存前确认它还是打开时的排期，不是就让用户重新打开再改
        const latest = (await api.schedules()).find((x) => x.id === schedule.id)
        if (!latest) throw new Error(t('计划不存在'))
        // 和 PUT 同一个口径（按分钟）：同一分钟内别处改过时间不算排期变了
        if (!sameMinute(latest.at, schedule.at)) {
          onSaved(latest)
          toast.error(t('这条计划刚执行过或已被改过，请重新打开再编辑'))
          return
        }
      }
      const saved = schedule ? await api.updateSchedule(schedule.id, input) : await api.createSchedule(input)
      toast.success(schedule ? t('计划已保存') : t('计划已创建'))
      onSaved(saved)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={schedule ? t('编辑计划') : t('新建计划')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button className="ml-auto" disabled={saving} onClick={save}>
            {t('保存')}
          </Button>
        </>
      }
    >
      {/* 新建默认已按模板填好；改乱了可以一键填回来 */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed text-muted">
          {schedule
            ? t('改完保存，计划按新的设置执行。')
            : t('已按「今日工作」填好：每天 {time} 总结当天的工作，可以直接改。', { time: WORKDAY_TIME })}
        </p>
        <Button size="sm" variant="secondary" onClick={applyTemplate}>
          {t('填入「今日工作」模板')}
        </Button>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('名称')}</span>
        <Input
          autoFocus
          value={form.name}
          placeholder={t('例如：今日工作')}
          onChange={(e) => set('name', e.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('执行时间')}</span>
          <Input
            type="datetime-local"
            className="h-10 dark:[color-scheme:dark]"
            value={form.atLocal}
            onChange={(e) => setAtLocal(e.target.value)}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('重复')}</span>
          <Select
            aria-label={t('重复')}
            value={form.repeat}
            className="h-10 w-[140px]"
            onChange={(e) => setRepeat(e.target.value as ScheduleRepeat)}
            options={[
              { value: 'once', label: t('单次') },
              { value: 'daily', label: t('每天') },
              { value: 'weekly', label: t('每周') },
              { value: 'workdays', label: t('工作日') },
            ]}
          />
        </div>
      </div>
      {form.repeat === 'weekly' && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('每周哪几天')}</span>
          <div role="group" aria-label={t('每周哪几天')} className="flex flex-wrap gap-1">
            {SCHEDULE_WEEKDAYS.map((d) => {
              const on = form.weekdays.includes(d.id)
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleWeekday(d.id)}
                  className={cn(
                    'h-8 cursor-pointer rounded-lg border px-2.5 text-[0.8125rem] transition-colors',
                    on ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-muted hover:bg-sel',
                  )}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('上游计划')}</span>
        <span className="text-xs text-subtle">
          {t('这些计划这一轮成功启动之后，本计划到点才会启动；留空表示不依赖。')}
        </span>
        {others.length ? (
          <div
            role="group"
            aria-label={t('上游计划')}
            className="flex max-h-32 flex-wrap gap-1 overflow-y-auto rounded-lg border p-1.5"
          >
            {others.map((x) => {
              const on = form.dependsOn.includes(x.id)
              return (
                <button
                  key={x.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleUpstream(x.id)}
                  className={cn(
                    'h-8 cursor-pointer rounded-lg border px-2.5 text-[0.8125rem] transition-colors',
                    on ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-muted hover:bg-sel',
                  )}
                >
                  {x.name}
                </button>
              )
            })}
          </div>
        ) : (
          <span className="text-xs text-subtle">{t('还没有别的计划可以作为上游。')}</span>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {' '}
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('用哪个角色')}</span>
          <Select
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
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('在哪个项目里执行')}</span>
          <Select
            value={form.projectId}
            aria-label={t('在哪个项目里执行')}
            options={[
              { value: '', label: t('聊天（不属于项目）') },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(e) => set('projectId', e.target.value)}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('到点后执行的对话内容')}</span>
        <Textarea
          rows={5}
          value={form.prompt}
          placeholder={t('交给 Agent 的一句话目标，例如：总结今天做的工作')}
          onChange={(e) => set('prompt', e.target.value)}
        />
      </label>
      {/* 执行上限：超了就停，已经产出的内容留着；空着表示不限 */}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('token 上限')}</span>
          <Input
            inputMode="numeric"
            value={form.budgetTokens}
            placeholder={t('0 或不填表示不限')}
            aria-label={t('token 上限')}
            onChange={(e) => set('budgetTokens', e.target.value.replace(/[^\d]/g, ''))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('时长上限（分钟）')}</span>
          <Input
            inputMode="numeric"
            value={form.budgetMinutes}
            placeholder={t('0 或不填表示不限')}
            aria-label={t('时长上限（分钟）')}
            onChange={(e) => set('budgetMinutes', e.target.value.replace(/[^\d]/g, ''))}
          />
        </label>
      </div>
      <p className="text-xs text-subtle">
        {t('超过上限时面板会停下来，已经产出的内容都保留着；填 0 或不填表示不限。')}
      </p>
      <p className="text-xs text-subtle">
        {t('时间按本机时区。每天 / 每周 / 工作日的计划每次执行完自动推到下一次，只执行一次的执行完就停下。')}
      </p>
    </Modal>
  )
}

export function SchedulesPage() {
  const { projects, agents } = useData()
  const { go } = useNav()
  const [list, setList] = useState<Schedule[] | null>(null)
  const [error, setError] = useState('')
  /** 相对时间（3 小时后）和数据一起算、一起刷：不和列表数据分开各算一次 */
  const [now, setNow] = useState(() => Date.now())
  /** 正在新建 / 编辑的那条；'new' 是新建 */
  const [edit, setEdit] = useState<Schedule | 'new' | null>(null)
  const [del, setDel] = useState<Schedule | null>(null)
  /** 正在执行的那条计划 id：按钮转圈、防止重复点 */
  const [busy, setBusy] = useState('')
  /** 请求序号：保存 / 删除后比它早发出的轮询迟到返回时丢掉，不把刚保存的列表覆盖回旧值 */
  const loadSeq = useRef(0)

  const load = async () => {
    const seq = ++loadSeq.current
    try {
      const next = await api.schedules()
      if (seq !== loadSeq.current) return
      setList(next)
      setNow(Date.now())
      setError('')
    } catch (e) {
      if (seq === loadSeq.current) setError((e as Error).message)
    }
  }

  useEffect(() => {
    void load()
    // 到点后状态和下次执行时间会变：和服务端轮询同一个节奏，页面开着就能看到
    const timer = setInterval(() => void load(), SCHEDULE_TICK_MS)
    return () => clearInterval(timer)
    // load 每次渲染都是新的函数，只在挂载时开始轮询
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saved = (s: Schedule) => {
    // 本地已经是最新的，把在途的轮询请求作废（它带的是保存前的列表）
    loadSeq.current++
    setList((l) => [...(l ?? []).filter((x) => x.id !== s.id), s])
    setNow(Date.now())
    setEdit(null)
  }

  const toggle = async (s: Schedule, on: boolean) => {
    try {
      saved(await api.updateSchedule(s.id, { ...toInput(s), enabled: on }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const runNow = async (s: Schedule) => {
    setBusy(s.id)
    try {
      const res = await api.runSchedule(s.id)
      saved(res.schedule)
      if (res.taskId) toast.success(t('已启动对话「{name}」', { name: s.name }))
      else if (DEMO) toast.info(t('在线演示里不会真的启动对话，正式版会新建一个对话开始执行。'))
      else toast.error(res.schedule.lastError || t('启动失败'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const openTask = (s: Schedule) => {
    if (!s.lastTaskId) return
    go(s.projectId ? { page: 'projects', id: s.projectId, sub: s.lastTaskId } : { page: 'chat', id: s.lastTaskId })
  }

  /** 上游的名字：找不到的是已经被删掉的，用占位名字，不显示一串 id */
  const upstreamNames = (s: Schedule) =>
    s.dependsOn.map((id) => list?.find((x) => x.id === id)?.name ?? t('已删除的计划'))

  return (
    <PageFrame
      title={t('计划')}
      intro={t(
        '到点自动新建一个对话去执行。面板进程在跑时才会触发；面板关着期间错过的计划不会补跑，会在列表里标出来。',
      )}
      actions={
        <Button onClick={() => setEdit('new')}>
          <Plus className="h-4 w-4" />
          {t('新建计划')}
        </Button>
      }
    >
      {error ? (
        <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
      ) : !list ? (
        <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>
      ) : !list.length ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-10 text-center">
          <p className="max-w-[420px] text-[0.8125rem] leading-relaxed text-subtle">
            {t('还没有计划。新建一条「今日工作」，每天 {time} 自动总结当天的工作。', { time: WORKDAY_TIME })}
          </p>
          <Button onClick={() => setEdit('new')}>
            <Plus className="h-4 w-4" />
            {t('新建今日工作')}
          </Button>
        </div>
      ) : (
        groupSchedules(list).map(({ group, items }) => (
          <section key={group} className="flex flex-col gap-2">
            <GroupHeading group={groupLabel(group)} count={items.length} />
            <ul className="flex flex-col gap-2">
              {items.map((s) => {
                const project = projects.find((p) => p.id === s.projectId)
                const agent = agents.find((a) => a.id === s.agentId)
                return (
                  <ScheduleCard
                    key={s.id}
                    schedule={s}
                    now={now}
                    projectName={project?.name ?? ''}
                    agentName={agent?.name ?? ''}
                    upstreams={upstreamNames(s)}
                    busy={busy === s.id}
                    onEdit={() => setEdit(s)}
                    onRun={() => void runNow(s)}
                    onToggle={() => void toggle(s, !s.enabled)}
                    onDelete={() => setDel(s)}
                    onOpenTask={() => openTask(s)}
                  />
                )
              })}
            </ul>
          </section>
        ))
      )}

      {edit && (
        <ScheduleDialog
          key={edit === 'new' ? 'new' : edit.id}
          schedule={edit === 'new' ? undefined : edit}
          schedules={list ?? []}
          onClose={() => setEdit(null)}
          onSaved={saved}
        />
      )}
      <ConfirmDialog
        open={!!del}
        title={t('删除计划「{name}」？', { name: del?.name ?? '' })}
        description={t('删除后不会再执行，已经启动过的对话会留着。')}
        onOpenChange={(open) => !open && setDel(null)}
        onConfirm={async () => {
          if (!del) return
          try {
            await api.deleteSchedule(del.id)
            loadSeq.current++
            setList((l) => (l ?? []).filter((x) => x.id !== del.id))
            toast.success(t('计划已删除'))
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
      />
    </PageFrame>
  )
}
