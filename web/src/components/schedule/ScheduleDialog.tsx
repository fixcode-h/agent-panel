import { useState } from 'react'
import { whenLabel, workdayTimeLabel, SCHEDULE_WEEKDAYS, type Schedule } from '@shared/schedule'
import { t } from '@shared/i18n'
import { listableAgents } from '@shared/builtin/core'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { EndChoice } from './EndChoice'
import { REPEAT_OPTIONS, useScheduleForm } from './use-schedule-form'

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
  const {
    form,
    set,
    setRepeat,
    setAtLocal,
    toggleWeekday,
    toggleUpstream,
    applyTemplate,
    saving,
    save,
    previewAt,
    previewPast,
  } = useScheduleForm({ schedule, blank, schedules, onSaved })
  // 编辑已有计划时带着上游或执行上限，默认展开「更多设置」，用户不用再点一次
  const [advancedOpen, setAdvancedOpen] = useState(
    !!schedule && (!!schedule.dependsOn.length || !!(schedule.budget.tokens || schedule.budget.minutes)),
  )
  /** 可选的上游：排除自己，否则一保存就成环 */
  const others = schedules.filter((x) => x.id !== schedule?.id)
  // 「子任务」不再作为可选角色展示，但老计划可能已经选过它：补一项显示名字，
  // 不然 Select 找不到当前项时会把角色 id 直接显示出来，看着像坏数据。保存仍按原值走，用户主动改了才换
  const pickable = listableAgents(agents)
  const unpickable =
    form.agentId && !pickable.some((a) => a.id === form.agentId) ? agents.find((a) => a.id === form.agentId) : undefined

  const previewProject = projects.find((p) => p.id === form.projectId)?.name || t('聊天')

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
                      on
                        ? 'border-accent bg-accent-soft text-accent-text'
                        : 'border-line-strong text-muted hover:bg-sel',
                    )}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {form.repeat !== 'once' && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('结束')}</span>
            <EndChoice value={form.endDate} onChange={(v) => set('endDate', v)} />
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
                        on
                          ? 'border-accent bg-accent-soft text-accent-text'
                          : 'border-line-strong text-muted hover:bg-sel',
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
