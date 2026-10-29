/**
 * 定时计划（左侧导航的「计划」）：到点由面板自己新建一个对话去执行。
 * 前后端共用同一份规则：服务端按它判断到没到点、执行后把时间往后推，界面按它显示下次执行时间。
 * 时间一律存 ISO 字符串，界面按本机时区显示和编辑。
 *
 * 和任务里的「执行计划」（task.plans，见 shared/plan.ts）不是一回事，这里叫 Schedule。
 */
import { z } from 'zod'
import { getLang, t } from './i18n.ts'
import { hhmm, pad2, ymd } from './datetime.ts'
import { MAX_TASK_BUDGET_MINUTES, MAX_TASK_BUDGET_TOKENS } from './schema.ts'

/** 重复规则：只执行一次 / 每天 / 每周指定星期几 / 周一到周五 */
/** 日历的时间刻度（分钟）：周视图半小时一格，拖动、拉伸、右键新建都对齐到它 */
export const SLOT_MIN = 30

export const ScheduleRepeat = z.enum(['once', 'daily', 'weekly', 'workdays'])
export type ScheduleRepeat = z.infer<typeof ScheduleRepeat>

/** 一条计划最多依赖几个上游：界面上多选，再多说明该拆成工作流；上限也挡住拼错的超长数组 */
export const MAX_DEPENDENCIES = 10

/** 待执行 / 已执行 / 已跳过（错过没跑，或者启动失败） */
export const ScheduleStatus = z.enum(['pending', 'done', 'skipped'])
export type ScheduleStatus = z.infer<typeof ScheduleStatus>

/**
 * 计划的执行上限：0 表示不限。
 * token 按输入 + 输出算，和用量统计一个口径；时长从这一轮开始算起，超过就停，已经产出的内容都留着
 */
export const ScheduleBudget = z.object({
  tokens: z.number().int().min(0).max(MAX_TASK_BUDGET_TOKENS).default(0),
  minutes: z.number().int().min(0).max(MAX_TASK_BUDGET_MINUTES).default(0),
})
export type ScheduleBudget = z.infer<typeof ScheduleBudget>

export const ScheduleInput = z.object({
  name: z.string().trim().min(1, t('请填写计划名称')).max(60),
  /** 到点后作为对话的第一句交给 Agent */
  prompt: z.string().trim().min(1, t('请填写到点后要执行的对话内容')).max(20000),
  /** 在哪个项目里执行；为空表示聊天模式（和新建任务一致） */
  projectId: z.string().default(''),
  /** 用哪个角色；为空表示不用 Agent 角色，直接跟随默认 CLI */
  agentId: z.string().default(''),
  repeat: ScheduleRepeat.default('once'),
  /** weekly 时选哪几天执行（1 = 周一 … 7 = 周日，多选）；为空时按 at 那天的星期。其他重复规则忽略 */
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  /** 下次执行时间；不是单次时它是「每个周期的这个时刻」的基准，每次执行后按规则往后推 */
  at: z.string().refine((v) => Number.isFinite(Date.parse(v)), t('请选择执行时间')),
  enabled: z.boolean().default(true),
  /** 上游计划：这些计划这一轮成功启动之后，本计划到点才会启动（见 dependencyBlocker） */
  dependsOn: z.array(z.string()).max(MAX_DEPENDENCIES).default([]),
  /** 这一轮最多用多少 token / 多少分钟；0 表示不限。启动对话时落到任务上 */
  budget: ScheduleBudget.prefault({}),
  /**
   * 结束日期（本机日历的 YYYY-MM-DD，含这一天）：过了这天不再自动执行。
   * 空表示永不结束；旧数据没有这个字段，读盘时补空。只对重复的计划有意义，单次的界面上不给设
   */
  endDate: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, t('结束日期格式不对'))
    .default(''),
  /**
   * 在日历上占多长（分钟，半小时一档）：周视图里块的高度，拖底边改。只是排日程用的，不限制执行时长
   * （限制看 budget.minutes）；旧数据没有，按一小时画
   */
  durationMin: z
    .number()
    .int()
    .min(SLOT_MIN)
    .max(24 * 60)
    .catch(60)
    .default(60),
})
export type ScheduleInput = z.infer<typeof ScheduleInput>

/**
 * Webhook 投递失败最多试几次（含第一次）：有上限，不会无限重试。
 * 重试逻辑在 server/webhook.ts，界面上说明「最多试几次」也用这个值，不各写一个数字
 */
export const WEBHOOK_MAX_ATTEMPTS = 3

/**
 * 计划跑到终态时的 Webhook 事件：成功启动 / 启动失败 / 错过 / 上游没成功。
 * 投递规则和载荷见 server/webhook.ts，界面按这个值说明最近一次投递的是什么
 */
export const ScheduleEvent = z.enum(['run', 'fail', 'miss', 'blocked'])
export type ScheduleEvent = z.infer<typeof ScheduleEvent>

/** 最近一次投递的结果：界面上告诉用户「投出去了没有」 */
export const ScheduleDelivery = z.object({
  /** 投递（最后一次尝试）的时间 */
  at: z.string(),
  event: ScheduleEvent,
  ok: z.boolean(),
  /** HTTP 状态码；没发出去（超时、地址不对）时为 0 */
  status: z.number().default(0),
  /** 失败原因，直接显示给用户；成功时为空 */
  error: z.string().default(''),
  /** 实际尝试了几次 */
  attempts: z.number().default(0),
})
export type ScheduleDelivery = z.infer<typeof ScheduleDelivery>

/**
 * 每条计划保留的运行记录条数：卡片上展开「运行记录」看最近几次，更早的到对应的对话里看。
 * 记录只是展示用的补充，分组和「最近一次结果」仍按 outcomeOf 判，不读它。
 */
export const SCHEDULE_RUN_HISTORY = 10

/**
 * 一次运行的结果：到点启动成功 / 启动失败 / 错过 / 上游没成功。
 * manual 为 true 表示这次是用户点了「立即执行」，不是排期到点触发的。
 */
export const ScheduleRun = z.object({
  /** 排期到点的时间；手动执行时为空（它不对应某一次排期） */
  at: z.string().default(''),
  /** 实际发生的时间 */
  happenedAt: z.string(),
  event: ScheduleEvent,
  manual: z.boolean().default(false),
  /** 这次启动的对话；失败 / 错过 / 上游没成功时为空 */
  taskId: z.string().default(''),
  /** 失败原因，或错过 / 上游没成功的原因；直接显示给用户 */
  error: z.string().default(''),
  /**
   * 启动出来的对话这一轮跑完的时间和耗时（见 settleRun）：计划块的高度、运行记录的「1:12」读它。
   * 还没跑完、启动失败、旧记录都没有这几个字段：界面不显示，也不编造
   */
  endedAt: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
  /** 启动成功了，但对话这一轮以失败结束：运行记录里标成失败，给「AI 分析」入口 */
  failed: z.boolean().optional(),
})
export type ScheduleRun = z.infer<typeof ScheduleRun>

/** 判定一次运行跑没跑完时需要的任务字段（server 用 tasks.peek 取，不读整段对话） */
export interface RunTaskState {
  status: string
  working: boolean
  turnDoneAt: string
  updatedAt: string
}

/**
 * 启动出来的对话跑完了没有：跑完返回补上结束时间、耗时和成败的那条记录，没跑完（或不用补）返回 null。
 * 「跑完」= CLI 这一轮不在处理了，并且这次启动之后完成过一轮（turnDoneAt），或者对话已经失败 / 被停下。
 * 对话之后用户再接着聊不算这次计划的耗时：只补一次，补过的（endedAt 非空）不再改
 */
export function settleRun(run: ScheduleRun, task: RunTaskState | null): ScheduleRun | null {
  if (run.event !== 'run' || !run.taskId || run.endedAt || !task || task.working) return null
  const start = Date.parse(run.happenedAt)
  if (!Number.isFinite(start)) return null
  const turn = Date.parse(task.turnDoneAt)
  const stopped = task.status === 'failed' || task.status === 'stopped'
  const done = Number.isFinite(turn) && turn >= start
  if (!done && !stopped) return null
  const end = done && !stopped ? turn : Date.parse(task.updatedAt)
  if (!Number.isFinite(end)) return null
  return {
    ...run,
    endedAt: new Date(end).toISOString(),
    durationMs: Math.max(0, end - start),
    failed: task.status === 'failed',
  }
}

/** 耗时的短写法：「0:58」「1:12」，超过一小时写「1:02:03」（运行记录里和设计稿一致） */
export function durationLabel(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

/** 往运行记录里加一条：新的在前，只留最近 SCHEDULE_RUN_HISTORY 条 */
export function appendRun(runs: ScheduleRun[] | undefined, run: ScheduleRun): ScheduleRun[] {
  return [run, ...(runs ?? [])].slice(0, SCHEDULE_RUN_HISTORY)
}

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
  /** 最近一次因为上游没有成功而没启动的到点时间；和 missedAt 一样只记最近一次 */
  blockedAt: z.string().default(''),
  /** 没启动的原因，直接显示给用户：因为「X」启动失败，没有启动 */
  blockedReason: z.string().default(''),
  /** 最近一次 Webhook 投递的结果；没开 Webhook 或没配地址时为空 */
  lastDelivery: ScheduleDelivery.nullable().default(null),
  /** 最近几次运行（新的在前，最多 SCHEDULE_RUN_HISTORY 条）；旧数据没有这个字段，读盘时补空数组 */
  runs: z.array(ScheduleRun).default([]),
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

/** 每周的星期选项（1 = 周一 … 7 = 周日）：编辑弹窗和文案共用这一张表 */
export const SCHEDULE_WEEKDAYS = [
  { id: 1, label: t('周一') },
  { id: 2, label: t('周二') },
  { id: 3, label: t('周三') },
  { id: 4, label: t('周四') },
  { id: 5, label: t('周五') },
  { id: 6, label: t('周六') },
  { id: 7, label: t('周日') },
] as const

/** ISO 星期：周一 1 … 周日 7（JS 的 getDay 是周日 0，换过来才和 weekdays 对得上） */
export function isoWeekday(d: Date) {
  return ((d.getDay() + 6) % 7) + 1
}

/**
 * 一条计划一周里哪几天执行：null 表示每天；集合为空表示不会再自动执行（只有单次）。
 * weekly 没选星期时按 at 那天的星期：weekly 的默认语义就是「每周同一天」。
 */
function repeatDays(s: Pick<ScheduleInput, 'repeat' | 'at' | 'weekdays'>): Set<number> | null {
  switch (s.repeat) {
    case 'daily':
      return null
    case 'workdays':
      return new Set([1, 2, 3, 4, 5])
    case 'weekly': {
      const picked = new Set((s.weekdays ?? []).filter((d) => d >= 1 && d <= 7))
      if (!picked.size) {
        const at = new Date(s.at)
        if (Number.isFinite(at.getTime())) picked.add(isoWeekday(at))
      }
      // 认不出 at 时给周一，至少不会算出「没有下一次」
      return picked.size ? picked : new Set([1])
    }
    default:
      return new Set()
  }
}

/**
 * 把执行时间对齐到规则允许的最近时刻：weekly / workdays 的首次执行也必须落在符合规则的星期。
 * 保存前调用（服务端 / 演示后端），这样存下来的 at 和徽标、到点判定一致；已经符合规则时原样返回。
 */
export function alignScheduleAt(s: Pick<ScheduleInput, 'repeat' | 'at' | 'weekdays'>): string {
  const at = new Date(s.at)
  if (!Number.isFinite(at.getTime())) return s.at
  // 单次和每天都合法，原样返回
  if (s.repeat === 'once' || s.repeat === 'daily') return s.at
  const days = repeatDays(s)
  // once 已经提前返回，这里不会是 null；留个兜底免得类型和运行时分叉
  if (!days) return s.at
  const d = new Date(at)
  for (let i = 0; i < MAX_DAYS; i++) {
    if (days.has(isoWeekday(d))) return d.toISOString()
    d.setDate(d.getDate() + 1)
  }
  return s.at
}

/**
 * 在周视图里把某一次执行（occAt）拖到 to：算出保存用的 at 和 weekdays，放不下时给出原因（直接显示给用户）。
 * - 单次：执行时间就是 to，不能拖到过去；
 * - 每周：把那一次所在的星期换成新的星期（其余勾着的不动），时分跟着改；
 * - 工作日：不能拖到周末；每天 / 工作日只改时分（日期换到哪天都一样）；
 * 重复的计划下一次从今天起按新规则算（今天这个时刻已经过了就从下一次开始），不记一次「错过」
 */
export function movedSchedule(
  s: Pick<ScheduleInput, 'repeat' | 'at' | 'weekdays'>,
  occAt: number,
  to: number,
  now: number,
): { at: string; weekdays: number[] } | { error: string } {
  const target = new Date(to)
  if (s.repeat === 'once') {
    if (to < now) return { error: t('不能挪到已经过去的时间') }
    return { at: target.toISOString(), weekdays: [] }
  }
  let weekdays = s.weekdays
  if (s.repeat === 'workdays' && isoWeekday(target) > 5) return { error: t('工作日计划不能挪到周末') }
  if (s.repeat === 'weekly') {
    const from = isoWeekday(new Date(occAt))
    const base = s.weekdays.length ? s.weekdays : [isoWeekday(new Date(s.at))]
    weekdays = [...new Set(base.map((d) => (d === from ? isoWeekday(target) : d)))].sort((a, b) => a - b)
  }
  // 重复的计划只换时分（和每周的星期）：下一次从今天起按新规则算，拖的是哪一周的那一次都一样，
  // 不会因为拖了下周的那一格就把这几天的执行跳过去
  const base = new Date(now)
  base.setHours(target.getHours(), target.getMinutes(), 0, 0)
  const rule = { repeat: s.repeat, at: base.toISOString(), weekdays }
  return { at: base.getTime() < now ? nextRunAt(rule, now) : alignScheduleAt(rule), weekdays }
}

/**
 * 结束日期那天过完的时刻（次日 0 点，本机时区）：执行时间不早于它的都不会再跑。
 * 没设结束日期（永不）或格式不对时返回 Infinity，按永不结束处理
 */
export function scheduleEndMs(s: { endDate?: string }): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.endDate ?? '')
  if (!m) return Infinity
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime()
}

/** 下一次执行时间已经过了结束日期：不再自动执行，界面上显示「已结束」 */
export function scheduleEnded(s: Pick<ScheduleInput, 'at'> & { endDate?: string }): boolean {
  const at = Date.parse(s.at)
  return Number.isFinite(at) && at >= scheduleEndMs(s)
}

/**
 * 保存前的排期校验（界面和服务端同一份）：返回给用户看的原因，通过返回空字符串。
 * 结束日期早于（对齐后的）首次执行时，这条计划一次也不会跑，多半是填错了，直接拦下
 */
export function scheduleTimingError(s: Pick<ScheduleInput, 'repeat' | 'at' | 'weekdays' | 'endDate'>): string {
  if (!s.endDate) return ''
  if (!Number.isFinite(scheduleEndMs(s))) return t('结束日期格式不对')
  if (scheduleEnded({ at: alignScheduleAt(s), endDate: s.endDate }))
    return t('结束日期早于第一次执行，计划一次也不会执行')
  return ''
}

/**
 * 下一次执行时间（严格晚于 now）。
 * 按本地日历逐天推进：跨周、跨月、跨年、夏令时都还是同一个时分，不会偏一小时。
 * 单次直接返回 at（由调用方决定不再执行）；weekly / workdays 即使首次执行时间还没到，
 * 也只返回符合星期的日子（保存时已用 `alignScheduleAt` 对齐，这里再兵一道）。
 */
export function nextRunAt(s: Pick<ScheduleInput, 'repeat' | 'at' | 'weekdays'>, now: number): string {
  // 过了结束日期也照样往后推：存下来的 at 越过结束日期就是「已结束」（scheduleEnded），
  // 到点判定、周视图、「接下来」都按它不再排；用户把结束日期往后改时从这里接着跑
  const at = new Date(s.at)
  if (!Number.isFinite(at.getTime())) return s.at
  if (s.repeat === 'once') return at.toISOString()
  const days = repeatDays(s)
  const d = new Date(at)
  if (days) {
    // 每周 / 工作日：先按整天数快进到 now 附近（at 可能很多年以前），再逐天找符合星期的。
    // at 在未到且符合星期时不会跳（jump 为负），直接返回 at；不符合时从 at 往后数几天
    const jump = Math.floor((now - at.getTime()) / DAY_MS) - 1
    if (jump > 0) d.setDate(d.getDate() + Math.min(jump, MAX_DAYS))
    for (let i = 0; i < MAX_DAYS; i++) {
      if (d.getTime() > now && days.has(isoWeekday(d))) return d.toISOString()
      d.setDate(d.getDate() + 1)
    }
    return at.toISOString()
  }
  // 每天：还没到就直接返回，到了先按整天数跳（at 可能是很久以前），剩下的零头再逐天补
  if (at.getTime() > now) return at.toISOString()
  d.setDate(d.getDate() + Math.min(Math.floor((now - d.getTime()) / DAY_MS), MAX_DAYS))
  for (let i = 0; d.getTime() <= now && i < MAX_DAYS; i++) d.setDate(d.getDate() + 1)
  return d.toISOString()
}

/** 某天所在那周的周一 0 点（本地时间）：计划页的周视图按它翻周 */
export function weekStartOf(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (isoWeekday(d) - 1))
  return d.getTime()
}

/**
 * 计划页周视图：这条计划在 weekStart（那周周一 0 点）开始的 7 天里会在哪些时刻执行。
 * 停用的不画；单次只看 at；重复的按 repeatDays 逐天排，同一个时分，at 之前的日子不算（还没开始）。
 * 重复计划跑完一次 at 会往后挪（见 afterRun），所以这里只画「还会跑的」，已经跑过的看运行记录
 */
export function weekOccurrences(
  s: Pick<ScheduleInput, 'repeat' | 'at' | 'weekdays' | 'enabled'> & { endDate?: string },
  weekStart: number,
): number[] {
  const at = new Date(s.at)
  if (!s.enabled || !Number.isFinite(at.getTime())) return []
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 7)
  // 一周的末尾和结束日期取早的：过了结束日期的日子不画
  const end = new Date(Math.min(weekEnd.getTime(), scheduleEndMs(s)))
  if (s.repeat === 'once') return at.getTime() >= weekStart && at < end ? [at.getTime()] : []
  const days = repeatDays(s)
  const out: number[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    d.setHours(at.getHours(), at.getMinutes(), 0, 0)
    if (d.getTime() < at.getTime() || d >= end) continue
    if (!days || days.has(isoWeekday(d))) out.push(d.getTime())
  }
  return out
}

/** 每天同一时刻的下一次（保留的旧接口，内部走 nextRunAt） */
export function nextDailyAt(at: string, now: number): string {
  return nextRunAt({ repeat: 'daily', at, weekdays: [] }, now)
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
    // 过了结束日期的不再触发，也不记错过：是用户定好的到此为止
    if (!s.enabled || s.status !== 'pending' || scheduleEnded(s)) continue
    const at = Date.parse(s.at)
    if (!Number.isFinite(at) || at > now) continue
    if (now - at > SCHEDULE_MISS_MS) missed.push(s)
    else run.push(s)
  }
  return { run, missed }
}

/** 启动成功之后：单次标成已执行，其余按重复规则把时间推到下一次，并记下这次启动的对话 */
export function afterRun(s: Schedule, now: number, taskId: string): Partial<Schedule> {
  return {
    ...(s.repeat === 'once' ? { status: 'done' as const } : { at: nextRunAt(s, now), status: 'pending' as const }),
    lastRunAt: new Date(now).toISOString(),
    lastTaskId: taskId,
    lastError: '',
    // 这次启动成功了，之前「因为上游没启动」的记录不再算数
    blockedAt: '',
    blockedReason: '',
  }
}

/**
 * 上游没成功所以没启动：和错过一样把时间往后推（否则每轮询一次就重试一次），
 * 但单独记下到点时间和原因——「因为 X 失败没启动」和「面板没开着错过了」是两回事，
 * 用户要能看出该去修哪个上游。
 */
export function afterBlocked(s: Schedule, now: number, reason: string): Partial<Schedule> {
  return {
    ...(s.repeat === 'once' ? { status: 'skipped' as const } : { at: nextRunAt(s, now), status: 'pending' as const }),
    blockedAt: s.at,
    blockedReason: reason,
  }
}

/**
 * 错过之后：单次标成已跳过，其余按重复规则推到下一次，并记下错过的是哪一次。
 * 不补跑——用户打开面板时看到的是「错过了一次」，而不是过一会儿突然冒出一堆对话。
 */
export function afterMiss(s: Schedule, now: number): Partial<Schedule> {
  return {
    ...(s.repeat === 'once' ? { status: 'skipped' as const } : { at: nextRunAt(s, now), status: 'pending' as const }),
    missedAt: s.at,
  }
}

/**
 * 启动失败（项目被删掉、角色不存在这类）：原因记下来给用户看。
 * 时间照样往后推，否则每轮询一次就重试一次、一直刷错误；单次的标成已跳过，用户改好后再手动执行。
 */
export function afterFail(s: Schedule, now: number, error: string): Partial<Schedule> {
  return {
    ...(s.repeat === 'once' ? { status: 'skipped' as const } : { at: nextRunAt(s, now), status: 'pending' as const }),
    lastError: error,
  }
}

/**
 * 时长上限怎么取：设置里的单步时限和计划带的时长上限都算上限，取小的那个；0 表示不限。
 * 返回的 by 说明停的时候该按哪个上限解释（提示文案不同），用户才知道该去哪里改。
 */
export function effectiveTimeoutMinutes(
  stepMinutes: number,
  budgetMinutes: number,
): { minutes: number; by: 'step' | 'budget' | '' } {
  if (!stepMinutes && !budgetMinutes) return { minutes: 0, by: '' }
  if (!budgetMinutes) return { minutes: stepMinutes, by: 'step' }
  if (!stepMinutes) return { minutes: budgetMinutes, by: 'budget' }
  return stepMinutes <= budgetMinutes ? { minutes: stepMinutes, by: 'step' } : { minutes: budgetMinutes, by: 'budget' }
}

/**
 * 上游「这一轮成功」的有效窗口（小时）。
 * 计划目前只保证「到点成功启动一个对话」，不等那次对话跑完（进度在对话里看），
 * 所以依赖只能按上游最近一次成功启动算；超过这个窗口认为上游已经停摆，不再拿旧的成功给下游放行。
 * 默认 24 小时：跨天的计划（上游每天跑一次）也放得进去，再久就说明上游真的没在跑。
 */
export const SCHEDULE_DEPENDENCY_FRESH_HOURS = 24

/**
 * 下游到点时上游算不算成功。返回空字符串表示可以启动，否则是写进计划的、给用户看的原因。
 * started 是「本轮同一批刚刚成功启动的」上游：上游和下游同时到点时，不能因为上游刚启动、
 * 记录还没写回就说「上游还没执行过」（那样下游要等下一次轮询，甚至会被当成错过）。
 */
export function dependencyBlocker(
  s: Pick<Schedule, 'dependsOn'>,
  list: Schedule[],
  now: number,
  started: ReadonlySet<string> = new Set(),
): string {
  const byId = new Map(list.map((x) => [x.id, x]))
  for (const id of s.dependsOn ?? []) {
    const up = byId.get(id)
    if (!up) return t('因为上游计划已不存在，没有启动')
    if (started.has(up.id)) continue
    if (!up.enabled) return t('因为「{name}」已停用，没有启动', { name: up.name })
    switch (outcomeOf(up)) {
      case 'error':
        return t('因为「{name}」启动失败，没有启动', { name: up.name })
      case 'missed':
        return t('因为「{name}」错过，没有启动', { name: up.name })
      case 'blocked':
        return t('因为「{name}」的上游没有成功，没有启动', { name: up.name })
      case 'none':
        return t('因为「{name}」还没有执行过，没有启动', { name: up.name })
      default: {
        const ok = Date.parse(up.lastRunAt)
        if (!Number.isFinite(ok) || now - ok > SCHEDULE_DEPENDENCY_FRESH_HOURS * 3_600_000)
          return t('因为「{name}」最近一次成功已经超过 {n} 小时，没有启动', {
            name: up.name,
            n: SCHEDULE_DEPENDENCY_FRESH_HOURS,
          })
      }
    }
  }
  return ''
}

/**
 * 依赖成环的检查：返回环上的计划 id（首尾是同一个，例如 [a, b, a]），没有环返回空数组。
 * 保存前调用：list 是已有的计划，selfId 是正在保存的那条（新建时为空），dependsOn 是这次要存的上游。
 * 新建时还没有 id，别的计划不可能依赖它，所以新建不会成环，直接返回空。
 */
export function scheduleCycle(list: Schedule[], selfId: string, dependsOn: string[]): string[] {
  if (!selfId) return []
  const deps = new Map<string, string[]>(list.map((s) => [s.id, s.dependsOn ?? []]))
  deps.set(selfId, dependsOn)
  const path: string[] = [selfId]
  const walk = (id: string, seen: Set<string>): string[] | null => {
    for (const up of deps.get(id) ?? []) {
      // 回到自己：整条路径就是环；多带一次起点，展示时能写成「A → B → A」
      if (up === selfId) return [...path, selfId]
      if (seen.has(up)) continue
      seen.add(up)
      path.push(up)
      const found = walk(up, seen)
      if (found) return found
      path.pop()
    }
    return null
  }
  return walk(selfId, new Set([selfId])) ?? []
}

/** 环转成用户看得懂的写法：「A」→「B」→「A」；计划被删掉的按 id 显示，不吞成空 */
export function scheduleCycleLabel(path: string[], list: Schedule[]): string {
  const nameOf = new Map(list.map((s) => [s.id, s.name]))
  return path.map((id) => `「${nameOf.get(id) ?? id}」`).join(' → ')
}

/**
 * 按依赖顺序排一下这一批要启动的计划：上游排在下游前面，启动时才能把「本轮已成功」传给下游。
 * 成环的（不该存在，保存时已经拦了）按原顺序追加，不死循环。
 */
export function orderByDependency(list: Schedule[]): Schedule[] {
  const byId = new Map(list.map((s) => [s.id, s]))
  const out: Schedule[] = []
  const placed = new Set<string>()
  const visit = (s: Schedule, stack: Set<string>) => {
    if (placed.has(s.id) || stack.has(s.id)) return
    stack.add(s.id)
    for (const id of s.dependsOn ?? []) {
      const up = byId.get(id)
      // 上游不在这一批里（没到点、已经跑完）也要占位：它会在启动时单独判定
      if (up) visit(up, stack)
    }
    stack.delete(s.id)
    placed.add(s.id)
    out.push(s)
  }
  for (const s of list) visit(s, new Set())
  return out
}

/** 重复规则的短标签（卡片徽标、编辑弹窗共用）：具体星期由下次执行时间体现 */
export function repeatLabel(repeat: ScheduleRepeat): string {
  return {
    once: t('单次'),
    daily: t('每天'),
    weekly: t('每周'),
    workdays: t('工作日'),
  }[repeat]
}

/** 「今日工作」模板：每天 19:00 总结当天的工作 */
export const WORKDAY_PLAN = { name: '今日工作', hour: 19, minute: 0 }
const WORKDAY_PROMPT =
  '总结今天做的工作：查看今天在各项目里完成的任务、改动的文件和遇到的问题，整理成一份简短的工作总结。'

/** 模板时刻的文案（「19:00」）：空状态和编辑弹窗共用，模板改了这里跟着变 */
export function workdayTimeLabel(): string {
  return `${WORKDAY_PLAN.hour}:${pad2(WORKDAY_PLAN.minute)}`
}

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
  return `${ymd(d)}T${hhmm(d)}`
}

/** datetime-local 的值 → ISO 字符串；空值或解析不了时返回空字符串 */
export function fromLocalInput(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}

/**
 * 列表里的分组。顺序就是列表里的显示顺序：还能跑的在上、要处理的其次、已经停下的在下。
 * 「不会再执行」是单次计划跑完之后的状态，和用户主动停用的计划分开：一个要重新排期，一个要打开开关。
 */
export const SCHEDULE_GROUPS = ['upcoming', 'problem', 'disabled', 'finished'] as const
export type ScheduleGroup = (typeof SCHEDULE_GROUPS)[number]

/** 最近一次结果：启动失败 / 错过 / 上游没成功 / 成功启动 / 还没跑过。徽标、分组、计数都读它，不各自再判一次 */
export type ScheduleOutcome = 'error' | 'missed' | 'blocked' | 'success' | 'none'

/**
 * 最近一次结果。
 * 错过和「上游没成功」都是「到点了没跑」，取更晚的那次；它们都不早于上次启动时才算数：
 * 每天的计划成功启动后 missedAt / blockedAt 还留着前一次的记录，不能一直显示成错过。
 * 没有更新的「没跑」记录时，lastError 非空就说明最近一次已知结果是启动失败。
 * lastError 在启动成功时清空，所以不用单独比时间。
 */
export function outcomeOf(s: Schedule): ScheduleOutcome {
  const run = Date.parse(s.lastRunAt)
  const hasRun = !!s.lastRunAt && Number.isFinite(run)
  const missed = Date.parse(s.missedAt)
  const blocked = Date.parse(s.blockedAt)
  const hasMissed = !!s.missedAt && Number.isFinite(missed)
  const hasBlocked = !!s.blockedAt && Number.isFinite(blocked)
  if (hasMissed || hasBlocked) {
    const latest = Math.max(hasMissed ? missed : -Infinity, hasBlocked ? blocked : -Infinity)
    if (!hasRun || latest >= run) return hasBlocked && (!hasMissed || blocked >= missed) ? 'blocked' : 'missed'
  }
  if (s.lastError) return 'error'
  return hasRun ? 'success' : 'none'
}

/** 到点还会不会自动执行：停用、单次已执行完 / 已跳过、单次启动失败、过了结束日期都没有下一次 */
export function willRunAgain(s: Schedule): boolean {
  return s.enabled && s.status === 'pending' && !scheduleEnded(s)
}

/**
 * 下一次会自动执行的计划：所有还会自动执行的计划里 at 最早的一条（出过问题但没停用的也算）。
 * 概览的「下一次执行」和「待执行」计数要用同一个集合：只从「即将执行」组取的话，
 * 错过过的每天计划在「出过问题」组里、今晚照样会跑，却不会成为「下一次执行」，和计数自相矛盾。
 */
export function nextToRun(list: Schedule[]): Schedule | undefined {
  let best: Schedule | undefined
  let bestAt = Infinity
  for (const s of list) {
    if (!willRunAgain(s)) continue
    const at = Date.parse(s.at)
    if (!Number.isFinite(at) || at >= bestAt) continue
    best = s
    bestAt = at
  }
  return best
}

/**
 * 卡片归到哪一组。停用优先：用户主动停下的计划不再拿旧问题提醒他，但错过 / 失败的原因照样显示在卡片上。
 */
export function groupOf(s: Schedule): ScheduleGroup {
  if (!s.enabled) return 'disabled'
  const outcome = outcomeOf(s)
  if (outcome === 'error' || outcome === 'missed' || outcome === 'blocked') return 'problem'
  return willRunAgain(s) ? 'upcoming' : 'finished'
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** 一天里从几点开始说「今晚」：傍晚以后的计划读起来更自然 */
const EVENING_HOUR = 18
/** 超过这个时长就不写相对时间，只留绝对时间（「28 天后」没人算得出来是哪天） */
const RELATIVE_MAX_DAYS = 30

/** 两个时刻相差几个自然日（按本地日历算，跨夏令时也不会差一天） */
function dayGap(target: Date, base: Date): number {
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate())
  const b = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  return Math.round((a.getTime() - b.getTime()) / DAY_MS)
}

/** 「今晚 19:00」「明天 09:00」「3月5日 19:00」这类绝对时间；过去的写「昨天」 */
export function whenLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const base = new Date(now)
  const locale = getLang() === 'en' ? 'en-US' : 'zh-CN'
  const gap = dayGap(d, base)
  const day =
    gap === 0
      ? d.getHours() >= EVENING_HOUR
        ? t('今晚')
        : t('今天')
      : gap === 1
        ? t('明天')
        : gap === 2
          ? t('后天')
          : gap === -1
            ? t('昨天')
            : d.toLocaleDateString(locale, {
                ...(d.getFullYear() === base.getFullYear() ? {} : { year: 'numeric' as const }),
                month: 'long',
                day: 'numeric',
              })
  return t('{day} {time}', { day, time: hhmm(d) })
}

/** 还有多久：「已到点」「12 分钟后」「3 小时后」「5 天后」；太远的不写 */
export function relativeFuture(iso: string, now = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const left = at - now
  if (left <= 0) return t('已到点')
  if (left < MINUTE_MS) return t('不到 1 分钟后')
  if (left < HOUR_MS) return t('{n} 分钟后', { n: Math.round(left / MINUTE_MS) })
  if (left < DAY_MS) return t('{n} 小时后', { n: Math.round(left / HOUR_MS) })
  if (left < RELATIVE_MAX_DAYS * DAY_MS) return t('{n} 天后', { n: Math.round(left / DAY_MS) })
  return ''
}

/** 下次执行时间：「今晚 19:00（3 小时后）」；不会再次执行时返回空字符串，界面自己写「不会再次执行」 */
export function nextRunLabel(s: Schedule, now = Date.now()): string {
  if (!willRunAgain(s)) return ''
  const at = Date.parse(s.at)
  if (!Number.isFinite(at)) return ''
  const when = whenLabel(s.at, now)
  const rel = relativeFuture(s.at, now)
  return rel ? t('{when}（{rel}）', { when, rel }) : when
}

/** 组内排序用的活动时间：最近一次启动 / 错过 / 改动，取最大的那个。下次执行时间 at 不算：
 * 它可能是未来（例如停用前排到明年），算进来会把一条早就不动的计划顶到组最上面。 */
function activityAt(s: Schedule): number {
  let at = 0
  for (const iso of [s.lastRunAt, s.missedAt, s.blockedAt, s.updatedAt]) {
    const v = Date.parse(iso)
    if (Number.isFinite(v)) at = Math.max(at, v)
  }
  return at
}

export interface ScheduleBucket {
  group: ScheduleGroup
  items: Schedule[]
}

/**
 * 按分组整理列表：组的顺序固定，空组不出现。
 * 组内即将执行的按下次执行时间升序（先跑的在上）；其余组按最近一次活动倒序（刚出问题、刚停用的在上）。
 */
export function groupSchedules(list: Schedule[]): ScheduleBucket[] {
  const buckets = new Map<ScheduleGroup, Schedule[]>(SCHEDULE_GROUPS.map((g) => [g, []]))
  for (const s of list) buckets.get(groupOf(s))?.push(s)
  return SCHEDULE_GROUPS.flatMap((group) => {
    const items = [...(buckets.get(group) ?? [])]
    items.sort(
      group === 'upcoming'
        ? (a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)
        : (a, b) => activityAt(b) - activityAt(a),
    )
    return items.length ? [{ group, items }] : []
  })
}

/** 分组标题（组标题和它的数量文案都由它出） */
export function groupLabel(group: ScheduleGroup): string {
  return {
    upcoming: t('即将执行'),
    problem: t('出过问题'),
    disabled: t('已停用'),
    finished: t('不会再执行'),
  }[group]
}

/** 运行记录每条结果的短标签（卡片上的历史列表用）；「最近一次结果」仍用 outcomeTitle */
export function runLabel(run: ScheduleRun): string {
  return {
    run: t('启动成功'),
    fail: t('启动失败'),
    miss: t('错过'),
    blocked: t('未启动'),
  }[run.event]
}

/** 最近一次结果的短标签（卡片徽标用）；详细的一句用 outcomeLabel */
export function outcomeTitle(s: Schedule): string {
  return {
    error: t('启动失败'),
    missed: t('错过'),
    blocked: t('未启动'),
    success: t('已启动'),
    none: t('还没执行'),
  }[outcomeOf(s)]
}

/** 最近一次结果的一句话：卡片上的徽标旁边用它，耗时不留空也不编造 */
export function outcomeLabel(s: Schedule, now = Date.now()): string {
  switch (outcomeOf(s)) {
    case 'error':
      return t('启动失败')
    case 'missed':
      return t('错过 {time}（面板当时没在跑，不补跑）', { time: whenLabel(s.missedAt, now) })
    // 原因里已经写清了是哪个上游、什么结果，不在这里再拼一遍
    case 'blocked':
      return s.blockedReason || t('上游没有成功，没有启动')
    case 'success':
      return t('成功启动于 {time}', { time: whenLabel(s.lastRunAt, now) })
    case 'none':
      return t('还没有执行过')
  }
}
