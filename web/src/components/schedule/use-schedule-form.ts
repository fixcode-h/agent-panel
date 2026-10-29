import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import {
  alignScheduleAt,
  fromLocalInput,
  isoWeekday,
  sameMinute,
  scheduleCycle,
  scheduleCycleLabel,
  scheduleTimingError,
  SCHEDULE_MISS_MS,
  toLocalInput,
  workdayTemplate,
  type Schedule,
  type ScheduleInput,
  type ScheduleRepeat,
} from '@shared/schedule'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'

/**
 * 计划的编辑表单：编辑弹窗（新建、从列表编辑）和详情面板（直接改）共用这一份——
 * 表单值、切重复规则 / 改时间时的联动、保存前的校验（时间、结束日期、依赖成环、排期已被改过）都在这里，
 * 两边不各写一份，改一处另一处不会漏。
 */

/** 表单的值：时间用 datetime-local 的字符串（本机时区） */
export interface ScheduleForm {
  name: string
  prompt: string
  projectId: string
  agentId: string
  repeat: ScheduleRepeat
  /** weekly 时选中的星期（1 = 周一 … 7 = 周日） */
  weekdays: number[]
  atLocal: string
  /** 结束日期（YYYY-MM-DD）；空表示永不结束 */
  endDate: string
  enabled: boolean
  /** 上游计划 id：这些计划这一轮成功启动之后，本计划到点才会启动 */
  dependsOn: string[]
  /** token 上限（输入框里的原文）；空或 0 表示不限 */
  budgetTokens: string
  /** 时长上限（分钟，输入框里的原文）；空或 0 表示不限 */
  budgetMinutes: string
}

/** 重复规则的选项：分段单选比下拉更直观，四种规则一眼看全（文案照设计稿写「不重复」） */
export const REPEAT_OPTIONS: { id: ScheduleRepeat; label: string }[] = [
  { id: 'once', label: t('不重复') },
  { id: 'daily', label: t('每天') },
  { id: 'weekly', label: t('每周') },
  { id: 'workdays', label: t('工作日') },
]

export const newScheduleForm = (blank: boolean): ScheduleForm => {
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
    endDate: '',
    enabled: true,
    dependsOn: [],
    budgetTokens: '',
    budgetMinutes: '',
  }
}

export const scheduleFormOf = (s: Schedule): ScheduleForm => ({
  name: s.name,
  prompt: s.prompt,
  projectId: s.projectId,
  agentId: s.agentId,
  repeat: s.repeat,
  weekdays: s.weekdays,
  atLocal: toLocalInput(s.at),
  endDate: s.endDate,
  enabled: s.enabled,
  dependsOn: s.dependsOn,
  // 0 在界面上显示成空：不限制就别占着输入框写一个 0
  budgetTokens: s.budget.tokens ? String(s.budget.tokens) : '',
  budgetMinutes: s.budget.minutes ? String(s.budget.minutes) : '',
})

/** 已有计划原样转成保存用的输入：列表卡片上只切开关时用，其余字段不动 */
export const scheduleInputOf = (s: Schedule): ScheduleInput => ({
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
  endDate: s.endDate,
})

/** 每周没勾星期时按执行时间那天：保存、预览、对齐都用这一口径 */
function effectiveWeekdays(form: ScheduleForm, at: string): number[] {
  return form.repeat === 'weekly' && !form.weekdays.length && at ? [isoWeekday(new Date(at))] : form.weekdays
}

const sameForm = (a: ScheduleForm, b: ScheduleForm) => JSON.stringify(a) === JSON.stringify(b)

export function useScheduleForm({
  schedule,
  blank = false,
  schedules,
  onSaved,
  inline = false,
}: {
  /** 不传是新建 */
  schedule?: Schedule
  /** 新建空白计划：名称和提示词不预填模板 */
  blank?: boolean
  /** 全部计划：成环检查用 */
  schedules: Schedule[]
  onSaved: (s: Schedule) => void
  /** 详情面板里直接改：保存后留在原处；排期被别处改过时载入最新的，而不是关掉让用户重新打开 */
  inline?: boolean
}) {
  /** 表单是基于哪一份计划开始改的：保存前拿它判断「排期是不是在这期间变了」 */
  const [origin, setOrigin] = useState(schedule)
  const [baseline, setBaseline] = useState<ScheduleForm>(() =>
    schedule ? scheduleFormOf(schedule) : newScheduleForm(blank),
  )
  const [form, setForm] = useState<ScheduleForm>(baseline)
  const [saving, setSaving] = useState(false)
  const dirty = !sameForm(form, baseline)

  /** 换成另一份计划重新开始（保存成功后、排期被别处改过时） */
  const reset = (s: Schedule) => {
    const f = scheduleFormOf(s)
    setOrigin(s)
    setBaseline(f)
    setForm(f)
  }

  // 详情面板常驻：轮询拿到这条计划的新版本（跑过一次、at 往后推了）时，没改过就跟着换，
  // 改到一半的不动——保存时的排期检查会拦住基于旧排期的改动
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    if (schedule && !dirtyRef.current) reset(schedule)
    // 只在计划本身换了版本时同步；reset 每次渲染都是新的函数
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule?.id, schedule?.updatedAt])

  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) => setForm((f) => ({ ...f, [key]: value }))
  /**
   * 切重复规则：切到「每周」时先把执行时间那天的星期选上，用户能直接看到以后哪天执行；
   * 切到别的规则时清掉残留的星期，下次回到「每周」不会被上一次的选择干扰。
   * 不重复的计划没有「结束」可设，清掉结束日期，免得留着一个看不见的限制
   */
  const setRepeat = (repeat: ScheduleRepeat) => {
    setForm((f) => {
      const at = fromLocalInput(f.atLocal)
      return {
        ...f,
        repeat,
        weekdays: repeat === 'weekly' ? (f.weekdays.length ? f.weekdays : at ? [isoWeekday(new Date(at))] : []) : [],
        endDate: repeat === 'once' ? '' : f.endDate,
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

  const at = fromLocalInput(form.atLocal)
  const weekdays = effectiveWeekdays(form, at)
  /**
   * 保存后的效果预览：先把首次执行对齐到规则允许的星期（和服务端 alignScheduleAt 同一口径），
   * 用户改时间、切重复规则时立刻能看到「什么时候、在哪个项目新建对话」。
   */
  const previewAt = at ? alignScheduleAt({ repeat: form.repeat, at, weekdays }) : ''
  // 和服务端到点判定同一个宽限（pickDue）：超过 SCHEDULE_MISS_MS 的过去时间只会记为错过，预览不能承诺会新建对话
  const previewPast = !!previewAt && Date.now() - Date.parse(previewAt) > SCHEDULE_MISS_MS

  const save = async () => {
    if (!at) {
      toast.error(t('请选择执行时间'))
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
      enabled: form.enabled,
      dependsOn: form.dependsOn,
      // 输入框只让填数字；空着按 0（不限）
      budget: { tokens: Number(form.budgetTokens) || 0, minutes: Number(form.budgetMinutes) || 0 },
      endDate: form.repeat === 'once' ? '' : form.endDate,
    }
    // 下面两项服务端也会拦（同一个函数），先在本机拦一下，提示比等接口报错快
    const timing = scheduleTimingError(input)
    if (timing) {
      toast.error(timing)
      return
    }
    const cycle = scheduleCycle(schedules, origin?.id ?? '', form.dependsOn)
    if (cycle.length) {
      toast.error(t('依赖关系成环：{path}，请去掉一个上游再保存', { path: scheduleCycleLabel(cycle, schedules) }))
      return
    }
    setSaving(true)
    try {
      if (origin) {
        // 改的这段时间里这条计划可能已经跑过一次、排期变了（每天的计划会自己推到下一次）：
        // 提交开始改时那份旧时间，服务端会当成重新排期，让同一次计划再跑一遍。
        // 保存前确认它还是开始改时的排期，不是就载入最新的让用户重新改
        const latest = (await api.schedules()).find((x) => x.id === origin.id)
        if (!latest) throw new Error(t('计划不存在'))
        // 和 PUT 同一个口径（按分钟）：同一分钟内别处改过时间不算排期变了
        if (!sameMinute(latest.at, origin.at)) {
          reset(latest)
          onSaved(latest)
          toast.error(
            inline
              ? t('这条计划刚执行过或已被改过，已载入最新的设置，请重新修改')
              : t('这条计划刚执行过或已被改过，请重新打开再编辑'),
          )
          return
        }
      }
      const saved = origin ? await api.updateSchedule(origin.id, input) : await api.createSchedule(input)
      toast.success(origin ? t('计划已保存') : t('计划已创建'))
      reset(saved)
      onSaved(saved)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return {
    form,
    set,
    setRepeat,
    setAtLocal,
    toggleWeekday,
    toggleUpstream,
    applyTemplate,
    dirty,
    saving,
    save,
    previewAt,
    previewPast,
  }
}
