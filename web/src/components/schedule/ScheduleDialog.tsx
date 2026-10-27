import { useState } from 'react'
import { toast } from '@/lib/toast'
import {
  alignScheduleAt,
  fromLocalInput,
  isoWeekday,
  sameMinute,
  scheduleCycle,
  scheduleCycleLabel,
  SCHEDULE_MISS_MS,
  SCHEDULE_WEEKDAYS,
  toLocalInput,
  whenLabel,
  workdayTemplate,
  workdayTimeLabel,
  type Schedule,
  type ScheduleInput,
  type ScheduleRepeat,
} from '@shared/schedule'
import { t } from '@shared/i18n'
import { listableAgents } from '@shared/builtin/core'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'

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

/** 重复规则的选项：分段单选比下拉更直观，四种规则一眼看全 */
const REPEAT_OPTIONS: { id: ScheduleRepeat; label: string }[] = [
  { id: 'once', label: t('单次') },
  { id: 'daily', label: t('每天') },
  { id: 'weekly', label: t('每周') },
  { id: 'workdays', label: t('工作日') },
]

const newForm = (blank: boolean): Form => {
  // 新建时预填「今日工作」模板：每天 19:00 总结当天的工作，用户直接改就行；
  // 空白计划只留时刻和重复规则，名称、提示词留空等用户自己写
  const tpl = workdayTemplate(Date.now())
  return {
    name: blank ? '' : tpl.name,
    prompt: blank ? '' : tpl.prompt,
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

/** 表单里的一段：什么时候跑 / 跑什么 / 在哪跑；分组让长表单读起来有层次 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-3.5">
      <h3 className="text-[0.8125rem] font-semibold text-muted">{title}</h3>
      {children}
    </section>
  )
}

export function ScheduleDialog({
  schedule,
  blank = false,
  schedules,
  onClose,
  onSaved,
}: {
  /** 不传是新建 */
  schedule?: Schedule
  /** 新建空白计划：名称和提示词不预填模板 */
  blank?: boolean
  /** 全部计划：选上游时列出来，排除自己 */
  schedules: Schedule[]
  onClose: () => void
  onSaved: (s: Schedule) => void
}) {
  const { projects, agents } = useData()
  const [form, setForm] = useState<Form>(() => (schedule ? formOf(schedule) : newForm(blank)))
  const [saving, setSaving] = useState(false)
  // 编辑已有计划时带着上游或执行上限，默认展开「更多设置」，用户不用再点一次
  const [advancedOpen, setAdvancedOpen] = useState(
    !!schedule && (!!schedule.dependsOn.length || !!(schedule.budget.tokens || schedule.budget.minutes)),
  )
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

  const at = fromLocalInput(form.atLocal)
  /** 保存时实际用的星期：每周没勾时按执行时间那天，和预览同一口径 */
  const weekdays = form.repeat === 'weekly' && !form.weekdays.length && at ? [isoWeekday(new Date(at))] : form.weekdays
  /**
   * 保存后的效果预览：先把首次执行对齐到规则允许的星期（和服务端 alignScheduleAt 同一口径），
   * 用户改时间、切重复规则时立刻能看到「什么时候、在哪个项目新建对话」。
   */
  const previewAt = at ? alignScheduleAt({ repeat: form.repeat, at, weekdays }) : ''
  // 和服务端到点判定同一个宽限（pickDue）：超过 SCHEDULE_MISS_MS 的过去时间只会记为错过，预览不能承诺会新建对话
  const previewPast = !!previewAt && Date.now() - Date.parse(previewAt) > SCHEDULE_MISS_MS
  const previewProject = projects.find((p) => p.id === form.projectId)?.name || t('聊天')

  const save = async () => {
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
      weekdays,
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
      wide
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
            : blank
              ? t('填好名称、时间和要交给 Agent 的内容即可。')
              : t('已按「今日工作」填好：每天 {time} 总结当天的工作，可以直接改。', { time: workdayTimeLabel() })}
        </p>
        <Button size="sm" variant="secondary" onClick={applyTemplate}>
          {t('填入「今日工作」模板')}
        </Button>
      </div>

      <Section title={t('什么时候跑')}>
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('重复')}</span>
          <Segmented label={t('重复')} value={form.repeat} onChange={setRepeat} options={REPEAT_OPTIONS} />
        </div>
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
        {/* 保存后的效果：时间对齐、项目都按这次表单的值算，改动立刻能看到 */}
        {!!previewAt && (
          <p className="text-xs leading-relaxed text-muted" aria-live="polite">
            {previewPast
              ? t('这个时间已经过去，保存后会记为错过（这次不会新建对话）')
              : t('保存后：{time} 会在「{target}」新建一个对话', {
                  time: whenLabel(previewAt, Date.now()),
                  target: previewProject,
                })}
          </p>
        )}
      </Section>

      <Section title={t('跑什么')}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('名称')}</span>
          <Input
            autoFocus
            value={form.name}
            placeholder={t('例如：今日工作')}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-medium">{t('到点后执行的对话内容')}</span>
          <Textarea
            rows={5}
            value={form.prompt}
            placeholder={t('交给 Agent 的一句话目标，例如：总结今天做的工作')}
            onChange={(e) => set('prompt', e.target.value)}
          />
        </label>
      </Section>

      <Section title={t('在哪跑')}>
        <div className="grid gap-4 sm:grid-cols-2">
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
        </div>
      </Section>

      <details
        className="rounded-xl border"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary className="cursor-pointer px-3.5 py-2.5 text-[0.8125rem] font-semibold text-muted select-none">
          {t('更多设置')}
        </summary>
        <div className="flex flex-col gap-3 border-t px-3.5 py-3">
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
        </div>
      </details>
    </Modal>
  )
}
