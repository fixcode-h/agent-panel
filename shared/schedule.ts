/**
 * 定时计划（左侧导航的「计划」）：到点由面板自己新建一个对话去执行。
 * 前后端共用同一份规则：服务端按它判断到没到点、执行后把时间往后推，界面按它显示下次执行时间。
 * 时间一律存 ISO 字符串，界面按本机时区显示和编辑。
 *
 * 和任务里的「执行计划」（task.plans，见 shared/plan.ts）不是一回事，这里叫 Schedule。
 */
import { z } from 'zod'
import { t } from './i18n.ts'

/** 重复规则：只执行一次 / 每天同一时刻执行 */
export const ScheduleRepeat = z.enum(['once', 'daily'])
export type ScheduleRepeat = z.infer<typeof ScheduleRepeat>

/** 待执行 / 已执行 / 已跳过（错过没跑，或者启动失败） */
export const ScheduleStatus = z.enum(['pending', 'done', 'skipped'])
export type ScheduleStatus = z.infer<typeof ScheduleStatus>

export const ScheduleInput = z.object({
  name: z.string().trim().min(1, t('请填写计划名称')).max(60),
  /** 到点后作为对话的第一句交给 Agent */
  prompt: z.string().trim().min(1, t('请填写到点后要执行的对话内容')).max(20000),
  /** 在哪个项目里执行；为空表示聊天模式（和新建任务一致） */
  projectId: z.string().default(''),
  /** 用哪个角色；为空表示不用 Agent 角色，直接跟随默认 CLI */
  agentId: z.string().default(''),
  repeat: ScheduleRepeat.default('once'),
  /** 下次执行时间；daily 时它是「每天这个时刻」的基准，每次执行后按它往后推一天 */
  at: z.string().refine((v) => Number.isFinite(Date.parse(v)), t('请选择执行时间')),
  enabled: z.boolean().default(true),
})
export type ScheduleInput = z.infer<typeof ScheduleInput>

export const Schedule = ScheduleInput.extend({
  id: z.string(),
  status: ScheduleStatus.default('pending'),
  /** 上次真正启动对话的时间；为空表示还没跑过 */
  lastRunAt: z.string().default(''),
  /** 上次启动的对话 id：列表里点进去看那次执行 */
  lastTaskId: z.string().default(''),
  /** 错过的那一次时间：面板没开着时到点的计划不补跑，列表里标出来 */
  missedAt: z.string().default(''),
  /** 上次启动失败的原因（项目或角色被删掉这类），直接显示给用户 */
  lastError: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Schedule = z.infer<typeof Schedule>

const DAY_MS = 86_400_000

/**
 * 超过这个时长才被发现的计划算错过：面板没开着、进程被挂起很久的都不补跑，
 * 只把下一次时间往后推（每天）或标成已跳过（单次）。轮询间隔远小于它，运行中到点的照常执行。
 */
export const SCHEDULE_MISS_MS = 60_000
/** 定时轮询间隔 */
export const SCHEDULE_TICK_MS = 30_000
/** 每天往后推时的循环上限：时间填得再久远也不会卡住 */
const MAX_DAYS = 4000

/** 每天同一时刻的下一次：按本地日历逐天推，跨夏令时也还是同一个时分，不会偏一小时 */
export function nextDailyAt(at: string, now: number): string {
  const d = new Date(at)
  if (!Number.isFinite(d.getTime())) return at
  if (d.getTime() > now) return d.toISOString()
  // 先按整天数跳过去（at 可能是很久以前），剩下的零头再逐天补
  d.setDate(d.getDate() + Math.min(Math.floor((now - d.getTime()) / DAY_MS), MAX_DAYS))
  for (let i = 0; d.getTime() <= now && i < MAX_DAYS; i++) d.setDate(d.getDate() + 1)
  return d.toISOString()
}

export interface ScheduleDue {
  /** 现在就该启动的 */
  run: Schedule[]
  /** 已经错过太久的：不跑，标记一下 */
  missed: Schedule[]
}

/**
 * 现在该处理的计划：没停用、还在待执行、时间到了的。
 * 超过 SCHEDULE_MISS_MS 的算错过，单独分出来（服务端只记录、不启动对话）。
 */
export function pickDue(list: Schedule[], now: number): ScheduleDue {
  const run: Schedule[] = []
  const missed: Schedule[] = []
  for (const s of list) {
    if (!s.enabled || s.status !== 'pending') continue
    const at = Date.parse(s.at)
    if (!Number.isFinite(at) || at > now) continue
    if (now - at > SCHEDULE_MISS_MS) missed.push(s)
    else run.push(s)
  }
  return { run, missed }
}

/** 启动成功之后：单次标成已执行，每天把时间推到下一次，并记下这次启动的对话 */
export function afterRun(s: Schedule, now: number, taskId: string): Partial<Schedule> {
  return {
    ...(s.repeat === 'daily'
      ? { at: nextDailyAt(s.at, now), status: 'pending' as const }
      : { status: 'done' as const }),
    lastRunAt: new Date(now).toISOString(),
    lastTaskId: taskId,
    lastError: '',
  }
}

/**
 * 错过之后：单次标成已跳过，每天推到下一次，并记下错过的是哪一次。
 * 不补跑——用户打开面板时看到的是「错过了一次」，而不是过一会儿突然冒出一堆对话。
 */
export function afterMiss(s: Schedule, now: number): Partial<Schedule> {
  return {
    ...(s.repeat === 'daily'
      ? { at: nextDailyAt(s.at, now), status: 'pending' as const }
      : { status: 'skipped' as const }),
    missedAt: s.at,
  }
}

/**
 * 启动失败（项目被删掉、角色不存在这类）：原因记下来给用户看。
 * 时间照样往后推，否则每轮询一次就重试一次、一直刷错误；单次的标成已跳过，用户改好后再手动执行。
 */
export function afterFail(s: Schedule, now: number, error: string): Partial<Schedule> {
  return {
    ...(s.repeat === 'daily'
      ? { at: nextDailyAt(s.at, now), status: 'pending' as const }
      : { status: 'skipped' as const }),
    lastError: error,
  }
}

/** 「今日工作」模板：每天 19:00 总结当天的工作 */
export const WORKDAY_PLAN = { name: '今日工作', hour: 19, minute: 0 }
const WORKDAY_PROMPT =
  '总结今天做的工作：查看今天在各项目里完成的任务、改动的文件和遇到的问题，整理成一份简短的工作总结。'

/** 下一个「今天 / 明天 19:00」：用户新建计划时预填的时间，过了今天 19:00 就是明天 */
export function workdayTemplate(now: number): Pick<ScheduleInput, 'name' | 'prompt' | 'repeat' | 'at'> {
  const d = new Date(now)
  d.setHours(WORKDAY_PLAN.hour, WORKDAY_PLAN.minute, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return { name: WORKDAY_PLAN.name, prompt: WORKDAY_PROMPT, repeat: 'daily', at: d.toISOString() }
}

/** 两个时间是不是同一分钟：界面上的时间只到分钟，比较排期有没有被改过也按分钟算，避免秒的差异被当成重新排期 */
export function sameMinute(a: string, b: string): boolean {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.floor(ta / 60_000) === Math.floor(tb / 60_000)
}

/** ISO 时间 → datetime-local 输入框的值（本机时区，YYYY-MM-DDTHH:mm） */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local 的值 → ISO 字符串；空值或解析不了时返回空字符串 */
export function fromLocalInput(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}
