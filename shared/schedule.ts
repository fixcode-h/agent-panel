/**
 * 定时计划（左侧导航的「计划」）：到点由面板自己新建一个对话去执行。
 * 前后端共用同一份规则：服务端按它判断到没到点、执行后把时间往后推，界面按它显示下次执行时间。
 * 时间一律存 ISO 字符串，界面按本机时区显示和编辑。
 *
 * 和任务里的「执行计划」（task.plans，见 shared/plan.ts）不是一回事，这里叫 Schedule。
 */
import { z } from 'zod'
import { getLang, t } from './i18n.ts'
import { hhmm, ymd } from './datetime.ts'

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

/** 最近一次结果：启动失败 / 错过 / 成功启动 / 还没跑过。徽标、分组、计数都读它，不各自再判一次 */
export type ScheduleOutcome = 'error' | 'missed' | 'success' | 'none'

/**
 * 最近一次结果。
 * 错过记录只有不早于上次启动时才算数：每天的计划成功启动后 missedAt 还留着前一次错过的记录，
 * 不能一直显示成「错过」。错过和 failed 同时存在时（先启动失败、之后又错过）错过发生得更晚，
 * 所以先判错过；错误原文由卡片单独的段落继续显示，不会被吞。
 * lastError 在启动成功时清空，非空且没有更新的错过时，最近一次已知的结果就是启动失败。
 */
export function outcomeOf(s: Schedule): ScheduleOutcome {
  if (s.missedAt) {
    const missed = Date.parse(s.missedAt)
    const run = Date.parse(s.lastRunAt)
    if (!s.lastRunAt || !Number.isFinite(run) || missed >= run) return 'missed'
  }
  if (s.lastError) return 'error'
  return s.lastRunAt ? 'success' : 'none'
}

/** 到点还会不会自动执行：停用、单次已执行完 / 已跳过、单次启动失败都没有下一次 */
export function willRunAgain(s: Schedule): boolean {
  return s.enabled && s.status === 'pending'
}

/**
 * 卡片归到哪一组。停用优先：用户主动停下的计划不再拿旧问题提醒他，但错过 / 失败的原因照样显示在卡片上。
 */
export function groupOf(s: Schedule): ScheduleGroup {
  if (!s.enabled) return 'disabled'
  const outcome = outcomeOf(s)
  if (outcome === 'error' || outcome === 'missed') return 'problem'
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
  for (const iso of [s.lastRunAt, s.missedAt, s.updatedAt]) {
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

/** 最近一次结果的短标签（卡片徽标用）；详细的一句用 outcomeLabel */
export function outcomeTitle(s: Schedule): string {
  return {
    error: t('启动失败'),
    missed: t('错过'),
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
    case 'success':
      return t('成功启动于 {time}', { time: whenLabel(s.lastRunAt, now) })
    case 'none':
      return t('还没有执行过')
  }
}
