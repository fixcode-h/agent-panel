/**
 * 工作总结：选几个项目，把一段时间（本机时区）里执行过的对话整理成一份 Markdown 报告。
 *
 * 范围口径（`SummaryRange` + `rangeWindow`）：默认「今天」，也可以看昨天、最近 7 天、自选起止日期。
 * 窗口都是左闭右开：today / last7 的结束时间是「现在」（不包含未来），yesterday / custom 的结束时间是
 * 结束日期的次日 0 点（包含结束那一天）。所有判定（服务端筛任务、页面列出对话）都只用 `rangeWindow`，
 * 不再各自按自然日算；老数据只有单日 `day` 时按「那一天」处理（`dayTask` / `collectDayProjects`）。
 *
 * 这里只有纯逻辑：时间窗口、从任务里提炼范围内的活动、交给 CLI 的提示词、从回答里取出报告。
 * 跑 CLI 和存报告在 server/summary.ts；页面在 web/src/pages/SummaryPage.tsx
 */
import { z } from 'zod'
import { promptLangRules } from './prompt-lang.ts'
import { t } from './i18n.ts'
import type { Task } from './schema.ts'
import { dayKey } from './usage.ts'
import { clip as clipText } from './text.ts'
// 两份报告解析不了（用户手改过格式）时退回纯文本 diff，和「修改建议」用的是同一份按行比较
import { lineDiff } from './task-export.ts'

/** 数据目录里保留最近几份报告：生成新的时把更早的删掉 */
export const SUMMARY_KEEP = 20
/** 每个项目最多交给 CLI 几条今天的对话 */
export const SUMMARY_TASKS_PER_PROJECT = 12
/** 每条摘录最多多少字：报告要简短，提示词里也不放整段对话 */
export const SUMMARY_LINE_MAX = 160
/** 每个任务最多取几条用户要求 / 几条结论 */
export const SUMMARY_ASKS_MAX = 4
export const SUMMARY_OUTCOMES_MAX = 3
/** 每个任务最多取几个节点、几个改动文件 */
export const SUMMARY_STEPS_MAX = 8
export const SUMMARY_FILES_MAX = 8

/**
 * 命中这些词就认为这条对话可能在修 Bug：提示词里给 CLI 一个线索。
 * 只收明确指向故障的词——「错误」「异常」「失败」在日常需求里太常见（例如「接口失败要不要加重试」），
 * 会把普通对话也标成 Bug 修复。只是线索，不是硬条件：用户原文里描述了异常现象也照写，由 CLI 按内容判断
 */
export const SUMMARY_BUG_HINTS = ['bug', '修复', '报错', '崩溃', 'fix', '没反应', '不生效', '卡住', '闪退']

/** 报告的时间范围：今天 / 昨天 / 最近 7 天 / 自选起止日期 */
export const SUMMARY_RANGES = ['today', 'yesterday', 'last7', 'custom'] as const
export type SummaryRangeId = (typeof SUMMARY_RANGES)[number]

/** 近 7 天包含今天：从今天往前数 6 天到今天 */
export const SUMMARY_LAST7_DAYS = 7

/** 选中的范围；custom 的两个日期是 YYYY-MM-DD（本机时区），其它范围忽略它们 */
export const SummaryRange = z.object({
  id: z.enum(SUMMARY_RANGES).default('today'),
  from: z.string().default(''),
  to: z.string().default(''),
})
export type SummaryRange = z.infer<typeof SummaryRange>

/** 页面默认选的范围，也是接口不带 range 时的默认值：行为和改造前一样，只看今天 */
export const DEFAULT_SUMMARY_RANGE: SummaryRange = { id: 'today', from: '', to: '' }

/** 报告里固定的三个二级标题：顺序也是这个，缺一节不许省 */
export const SUMMARY_SECTIONS = ['## 一、需求进度', '## 二、用户报告的 Bug', '## 三、今日小结'] as const

/** 日期格式（YYYY-MM-DD）：报告一级标题里的日期，单日或多日区间 */
const DAY_KEY_PATTERN = '\\d{4}-\\d{2}-\\d{2}'

/**
 * 格式自检的问题码：报告不合格时只留问题码，页面按当前语言显示文案。
 * 定义在这里是因为提示词、服务端自检和页面提示用的是同一个口径
 */
export const SUMMARY_FORMAT_ISSUES = {
  title: '一级标题不是「# <日期> 工作总结」',
  sections: '二级标题不是固定的三节（或顺序、数量不对）',
  project: '项目标题格式不对（应为「### 1.1 项目名」）',
  item: '条目格式不对（应为「1. **标题** ｜ 状态」加缩进一行的「实现：/原因：/修复：」）',
  empty: '某一节没有内容时没有写「暂无」',
} as const
export type SummaryFormatIssue = keyof typeof SUMMARY_FORMAT_ISSUES

/** 报告里每个项目的选择：只分析这些对话，空列表表示该项目今天全部对话 */
export const SummaryProjectPick = z.object({
  projectId: z.string().min(1),
  taskIds: z.array(z.string().min(1)).default([]),
})
export type SummaryProjectPick = z.infer<typeof SummaryProjectPick>

/** 生成报告：选中的项目（含每个项目下要分析的对话）、用哪个 CLI / 模型 / 思考强度跑 */
export const SummaryRequest = z.object({
  projects: z.array(SummaryProjectPick).min(1).max(50),
  cli: z.string().min(1),
  model: z.string().trim().default(''),
  effort: z.string().trim().default(''),
  /** 总结哪段时间；不传就是今天（老页面 / 老调用方照常工作） */
  range: SummaryRange.default(DEFAULT_SUMMARY_RANGE),
})
export type SummaryRequest = z.infer<typeof SummaryRequest>

/** 存下来的一份报告：正文可以再编辑（PUT /summary/:id） */
export const SummaryReport = z.object({
  /** 覆盖范围内最后一天的本地日期，格式 2026-10-23；老报告只有这一个日期 */
  day: z.string(),
  /** 覆盖范围的第一天（含）/ 最后一天（含）；老报告没有这两个字段，按 day 单日处理 */
  from: z.string().default(''),
  to: z.string().default(''),
  /** 生成时选中的项目（顺序就是报告里的顺序） */
  projectIds: z.array(z.string()).default([]),
  projectNames: z.array(z.string()).default([]),
  /** Markdown 正文；用户编辑后的内容也存这里 */
  md: z.string().default(''),
  cli: z.string().default(''),
  model: z.string().default(''),
  effort: z.string().default(''),
  /** 生成时用到了几条今天的对话（0 表示今天没有执行记录） */
  taskCount: z.number().int().default(0),
})
export type SummaryReport = z.infer<typeof SummaryReport>

/** 存进数据目录的记录：在报告字段上补 id 和时间（和别的集合一样） */
export const SummaryRecord = SummaryReport.extend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SummaryRecord = z.infer<typeof SummaryRecord>

export interface SummaryJob {
  id: string
  /** stopped：用户主动停了（不是错误），页面上按普通提示显示 */
  status: 'running' | 'done' | 'failed' | 'stopped'
  projectIds: string[]
  /** 生成好的 Markdown */
  md: string
  /** 存下来的报告 id：生成成功才有，页面据此继续编辑 */
  reportId?: string
  /** 这次生成覆盖的日期（YYYY-MM-DD）：页面切回来 / 生成完成时按它显示报告标题 */
  from?: string
  to?: string
  /** 生成后的格式自检：ok 为 false 表示重试一次后仍然不完整，页面要明确提示，不静默通过 */
  format?: { ok: boolean; issues: SummaryFormatIssue[]; retried: boolean }
  /** 用户选了、但今天没有可总结内容的项目（页面提示用，不静默从报告里删掉） */
  skipped?: string[]
  error?: string
  thinking?: string
  tools: string[]
  outChars: number
  startedAt: number
}

/** 项目的名字（报告分节、列表显示用） */
export interface SummaryProjectRef {
  id: string
  name: string
}

/** 一个任务今天的活动：只保留提示词里要用的字段 */
export interface DayTask {
  id: string
  title: string
  status: Task['status']
  /** 今天用户提的要求（已截短） */
  asks: string[]
  /** 今天 Agent 给出的结论（已截短） */
  outcomes: string[]
  /** 今天跑过的节点（名称和状态） */
  steps: { title: string; status: string }[]
  /** 改动的文件（相对路径） */
  files: string[]
  /** 最近一次执行的时间（ISO） */
  at: string
  /** 用户自己提出过问题（只按用户的要求判断，Agent 自查修掉的不算） */
  userBug: boolean
}

/** 一个项目今天的执行记录 */
export interface DayProject {
  projectId: string
  projectName: string
  tasks: DayTask[]
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const midnightOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** YYYY-MM-DD → 本机时区当天 0 点；格式不对或日期不存在（2026-02-30）时返回 null */
function dayStart(day: string): Date | null {
  if (!DAY_RE.test(day)) return null
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  // Date 会把 2026-02-30 进位到 3 月：回读一遍确认确实是这一天
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null
}

/** 从 start 到 end（含 end 那一天，都是本地零点）的每一天 */
function daysBetween(start: Date, end: Date): string[] {
  const days: string[] = []
  for (let d = midnightOf(start); d <= end; d = addDays(d, 1)) days.push(dayKey(d))
  return days
}

/** 一段范围算好的时间窗口：判定只用 start / end，标题和存档用 fromDay / toDay */
export interface SummaryWindow {
  id: SummaryRangeId
  /** 范围内最早的时间（含，毫秒） */
  start: number
  /** 范围的结束时间（不含，毫秒）：today / last7 是现在，其余是结束日期的次日 0 点 */
  end: number
  /** 范围第一天 / 最后一天的本地日期（YYYY-MM-DD，含这一天） */
  fromDay: string
  toDay: string
  /** 范围里的每一天（从早到晚）：只有 last7 用它数天数，custom 可能跨很多年所以不逐天生成 */
  days: string[]
}

/**
 * 把选中的范围换算成时间窗口。
 * custom 的起止写反、格式不对时按「用户想要的那几天」处理：只交换起止，不报错也不返回空范围。
 */
export function rangeWindow(range: SummaryRange = DEFAULT_SUMMARY_RANGE, now = new Date()): SummaryWindow {
  const today = midnightOf(now)
  const todayKey = dayKey(today)
  switch (range.id) {
    case 'yesterday': {
      const start = addDays(today, -1)
      return {
        id: range.id,
        start: start.getTime(),
        end: today.getTime(),
        fromDay: dayKey(start),
        toDay: dayKey(start),
        days: [dayKey(start)],
      }
    }
    case 'last7': {
      const start = addDays(today, -(SUMMARY_LAST7_DAYS - 1))
      return {
        id: range.id,
        start: start.getTime(),
        end: now.getTime(),
        fromDay: dayKey(start),
        toDay: todayKey,
        days: daysBetween(start, today),
      }
    }
    case 'custom': {
      const a = dayStart(range.from) ?? today
      const b = dayStart(range.to) ?? a
      const [start, endDay] = a.getTime() <= b.getTime() ? [a, b] : [b, a]
      return {
        id: range.id,
        start: start.getTime(),
        end: addDays(endDay, 1).getTime(),
        fromDay: dayKey(start),
        toDay: dayKey(endDay),
        // 自选范围可能跨很多年，不逐天生成（只有 last7 / today 需要 days）
        days: [],
      }
    }
    default:
      return {
        id: 'today',
        start: today.getTime(),
        // 正好在 0 点加载时 start 和 now 相等，加 1ms 以免窗口是空的（下一毫秒就恢复正常）
        end: Math.max(now.getTime(), today.getTime() + 1),
        fromDay: todayKey,
        toDay: todayKey,
        days: [todayKey],
      }
  }
}

/** 本机时区的今天 00:00 到现在的窗口（和改造前一样，内部走 rangeWindow） */
export function todayWindow(now = new Date()) {
  const w = rangeWindow(DEFAULT_SUMMARY_RANGE, now)
  return { day: w.toDay, start: w.start, end: w.end }
}

/** 时间戳是不是落在今天（本机时区） */
export function isToday(iso: string, day: string) {
  if (!iso) return false
  const d = new Date(iso)
  return !Number.isNaN(d.getTime()) && dayKey(d) === day
}

/** 时间戳是不是落在范围内（左闭右开，和 rangeWindow 同一口径） */
export function inRange(iso: string, win: SummaryWindow) {
  if (!iso) return false
  const at = Date.parse(iso)
  return Number.isFinite(at) && at >= win.start && at < win.end
}

/**
 * 这个任务在范围内有没有执行过：只看时间字段（任务摘要里没有消息），用来先筛候选任务、页面列出范围内的对话。
 * 页面和服务端共用这一处判定，避免「页面列得出来、服务端却当作没执行」
 */
export function activeInRange(task: Task, win: SummaryWindow) {
  if (inRange(task.updatedAt, win) || inRange(task.turnDoneAt, win) || inRange(task.runStartedAt, win)) return true
  return task.messages.some((m) => inRange(m.at, win))
}

/** 单个自然日的窗口：给老接口 `activeOnDay` / `dayTask` 用，判定口径和改造前一样 */
function dayWindow(day: string): SummaryWindow {
  const start = dayStart(day) ?? midnightOf(new Date())
  const key = dayKey(start)
  return {
    id: 'today',
    start: start.getTime(),
    end: addDays(start, 1).getTime(),
    fromDay: key,
    toDay: key,
    days: [key],
  }
}

/** 这个任务今天有没有执行过（保留的老接口，内部按单日窗口判定） */
export function activeOnDay(task: Task, day: string) {
  return activeInRange(task, dayWindow(day))
}

/** 范围在界面上的名字：今天 / 昨天 / 近 7 天 / 2026-10-01 至 2026-10-05 */
export function rangeLabel(win: SummaryWindow): string {
  if (win.id === 'today') return t('今天')
  if (win.id === 'yesterday') return t('昨天')
  if (win.id === 'last7') return t('近 {n} 天', { n: win.days.length })
  return win.fromDay === win.toDay ? win.fromDay : t('{from} 至 {to}', { from: win.fromDay, to: win.toDay })
}

/**
 * 报告标题：按覆盖的日期推断「今天的报告 / 昨天的报告 / 近 7 天的报告」。
 * 老报告只有 day 时按单日处理；日期对不上时直接写日期区间，不编一个相对说法。
 */
export function reportWindowLabel(fromDay: string, toDay: string, now = new Date()): string {
  const today = midnightOf(now)
  const todayKey = dayKey(today)
  const from = fromDay || toDay
  if (!from) return t('报告')
  if (from === toDay) {
    if (toDay === todayKey) return t('今天的报告')
    if (toDay === dayKey(addDays(today, -1))) return t('昨天的报告')
    return t('{day} 的报告', { day: toDay })
  }
  if (toDay === todayKey && from === dayKey(addDays(today, -(SUMMARY_LAST7_DAYS - 1))))
    return t('近 {n} 天的报告', { n: SUMMARY_LAST7_DAYS })
  return t('{from} 至 {to} 的报告', { from, to: toDay })
}

/** 压成一行、按字数截断：提示词里不放长段落 */
export function clip(text: string, max = SUMMARY_LINE_MAX) {
  return clipText(text, max, { oneLine: true, total: true })
}

/** 从 Agent 的回复里取一段能代表结论的文字：跳过空行和只有符号的行 */
function firstLine(text: string) {
  for (const line of text.split('\n')) {
    const one = clip(line.replace(/^[-*#>\s]+/, ''))
    if (one) return one
  }
  return ''
}

/** 这条消息要不要丢：面板自己推的消息（后台结果、子对话回报、提问卡片）不是 Agent 写的工作内容 */
const isPanelNote = (m: Task['messages'][number]) => !!m.panel || !!m.ask || !!m.peer

/** 一个任务在范围内的活动；范围里没执行过（没有消息和节点）时返回 null */
export function rangeTask(task: Task, win: SummaryWindow): DayTask | null {
  /** 窗口里的全部用户要求：Bug 判定要扫全量，不能只看截给提示词的那几条 */
  const userTexts: string[] = []
  const outcomes: string[] = []
  let at = ''
  const touch = (iso: string) => {
    if (inRange(iso, win) && iso > at) at = iso
  }
  for (const m of task.messages) {
    if (!inRange(m.at, win)) continue
    touch(m.at)
    if (isPanelNote(m)) continue
    if (m.role === 'user' && m.text.trim()) {
      userTexts.push(clip(m.text))
    } else if (m.role === 'agent') {
      const one = firstLine(m.text)
      // 只留最后几条：结论在后面的回复里
      if (one) outcomes.push(one)
    }
  }
  // 提示词里只放开头一条和最近几条：开头常是用户报的问题，最近几条是这次总结的重点。
  // 全部只取末尾会把开头报的 Bug 挤掉，所以 userBug（下面）用完整的 userTexts 判定
  const asks =
    userTexts.length <= SUMMARY_ASKS_MAX ? userTexts : [userTexts[0], ...userTexts.slice(-(SUMMARY_ASKS_MAX - 1))]
  const steps = task.steps
    .filter((s) => inRange(s.startedAt, win) || inRange(s.endedAt, win))
    // 和 outcomes 一样只留最后几个：报告要说的是最近做完的节点
    .slice(-SUMMARY_STEPS_MAX)
    .map((s) => ({ title: clip(s.title, 40), status: s.status }))
  for (const s of task.steps) touch(s.endedAt || s.startedAt)
  for (const turn of task.turns) touch(turn.endedAt || turn.startedAt)
  // 范围里执行过的对话至少留下一条消息或一个节点；只是打开了对话、没执行的不算
  if (!userTexts.length && !outcomes.length && !steps.length) return null
  const files = [...new Set(task.changes.map((c) => c.path))].slice(0, SUMMARY_FILES_MAX)
  // 只看用户提的要求和对话标题：报告里的「用户报告的 Bug」只收用户自己报的问题，
  // Agent 在结论里说的「我顺手修了一个问题」不能算。扫窗口里的全部用户消息（不只是 asks），
  // 否则用户报的问题写在开头、被条数上限截掉后就漏了
  const hint = [task.title, ...userTexts].join(' ').toLowerCase()
  return {
    id: task.id,
    title: clip(task.title, 60),
    status: task.status,
    asks,
    outcomes: outcomes.slice(-SUMMARY_OUTCOMES_MAX),
    steps,
    files,
    at,
    userBug: SUMMARY_BUG_HINTS.some((w) => hint.includes(w)),
  }
}

/** 一个任务今天的活动（保留的老接口，按单日窗口判定） */
export function dayTask(task: Task, day: string): DayTask | null {
  return rangeTask(task, dayWindow(day))
}

/** 报告要分析哪个项目的哪些对话：taskIds 为空表示这个项目范围内全部对话 */
export interface SummaryDayPick extends SummaryProjectRef {
  taskIds?: string[]
}

/**
 * 按项目整理范围内执行过的对话：只保留有活动的项目，项目顺序按传入的顺序（也就是用户加进来的顺序）。
 * 传了 taskIds 时只留这些对话，为空表示该项目全部。
 * 子对话也算它自己项目里的执行记录（它们本来就在同一个项目下）
 */
export function collectRangeProjects(
  tasks: Task[],
  projects: SummaryDayPick[],
  range: SummaryRange = DEFAULT_SUMMARY_RANGE,
  now = new Date(),
): DayProject[] {
  const win = rangeWindow(range, now)
  const byProject = new Map<string, DayTask[]>()
  for (const task of tasks) {
    if (!task.projectId) continue
    const d = rangeTask(task, win)
    if (!d) continue
    const list = byProject.get(task.projectId) ?? []
    list.push(d)
    byProject.set(task.projectId, list)
  }
  return (
    projects
      .filter((p) => byProject.has(p.id))
      .map((p) => {
        const only = p.taskIds?.length ? new Set(p.taskIds) : null
        return {
          projectId: p.id,
          projectName: p.name,
          // 先按最近执行排序再截断：超过上限时留下的是范围内最新的对话，不是最早创建的
          tasks: byProject
            .get(p.id)!
            .filter((t) => !only || only.has(t.id))
            .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
            .slice(0, SUMMARY_TASKS_PER_PROJECT),
        }
      })
      // 选中了对话、但这些对话在范围里都没执行时，这个项目也就没有可写的内容
      .filter((p) => p.tasks.length > 0)
  )
}

/** 按项目整理今天执行过的对话（保留的老接口，内部走「今天」范围） */
export function collectDayProjects(tasks: Task[], projects: SummaryDayPick[], now = new Date()): DayProject[] {
  return collectRangeProjects(tasks, projects, DEFAULT_SUMMARY_RANGE, now)
}

/**
 * 用户选了、但这段范围里没有可总结内容的项目名：页面据此提示，不静默把它们从报告里删掉。
 * 服务端算完 collectRangeProjects 后调用，判断口径就是「有没有进报告」
 */
export function skippedProjects(picks: SummaryProjectRef[], projects: DayProject[]) {
  const analyzed = new Set(projects.map((p) => p.projectId))
  return picks.filter((p) => !analyzed.has(p.id)).map((p) => p.name)
}

/** 报告里交给 CLI 的「这段时间的执行记录」正文 */
export function summaryContext(projects: DayProject[]) {
  return projects
    .map((p) =>
      [
        `## ${p.projectName}`,
        ...p.tasks.map((task) => {
          const lines = [
            `- 对话「${task.title || '未命名'}」（${task.status}）`,
            // 只是关键词线索，不是结论：用户原文里说「点保存没反应」这种没命中关键词的也是问题，交给 CLI 判
            `  关键词命中问题词：${task.userBug ? '是' : '否'}`,
          ]
          if (task.asks.length) lines.push(`  用户的要求：${task.asks.join('；')}`)
          if (task.outcomes.length) lines.push(`  结论：${task.outcomes.join('；')}`)
          if (task.steps.length) lines.push(`  节点：${task.steps.map((s) => `${s.title}（${s.status}）`).join('、')}`)
          if (task.files.length) lines.push(`  改动的文件：${task.files.join('、')}`)
          return lines.join('\n')
        }),
      ].join('\n'),
    )
    .join('\n\n')
}

/**
 * 交给 CLI 的提示词：严格按固定模板写三节报告（需求进度 / 用户报告的 Bug / 今日小结）。
 * 格式写死在这里，生成后还会用 checkSummaryFormat 再校一遍（见 server/summary.ts）。
 * 正文是中文，回复语言跟随面板设置（见 prompt-lang.ts）
 */
export function summaryPrompt(input: { day: string; projects: DayProject[]; range?: SummaryWindow }) {
  const win = input.range ?? dayWindow(input.day)
  // 一级标题：单日就是「# 2026-10-23 工作总结」，多天用「# 2026-10-17 - 2026-10-23 工作总结」
  const title = win.fromDay === win.toDay ? win.fromDay : `${win.fromDay} - ${win.toDay}`
  // 第一行说清范围：今天是哪一天、这次总结覆盖哪几天
  const scope =
    win.id === 'today'
      ? `今天（${win.fromDay}）`
      : win.id === 'yesterday'
        ? `昨天（${win.fromDay}）`
        : win.id === 'last7'
          ? `近 ${win.days.length} 天（${win.fromDay} 至 ${win.toDay}）`
          : win.fromDay === win.toDay
            ? `${win.fromDay}`
            : `${win.fromDay} 至 ${win.toDay}`
  return [
    `你在帮用户整理${scope}的工作总结报告。`,
    promptLangRules(),
    '',
    '输出格式：必须严格照下面这个结构写，字段、顺序、编号一律不能变，不要自创小节：',
    '',
    `# ${title} 工作总结`,
    '',
    '## 一、需求进度',
    '',
    '### 1.1 <项目名>',
    '1. **<需求标题>** ｜ 已完成（5/5）',
    '   实现：<一两句原理，说清怎么做到的，不贴代码>',
    '2. **<需求标题>** ｜ 进行中（3/5）',
    '   实现：<一两句原理>',
    '',
    '## 二、用户报告的 Bug',
    '',
    '### 2.1 <项目名>',
    '1. **<Bug 标题>**',
    '   原因：<根因，一句话说清是什么导致的>',
    '   修复：<怎么修的，一句话>',
    '',
    '## 三、今日小结',
    '<一句话：这段时间整体做完了什么、还剩什么>',
    '',
    '硬性规则：',
    `- 一级标题固定写成 \`# ${title} 工作总结\`。`,
    '- 二级标题只允许这三个，一个不能少、顺序不能变：`## 一、需求进度`、`## 二、用户报告的 Bug`、`## 三、今日小结`。',
    '- 三级标题是项目，写 `### 1.1 <项目名>` / `### 2.1 <项目名>`（节号.项目序号，项目序号从 1 递增）；每个节里的项目都要写三级标题。',
    '- 条目写成 `1. **<标题>** ｜ <状态>`，下一行缩进两个空格写 `实现：` / `原因：` / `修复：`。',
    '- 「需求进度」的状态只能是 `已完成`、`进行中（n/m）`、`暂停`、`未开始` 这四种。',
    '- 「用户报告的 Bug」只写用户在「用户的要求」里自己提出来的问题；`关键词命中问题词：否` 只说明没命中关键词，不是没报问题——用户原文描述了异常现象（没反应、不对、坏了、不生效、卡住、闪退等）也要写。用户只是在讨论要不要处理某个问题、没有报告故障的不算报 Bug。Agent 自己写代码、自测、评审时发现并修掉的问题一律不写，这是硬约束。',
    '- 每条最多两行（标题行 + 一行 `实现` / `原因` / `修复`），单句不超过 60 字；不贴代码、不复述执行过程、不列工具调用。',
    '- 全文不用第一人称（不写「我今天」「我修改了」），用「已完成 …」「修复 …」这种陈述。',
    '- 某一节没有内容时，在那一节下面写一行「暂无」，不要省略整节。',
    '- 只写下面记录里有的项目，按记录里的顺序；不要编造记录里没有的事。',
    '- 直接输出报告正文：第一行就是一级标题，不要开场白、不要总结段落、不要用代码块包起来。',
    '',
    '这段时间的执行记录：',
    summaryContext(input.projects) || '（这段时间没有执行记录）',
  ].join('\n')
}

/**
 * 生成后的格式自检：只查结构（标题、三节、编号、条目形状），不评价内容。
 * 返回的问题码可以直接交给页面本地化（见 SUMMARY_FORMAT_ISSUES）
 */
export function checkSummaryFormat(md: string): { ok: boolean; issues: SummaryFormatIssue[] } {
  const issues = new Set<SummaryFormatIssue>()
  const lines = md.split('\n').map((l) => l.trimEnd())
  const body = lines.filter((l) => l.trim())
  // 一级标题：报告第一行就是它，日期可以是单日或多日区间
  if (!new RegExp(`^# ${DAY_KEY_PATTERN}(?: - ${DAY_KEY_PATTERN})? 工作总结$`).test((body[0] ?? '').trim()))
    issues.add('title')
  const h2 = body.filter((l) => l.startsWith('## ')).map((l) => l.trim())
  const wanted = SUMMARY_SECTIONS.map((s) => s as string)
  if (h2.length !== wanted.length || h2.some((l, i) => l !== wanted[i])) issues.add('sections')
  // 三级标题：节号.项目序号，序号从 1 递增
  const h3 = body.filter((l) => l.startsWith('### '))
  if (h3.some((l) => !/^### \d+\.\d+ \S/.test(l))) issues.add('project')
  // 条目：`n. **标题**` 后面可以跟 `｜ 状态`
  for (const line of body) {
    if (!/^\d+\. /.test(line)) continue
    if (!/^\d+\. \*\*.+\*\*( ｜ \S.*)?$/.test(line)) issues.add('item')
  }
  // 节内没有内容时必须是「暂无」：前两节靠条目填内容，第三节是一句话小结
  for (let i = 0; i < wanted.length; i++) {
    const start = body.findIndex((l) => l.trim() === wanted[i])
    if (start < 0) continue
    const rest = body.slice(start + 1)
    const nextH2 = rest.findIndex((l) => l.startsWith('## '))
    const section = nextH2 < 0 ? rest : rest.slice(0, nextH2)
    const last = i === wanted.length - 1
    const filled = section.some((l) => l.trim() === '暂无' || (last ? !l.startsWith('#') : /^\d+\. /.test(l)))
    if (!filled) issues.add('empty')
  }
  return { ok: issues.size === 0, issues: [...issues] }
}

/**
 * 格式自检不合格时再跑一次 CLI 的追加提示：带上具体问题，要求整份重写。
 * 与 summaryPrompt 共用同一份问题文案，不在服务端另写一套
 */
export function summaryRetryHint(issues: SummaryFormatIssue[]) {
  return [
    '',
    '上一次输出没有按规定的格式写，问题：',
    ...issues.map((i) => `- ${SUMMARY_FORMAT_ISSUES[i]}`),
    '请严格按上面的结构把整份报告重写一遍，只输出报告正文。',
  ].join('\n')
}

/**
 * 从 CLI 的回答里取出报告正文：去开头的说明文字和包着它的代码块（有些 CLI 习惯整段放进 ```markdown）。
 * 报告本身可以有一级标题，不做改动
 */
export function extractSummary(text: string): string {
  const raw = text.trim()
  if (!raw) return ''
  // 提示词要求直接给正文；真被 ``` 包起来时（有些 CLI 的习惯）就取这一块，不管里面有没有标题。
  // 但代码块前面已经有 Markdown 标题时，说明报告正文就在前面，块里是附带的命令或报错，用原文
  const fenced = /```(?:markdown|md)?\s*\n([\s\S]*?)\n?```/i.exec(raw)
  const before = fenced ? raw.slice(0, fenced.index) : ''
  if (fenced && fenced[1].trim() && !/^#{1,6} /m.test(before)) return fenced[1].trim() + '\n'
  return raw + '\n'
}

/** 报告在列表里显示的名字：第一行标题，没有就用日期 */
export function reportTitle(md: string, day: string) {
  const line = md.split('\n').find((l) => l.trim())
  const title = clip((line ?? '').replace(/^#+\s*/, ''), 60)
  return title || day
}

// ---- 两份报告的对比 ----

/** 报告里的一个条目：标题 +（需求进度才有的）状态 + 缩进那行说明 */
export interface SummaryItem {
  /** 报告里写的序号（1、2…），只用于展示 */
  no: number
  title: string
  /** 状态原文（「已完成（5/5）」）；「用户报告的 Bug」节没有这一项，读成空串 */
  status: string
  /** 缩进一行写的「实现：/原因：/修复：」，可能为空 */
  detail: string
}

/** 一个项目小节（三级标题 `### 1.1 项目名`）下的全部条目 */
export interface SummarySection {
  /** 三级标题里的编号（1.1 / 2.1） */
  no: string
  name: string
  items: SummaryItem[]
}

export interface ParsedSummaryReport {
  /** 一级标题（去掉 `# `） */
  title: string
  /** 需求进度 / 用户报告的 Bug，按 `SUMMARY_SECTIONS` 的顺序 */
  needs: SummarySection[]
  bugs: SummarySection[]
  /** 今日小结的正文 */
  wrapUp: string
  /** 固定的三节都找到了才算解析成功；否则页面退回纯文本 diff，不报错 */
  ok: boolean
}

/** 三级标题：`### 1.1 项目名`（节号.项目序号，项目名允许有空格） */
const SUMMARY_PROJECT_RE = /^###\s+(\d+\.\d+)\s+(\S.*?)\s*$/
/** 条目：`1. **标题** ｜ 状态`（竖线也认半角，状态可空 —— 用户手改报告时常见） */
const SUMMARY_ITEM_RE = /^(\d+)\.\s+\*\*(.+?)\*\*(?:\s*[｜|]\s*(.*?))?\s*$/
/** 条目下面缩进的那一行：`   实现：…` / `   原因：…` / `   修复：…` */
const SUMMARY_DETAIL_RE = /^\s+(实现|原因|修复)[：:]\s*(.*)$/

/**
 * 把一份报告解析成结构（按 `SUMMARY_SECTIONS` 定序）。
 * 作者手改过、格式不合模板时不抛错也不编内容：`ok` 为 false，调用方退回纯文本 diff
 */
export function parseSummaryReport(md: string): ParsedSummaryReport {
  const lines = md.split('\n')
  const titleLine = lines.find((l) => l.trim().startsWith('# '))?.trim() ?? ''
  const title = titleLine.replace(/^#\s*/, '').trim()
  // 只收固定三节：用户自己加的其它小节（例如「备注」）不参与对比
  const bodies = new Map<string, string[]>()
  let cur: string | null = null
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('## ')) {
      cur = (SUMMARY_SECTIONS as readonly string[]).includes(t) && !bodies.has(t) ? t : null
      if (cur) bodies.set(cur, [])
      continue
    }
    // 一级标题之后的内容（报告说明之类）不属于任何一节
    if (t.startsWith('# ')) {
      cur = null
      continue
    }
    if (cur) bodies.get(cur)!.push(line)
  }
  const parseSection = (body: string[], withStatus: boolean): SummarySection[] => {
    const out: SummarySection[] = []
    for (const line of body) {
      const t = line.trim()
      const project = SUMMARY_PROJECT_RE.exec(t)
      if (project) {
        out.push({ no: project[1], name: project[2], items: [] })
        continue
      }
      const item = SUMMARY_ITEM_RE.exec(t)
      if (item) {
        const target = out.at(-1)
        // 条目写在项目标题之前：模板里不会出现，解析不了就不收，不凭空归到一个项目下
        if (!target) continue
        target.items.push({
          no: Number(item[1]),
          title: item[2].trim(),
          status: withStatus ? (item[3] ?? '').trim() : '',
          detail: '',
        })
        continue
      }
      const detail = SUMMARY_DETAIL_RE.exec(line)
      if (!detail) continue
      const last = out.at(-1)?.items.at(-1)
      if (last) last.detail = last.detail ? `${last.detail}\n${t}` : t
    }
    return out
  }
  const needsBody = bodies.get(SUMMARY_SECTIONS[0]) ?? []
  const bugsBody = bodies.get(SUMMARY_SECTIONS[1]) ?? []
  const wrapBody = bodies.get(SUMMARY_SECTIONS[2]) ?? []
  const needs = parseSection(needsBody, true)
  const bugs = parseSection(bugsBody, false)
  /**
   * 报告里有「看起来是条目」的行（`n. …`）却没全部解析出来，说明写法偏离模板（标题里嵌了 `**`、
   * 编号不在行首这类）。这时不能把没解析出来的条目当成「消失」，整份按解析失败处理，页面退回逐行对比
   */
  const itemLines = (body: string[]) => body.filter((l) => /^\s*\d+\.\s/.test(l)).length
  const parsedItems = (sections: SummarySection[]) => sections.reduce((n, s) => n + s.items.length, 0)
  return {
    title,
    needs,
    bugs,
    // 今日小结是一句话（可能被用户改成长一点的段落）：去掉标题和空行后原样保留
    wrapUp: wrapBody
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n'),
    ok:
      bodies.size === SUMMARY_SECTIONS.length &&
      parsedItems(needs) === itemLines(needsBody) &&
      parsedItems(bugs) === itemLines(bugsBody),
  }
}

/** 一份变化：新增 / 消失 / 状态变化 */
export interface SummaryChange {
  kind: 'added' | 'removed' | 'changed'
  project: string
  title: string
  /** 旧状态 / 新状态：added 只有 to，removed 只有 from，changed 两个都有 */
  from: string
  to: string
  /** 报告里那行说明（展示用）：新增和变化取新报告的，消失取旧报告的 */
  detail: string
}

export interface SummaryCompare {
  /** 两份正文完全一样 */
  same: boolean
  /** 两份都解析成功：needs / bugs 才有内容，解析不了时用 lines */
  parsed: boolean
  needs: SummaryChange[]
  bugs: SummaryChange[]
  /** 今日小结并排显示 */
  wrapUp: { before: string; after: string; changed: boolean }
  /** 结构化对比不了（或格式对但没有条目级变化）时的行级差异 */
  lines: { kind: 'same' | 'add' | 'del'; text: string }[]
}

/** 把各项目小节展开成「项目 + 条目」，对比按（项目名，条目标题）配对 */
function flattenSections(sections: SummarySection[]) {
  const out: { project: string; item: SummaryItem }[] = []
  for (const s of sections) for (const item of s.items) out.push({ project: s.name, item })
  return out
}

const entryKey = (project: string, title: string) => `${project}\u0000${title}`

/**
 * 条目级变化：按（项目名，标题）配对。
 * withStatus 为真时比较状态（需求进度），Bug 节没有状态，配上就是没变化
 */
function entryChanges(before: ParsedSummaryReport, after: ParsedSummaryReport, withStatus: boolean) {
  const pick = (r: ParsedSummaryReport) => flattenSections(withStatus ? r.needs : r.bugs)
  const oldMap = new Map(pick(before).map((x) => [entryKey(x.project, x.item.title), x]))
  const newMap = new Map(pick(after).map((x) => [entryKey(x.project, x.item.title), x]))
  const out: SummaryChange[] = []
  for (const [key, x] of newMap) {
    const old = oldMap.get(key)
    if (!old) {
      out.push({
        kind: 'added',
        project: x.project,
        title: x.item.title,
        from: '',
        to: x.item.status,
        detail: x.item.detail,
      })
      continue
    }
    if (withStatus && old.item.status !== x.item.status)
      out.push({
        kind: 'changed',
        project: x.project,
        title: x.item.title,
        from: old.item.status,
        to: x.item.status,
        detail: x.item.detail,
      })
  }
  for (const [key, x] of oldMap) {
    if (newMap.has(key)) continue
    out.push({
      kind: 'removed',
      project: x.project,
      title: x.item.title,
      from: x.item.status,
      to: '',
      detail: x.item.detail,
    })
  }
  return out
}

/**
 * 对比两份报告（先旧的、后新的）：需求进度给出新增 / 消失 / 状态变化，Bug 给出新增 / 已修复（消失），
 * 今日小结并排；两份都解析不了格式时退回纯文本 diff，不报错也不编内容
 */
export function compareSummaryReports(before: string, after: string): SummaryCompare {
  const a = parseSummaryReport(before)
  const b = parseSummaryReport(after)
  const parsed = a.ok && b.ok
  const same = before === after
  return {
    same,
    parsed,
    needs: parsed ? entryChanges(a, b, true) : [],
    bugs: parsed ? entryChanges(a, b, false) : [],
    wrapUp: { before: a.wrapUp, after: b.wrapUp, changed: a.wrapUp !== b.wrapUp },
    lines: parsed || same ? [] : lineDiff(before, after),
  }
}

/** 对比里有没有条目或小结级别的变化：页面据此说「没有差异」，和正文是否逐字相同分开 */
export function compareHasChanges(c: SummaryCompare) {
  return c.needs.length > 0 || c.bugs.length > 0 || c.wrapUp.changed
}
