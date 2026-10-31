/**
 * 工作总结：按天或按周，把一段时间里的工作整理成一份报告。分两步：
 *
 * 1. 提炼：选来源（「报告」= 这段时间已经生成过的报告，「对话」= 面板里加过的项目在这段时间执行过的对话），
 *    交给「每日工作总结」角色（shared/builtin/agents.ts 的 worklog）用本机 CLI 提炼成一条条分项（需求 / Bug）；
 * 2. 确认：用户在页面上逐项点「采纳」，点确认后只用采纳的分项拼出报告（`renderReport`，固定格式，不再跑 CLI）。
 *
 * 时间口径只有一处（`summaryPeriod`）：按天是那一天，按周是周一到周日（和 Token 用量的「按周」同一个周）。
 * 范围外的内容一律不交给 CLI：对话只取窗口内的消息和节点，报告只取覆盖范围落在窗口内的。
 *
 * 这里只有纯逻辑：时间窗口、材料整理、提示词、解析 CLI 的分项、拼报告。
 * 跑 CLI 和存报告在 server/summary.ts；页面在 web/src/pages/SummaryPage.tsx
 */
import { z } from 'zod'
import { t } from './i18n.ts'
import type { Agent, Task } from './schema.ts'
import { BUILTIN_AGENTS } from './builtin/agents.ts'
import { dayKey, isoWeek, periodLabel, usagePeriod } from './usage.ts'
import { clip as clipText } from './text.ts'
import { summariesOf } from './summary-card.ts'

/**
 * 数据目录里最多留多少份报告：左侧树要列出全部报告，这里只是防止数据文件无限长大的保险，
 * 每天几份也够存好几年。超出时删最早的
 */
export const SUMMARY_KEEP = 2000
/** 每个项目最多交给 CLI 几条对话：按最近执行排序后截断 */
export const SUMMARY_TASKS_PER_PROJECT = 16
/** 来源是「报告」时最多带几份、每份正文最多多少字：一周七天、每天几份也放得下 */
export const SUMMARY_REPORTS_MAX = 30
export const SUMMARY_REPORT_CHARS = 4000
/** 每条摘录最多多少字：提示词里不放整段对话 */
export const SUMMARY_LINE_MAX = 160
/** 每个任务最多取几条用户要求 / 几条结论 / 几个节点 / 几个改动文件 */
export const SUMMARY_ASKS_MAX = 4
export const SUMMARY_OUTCOMES_MAX = 3
export const SUMMARY_STEPS_MAX = 8
export const SUMMARY_FILES_MAX = 8
/**
 * 每个任务最多带几张总结卡、每个字段最多多少字：原因和修法就在卡片里，
 * 只给 CLI 一行结论时它只能写出「修复了 xx 问题」这种没有因果的条目
 */
export const SUMMARY_CARDS_MAX = 6
export const SUMMARY_CARD_FIELD_MAX = 300
/** 回复里没有总结卡时（老对话、闲聊轮），最后一条回复多带一段正文，原因和修法常写在中间 */
export const SUMMARY_REPLY_MAX = 600
/**
 * 不交给 CLI 的卡片字段：验证（测试过没过）、要你处理、改动的文件清单。
 * 报告只写做了什么、为什么坏、怎么修的，这几样对看报告的人没用，带上 CLI 就会照抄
 */
const CARD_FIELDS_SKIP = new Set(['verified', 'needs', 'changes'])
/** 一次最多提炼多少条分项：再多用户也挑不过来 */
export const SUMMARY_ITEMS_MAX = 60
/** 面板里最多加几个项目 */
export const SUMMARY_PROJECTS_MAX = 50

/** 生成报告用的内置角色：页面、服务端、演示版都按它找角色 */
export const SUMMARY_ROLE_KEY = 'worklog'

/**
 * 生成报告用的角色：用户数据里的「每日工作总结」（启动时按内置定义同步，用户也能改它的 CLI / 模型）；
 * 被删掉了（或演示版里没装）就用内置定义，照常能生成。`own` 标出是不是本机那份：页面据此决定能不能点开角色
 */
export function summaryRole(agents: Agent[]): Agent & { own: boolean } {
  const mine = agents.find((a) => a.origin === `builtin:${SUMMARY_ROLE_KEY}`)
  if (mine) return { ...mine, own: true }
  const def = BUILTIN_AGENTS.find((b) => b.key === SUMMARY_ROLE_KEY)!
  // 只用到角色设定、参数和 CLI / 模型这几项：内置定义里都有，其余字段不会被读到
  return { ...def.agent, id: SUMMARY_ROLE_KEY, own: false } as Agent & { own: boolean }
}

/**
 * 命中这些词就认为这条对话可能在修 Bug：提示词里给 CLI 一个线索。
 * 只收明确指向故障的词，「错误」「失败」在日常需求里太常见；只是线索，最终由 CLI 按内容判断
 */
export const SUMMARY_BUG_HINTS = ['bug', '修复', '报错', '崩溃', 'fix', '没反应', '不生效', '卡住', '闪退']

/** 粒度：按天 / 按周 */
export const SUMMARY_GRAINS = ['day', 'week'] as const
export type SummaryGrain = (typeof SUMMARY_GRAINS)[number]

/** 来源：从已经生成的报告提炼 / 从项目对话提炼 */
export const SUMMARY_SOURCES = ['reports', 'tasks'] as const
export type SummarySource = (typeof SUMMARY_SOURCES)[number]

/** 分项的种类：需求只写做了什么，Bug 写原因和修复 */
export const SUMMARY_KINDS = ['need', 'bug'] as const
export type SummaryKind = (typeof SUMMARY_KINDS)[number]

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** 一条分项；字数上限比提示词里的宽一些：CLI 稍微写长了也收下，不因为几个字整份作废 */
export const SummaryEntry = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(SUMMARY_KINDS),
  /** 项目名（报告里按它分组）；记录里分不出项目时为空，归到「其他」 */
  project: z.string().trim().max(80).default(''),
  title: z.string().trim().min(1).max(120),
  /** 需求：做了什么、实现了什么 */
  content: z.string().trim().max(600).default(''),
  /** Bug：原因 / 修复方案 */
  cause: z.string().trim().max(600).default(''),
  fix: z.string().trim().max(600).default(''),
})
export type SummaryEntry = z.infer<typeof SummaryEntry>

/** 开始提炼：来源、粒度、范围里的任意一天（按天就是那天，按周取它所在的那一周）、对话来源要的项目 */
export const SummaryExtractRequest = z.object({
  source: z.enum(SUMMARY_SOURCES),
  grain: z.enum(SUMMARY_GRAINS),
  day: DAY,
  projectIds: z.array(z.string().min(1)).max(SUMMARY_PROJECTS_MAX).default([]),
})
export type SummaryExtractRequest = z.infer<typeof SummaryExtractRequest>

/** 确认生成：只带用户采纳的分项，服务端按固定格式拼成报告 */
export const SummaryCreateRequest = z.object({
  source: z.enum(SUMMARY_SOURCES),
  grain: z.enum(SUMMARY_GRAINS),
  from: DAY,
  to: DAY,
  projectNames: z.array(z.string()).max(SUMMARY_PROJECTS_MAX).default([]),
  projectIds: z.array(z.string()).max(SUMMARY_PROJECTS_MAX).default([]),
  items: z.array(SummaryEntry).min(1).max(SUMMARY_ITEMS_MAX),
  cli: z.string().default(''),
  model: z.string().default(''),
  effort: z.string().default(''),
  taskCount: z.number().int().min(0).default(0),
  reportCount: z.number().int().min(0).default(0),
  durationMs: z.number().int().min(0).default(0),
})
export type SummaryCreateRequest = z.infer<typeof SummaryCreateRequest>

/** 面板里加过的项目：下次打开还在，不用每次重选（存在数据目录 config/summary.json） */
export const SummaryConfig = z.object({
  projectIds: z.array(z.string().min(1)).max(SUMMARY_PROJECTS_MAX).default([]),
})
export type SummaryConfig = z.infer<typeof SummaryConfig>

/** 存下来的一份报告：正文可以再编辑（PUT /summary/:id） */
export const SummaryReport = z.object({
  /** 覆盖范围内最后一天的本地日期（2026-10-23）；老报告只有这一个日期 */
  day: z.string(),
  /** 覆盖范围的第一天 / 最后一天（含）；老报告没有这两个字段，按 day 单日处理 */
  from: z.string().default(''),
  to: z.string().default(''),
  /** 按天 / 按周；改版前的报告没有这个字段，按覆盖的天数推断（见 reportGrain） */
  grain: z.enum(SUMMARY_GRAINS).optional(),
  /** 从哪儿提炼的；改版前的报告都是从对话生成的 */
  source: z.enum(SUMMARY_SOURCES).default('tasks'),
  projectIds: z.array(z.string()).default([]),
  projectNames: z.array(z.string()).default([]),
  /** Markdown 正文；用户编辑后的内容也存这里 */
  md: z.string().default(''),
  /** 生成时采纳的分项：左侧树显示「需求 n · Bug m」，改版前的报告没有 */
  items: z.array(SummaryEntry).default([]),
  cli: z.string().default(''),
  model: z.string().default(''),
  effort: z.string().default(''),
  /** 提炼时用到了几条对话 / 几份报告 */
  taskCount: z.number().int().default(0),
  reportCount: z.number().int().default(0),
  /** 提炼用了多久（毫秒）：老报告没有这个字段，按 0 处理（页面不显示耗时） */
  durationMs: z.number().int().min(0).default(0),
})
export type SummaryReport = z.infer<typeof SummaryReport>

/** 存进数据目录的记录：在报告字段上补 id 和时间（和别的集合一样） */
export const SummaryRecord = SummaryReport.extend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SummaryRecord = z.infer<typeof SummaryRecord>

/** 一次提炼：跑完给出分项，等用户挑完再确认生成 */
export interface SummaryJob {
  id: string
  /** stopped：用户主动停了（不是错误），页面上按普通提示显示 */
  status: 'running' | 'done' | 'failed' | 'stopped'
  source: SummarySource
  grain: SummaryGrain
  /** 这次提炼的范围（YYYY-MM-DD，含首尾）：开始时就定下来，生成过程中页面换了范围也不串 */
  from: string
  to: string
  projectIds: string[]
  /** 提炼出的分项；空数组 + done 表示这段时间没有可写的内容 */
  items: SummaryEntry[]
  /** 用了几条对话 / 几份报告：0 时 CLI 根本没跑（没有材料） */
  taskCount: number
  reportCount: number
  /** 加了、但这段时间没有可总结对话的项目名（页面提示用，不静默略过） */
  skipped?: string[]
  /** 实际用的 CLI / 模型 / 思考强度：确认生成时写进报告 */
  cli: string
  model: string
  effort: string
  error?: string
  thinking?: string
  tools: string[]
  outChars: number
  startedAt: number
  /** 提炼花了多久（跑完才有） */
  durationMs?: number
}

/** 项目的名字（报告分节、列表显示用） */
export interface SummaryProjectRef {
  id: string
  name: string
}

// ---- 时间窗口 ----

/** 一段范围算好的时间窗口：判定只用 start / end，标题和存档用 fromDay / toDay */
export interface SummaryWindow {
  grain: SummaryGrain
  /** 范围内最早的时间（含，毫秒） */
  start: number
  /** 范围的结束时间（不含，毫秒）：最后一天的次日 0 点 */
  end: number
  /** 范围第一天 / 最后一天的本地日期（YYYY-MM-DD，含这一天） */
  fromDay: string
  toDay: string
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD → 本机时区当天 0 点；格式不对或日期不存在（2026-02-30）时返回 null */
export function parseDay(day: string): Date | null {
  if (!DAY_RE.test(day)) return null
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  // Date 会把 2026-02-30 进位到 3 月：回读一遍确认确实是这一天
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null
}

/** 某一天落在哪个窗口里：按天就是那天，按周是那天所在的周一到周日。日期不合法时按今天 */
export function summaryPeriod(grain: SummaryGrain, day: string | Date, now = new Date()): SummaryWindow {
  const d = typeof day === 'string' ? (parseDay(day) ?? now) : day
  const p = usagePeriod(grain, d)
  const end = new Date(p.end.getFullYear(), p.end.getMonth(), p.end.getDate() + 1)
  return { grain, start: p.start.getTime(), end: end.getTime(), fromDay: dayKey(p.start), toDay: dayKey(p.end) }
}

/** 时间戳是不是落在窗口内（左闭右开） */
export function inRange(iso: string, win: Pick<SummaryWindow, 'start' | 'end'>) {
  if (!iso) return false
  const at = Date.parse(iso)
  return Number.isFinite(at) && at >= win.start && at < win.end
}

/**
 * 这个任务在窗口内有没有执行过：只看时间字段（任务摘要里没有完整消息），用来先筛候选任务。
 * 页面和服务端共用这一处判定，避免「页面数得出来、服务端却当作没执行」
 */
export function activeInRange(task: Task, win: Pick<SummaryWindow, 'start' | 'end'>) {
  if (inRange(task.updatedAt, win) || inRange(task.turnDoneAt, win) || inRange(task.runStartedAt, win)) return true
  return task.messages.some((m) => inRange(m.at, win))
}

/** 窗口在界面上的名字：10月29日 / 第 44 周 · 10月26日 - 11月1日（和 Token 用量的标签同一套） */
export function windowLabel(grain: SummaryGrain, fromDay: string) {
  return periodLabel(usagePeriod(grain, parseDay(fromDay) ?? new Date()))
}

/** 报告的粒度：存了就用存的；改版前的报告按覆盖天数推断，单日是按天，其余按周（树里归到它开始的那一周） */
export function reportGrain(r: Pick<SummaryReport, 'grain' | 'from' | 'to' | 'day'>): SummaryGrain {
  if (r.grain) return r.grain
  const from = r.from || r.day
  const to = r.to || r.day
  return from === to ? 'day' : 'week'
}

/** 报告覆盖的首尾日期：老报告只有 day */
export const reportSpan = (r: Pick<SummaryReport, 'from' | 'to' | 'day'>) => ({
  from: r.from || r.day,
  to: r.to || r.day,
})

// ---- 左侧报告树 ----

/** 树里的一个日期节点：按天的报告挂在那一天，按周的报告挂在那一周 */
export interface ReportGroup {
  /** 节点的稳定标识：day:2026-10-29 / week:2026-10-26 */
  key: string
  grain: SummaryGrain
  /** 窗口第一天（按天就是那天） */
  from: string
  reports: SummaryRecord[]
}

/**
 * 把报告按日期分组：同一天（同一周）的多份报告在一个节点下，节点按日期从新到旧，
 * 同一日期里周报告排在当天的前面，节点内按生成时间从新到旧
 */
export function groupReports(reports: SummaryRecord[]): ReportGroup[] {
  const groups = new Map<string, ReportGroup>()
  for (const r of reports) {
    const grain = reportGrain(r)
    const span = reportSpan(r)
    // 周报告按它所在那一周的周一归组：老报告的「近 7 天」不一定从周一开始，按开始那天所在的周
    const from = grain === 'week' ? summaryPeriod('week', span.from).fromDay : span.from
    const key = `${grain}:${from}`
    const g = groups.get(key) ?? { key, grain, from, reports: [] }
    g.reports.push(r)
    groups.set(key, g)
  }
  const list = [...groups.values()]
  for (const g of list) g.reports.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  // 按「这个节点最后一天」倒序：周节点的最后一天是周日，和当周的日节点放在一起时排在前面
  const lastDay = (g: ReportGroup) => (g.grain === 'week' ? summaryPeriod('week', g.from).toDay : g.from)
  return list.sort((a, b) => {
    const x = lastDay(a)
    const y = lastDay(b)
    if (x !== y) return x < y ? 1 : -1
    return a.grain === b.grain ? 0 : a.grain === 'week' ? -1 : 1
  })
}

/** 一份报告里需求 / Bug 各几条：生成时存了分项就数分项，老报告没有分项时返回 null */
export function reportCounts(r: Pick<SummaryReport, 'items'>) {
  if (!r.items.length) return null
  return {
    need: r.items.filter((x) => x.kind === 'need').length,
    bug: r.items.filter((x) => x.kind === 'bug').length,
  }
}

// ---- 材料：对话 ----

/** 压成一行、按字数截断：提示词里不放长段落 */
export function clip(text: string, max = SUMMARY_LINE_MAX) {
  return clipText(text, max, { oneLine: true, total: true })
}

/** 一个任务在窗口里的活动：只保留提示词里要用的字段 */
export interface DayTask {
  id: string
  title: string
  status: Task['status']
  /** 窗口里用户提的要求（已截短） */
  asks: string[]
  /** 窗口里 Agent 给出的结论（已截短） */
  outcomes: string[]
  /** 窗口里 Agent 写的总结卡（类型、结论和字段，去掉了验证等不进报告的字段），按时间顺序取最近几张 */
  cards: { kind: string; title: string; fields: { label: string; text: string }[] }[]
  /** 窗口里最后一条回复没有总结卡时，它的一段正文（已截短）；有卡片时为空 */
  reply: string
  /** 窗口里跑过的节点（名称和状态） */
  steps: { title: string; status: string }[]
  /** 改动的文件（相对路径） */
  files: string[]
  /** 窗口内最近一次执行的时间（ISO） */
  at: string
  /** 用户自己提出过问题（只按用户的要求判断，Agent 自查修掉的不算） */
  userBug: boolean
}

/** 一个项目在窗口里的执行记录 */
export interface DayProject {
  projectId: string
  projectName: string
  tasks: DayTask[]
}

/** 从 Agent 的回复里取一段能代表结论的文字：跳过空行和只有符号的行 */
function firstLine(text: string) {
  for (const line of text.split('\n')) {
    const one = clip(line.replace(/^[-*#>\s]+/, ''))
    if (one) return one
  }
  return ''
}

/** 回复正文的一段：去掉代码块（日志、补丁对报告没用）后压成一行截断 */
function replyExcerpt(text: string) {
  return clip(text.replace(/```[\s\S]*?(```|$)/g, ' '), SUMMARY_REPLY_MAX)
}

/** 这条消息要不要丢：面板自己推的消息（后台结果、子对话回报、提问卡片）不是 Agent 写的工作内容 */
const isPanelNote = (m: Task['messages'][number]) => !!m.panel || !!m.ask || !!m.peer

/** 一个任务在窗口里的活动；窗口里没执行过（没有消息和节点）时返回 null */
export function rangeTask(task: Task, win: Pick<SummaryWindow, 'start' | 'end'>): DayTask | null {
  /** 窗口里的全部用户要求：Bug 判定要扫全量，不能只看截给提示词的那几条 */
  const userTexts: string[] = []
  const outcomes: string[] = []
  const cards: DayTask['cards'] = []
  let reply = ''
  let at = ''
  const touch = (iso: string) => {
    if (inRange(iso, win) && iso > at) at = iso
  }
  for (const m of task.messages) {
    // 范围外的消息一律不收：跨天的对话只写这一段做过的事
    if (!inRange(m.at, win)) continue
    touch(m.at)
    if (isPanelNote(m)) continue
    if (m.role === 'user' && m.text.trim()) userTexts.push(clip(m.text))
    else if (m.role === 'agent') {
      const one = firstLine(m.text)
      if (one) outcomes.push(one)
      // 卡片和子对话的详细总结都收：子对话不写卡片，按段落取出同样的字段
      const found = summariesOf(m.text)
      for (const c of found)
        cards.push({
          kind: c.label,
          title: clip(c.title, 120),
          fields: c.fields
            .filter((x) => !x.key || !CARD_FIELDS_SKIP.has(x.key))
            .map((x) => ({ label: x.label, text: clip(x.text, SUMMARY_CARD_FIELD_MAX) }))
            .filter((x) => x.text),
        })
      // 只留最后一条回复的正文：它通常是这一段工作的结论
      reply = replyExcerpt(m.text)
    }
  }
  // 提示词里只放开头一条和最近几条：开头常是用户报的问题，最近几条是结论所在
  const asks =
    userTexts.length <= SUMMARY_ASKS_MAX ? userTexts : [userTexts[0], ...userTexts.slice(-(SUMMARY_ASKS_MAX - 1))]
  const steps = task.steps
    .filter((s) => inRange(s.startedAt, win) || inRange(s.endedAt, win))
    .slice(-SUMMARY_STEPS_MAX)
    .map((s) => ({ title: clip(s.title, 40), status: s.status }))
  for (const s of task.steps) touch(s.endedAt || s.startedAt)
  for (const turn of task.turns) touch(turn.endedAt || turn.startedAt)
  // 窗口里执行过的对话至少留下一条消息或一个节点；只是打开了对话、没执行的不算
  if (!userTexts.length && !outcomes.length && !steps.length) return null
  const files = [...new Set(task.changes.map((c) => c.path))].slice(0, SUMMARY_FILES_MAX)
  // 只看用户提的要求和对话标题：Bug 只收用户自己报的问题，Agent 说「我顺手修了一个问题」不能算
  const hint = [task.title, ...userTexts].join(' ').toLowerCase()
  return {
    id: task.id,
    title: clip(task.title, 60),
    status: task.status,
    asks,
    outcomes: outcomes.slice(-SUMMARY_OUTCOMES_MAX),
    cards: cards.slice(-SUMMARY_CARDS_MAX),
    // 有卡片时原因和修法已经在卡片里，再带一段正文只是重复（还常是「已推送」这类收尾话）
    reply: cards.length ? '' : reply,
    steps,
    files,
    at,
    userBug: SUMMARY_BUG_HINTS.some((w) => hint.includes(w)),
  }
}

/**
 * 按项目整理窗口内执行过的对话：只保留有活动的项目，顺序按传入的顺序（也就是面板里加进来的顺序）。
 * 子对话也算它自己项目里的执行记录（它们本来就在同一个项目下）
 */
export function collectRangeProjects(
  tasks: Task[],
  projects: SummaryProjectRef[],
  win: Pick<SummaryWindow, 'start' | 'end'>,
): DayProject[] {
  const byProject = new Map<string, DayTask[]>()
  for (const task of tasks) {
    if (!task.projectId) continue
    const d = rangeTask(task, win)
    if (!d) continue
    const list = byProject.get(task.projectId) ?? []
    list.push(d)
    byProject.set(task.projectId, list)
  }
  return projects
    .filter((p) => byProject.has(p.id))
    .map((p) => ({
      projectId: p.id,
      projectName: p.name,
      // 先按最近执行排序再截断：超过上限时留下的是窗口内最新的对话
      tasks: byProject
        .get(p.id)!
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, SUMMARY_TASKS_PER_PROJECT),
    }))
}

/** 加了、但这段时间没有可总结内容的项目名：页面据此提示，不静默略过 */
export function skippedProjects(picks: SummaryProjectRef[], projects: DayProject[]) {
  const analyzed = new Set(projects.map((p) => p.projectId))
  return picks.filter((p) => !analyzed.has(p.id)).map((p) => p.name)
}

/** 交给 CLI 的对话材料 */
export function tasksContext(projects: DayProject[]) {
  return projects
    .map((p) =>
      [
        `## 项目：${p.projectName}`,
        ...p.tasks.map((task) => {
          const lines = [
            `- 对话「${task.title || '未命名'}」（${task.status}）`,
            // 只是关键词线索，不是结论：用户原文里说「点保存没反应」这种没命中关键词的也是问题，交给 CLI 判
            `  关键词命中问题词：${task.userBug ? '是' : '否'}`,
          ]
          if (task.asks.length) lines.push(`  用户的要求：${task.asks.join('；')}`)
          if (task.outcomes.length) lines.push(`  结论：${task.outcomes.join('；')}`)
          for (const c of task.cards) {
            lines.push(`  总结卡「${c.kind}｜${c.title}」`)
            for (const x of c.fields) lines.push(`    ${x.label}：${x.text}`)
          }
          if (task.reply) lines.push(`  最后的回复：${task.reply}`)
          if (task.steps.length) lines.push(`  节点：${task.steps.map((s) => `${s.title}（${s.status}）`).join('、')}`)
          if (task.files.length) lines.push(`  改动的文件：${task.files.join('、')}`)
          return lines.join('\n')
        }),
      ].join('\n'),
    )
    .join('\n\n')
}

// ---- 材料：已生成的报告 ----

/**
 * 窗口里可以拿来提炼的报告：覆盖范围整个落在窗口内的才算（只沾到一天的周报告不算，免得把范围外的事带进来）。
 * 按周提炼时不收覆盖整周的周报告：它本身就是这一周的成品，再拿来提炼只会和日报告重复
 */
export function reportsInWindow(reports: SummaryRecord[], win: SummaryWindow): SummaryRecord[] {
  return reports
    .filter((r) => {
      const { from, to } = reportSpan(r)
      if (!from || from < win.fromDay || to > win.toDay) return false
      return !(win.grain === 'week' && from === win.fromDay && to === win.toDay)
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .slice(-SUMMARY_REPORTS_MAX)
}

/** 交给 CLI 的报告材料：每份带上覆盖日期和项目，正文太长时截断（写明截断了） */
export function reportsContext(reports: SummaryRecord[]) {
  return reports
    .map((r) => {
      const { from, to } = reportSpan(r)
      const span = from === to ? from : `${from} 至 ${to}`
      const names = r.projectNames.length ? `（项目：${r.projectNames.join('、')}）` : ''
      const body = r.md.trim()
      const cut =
        body.length > SUMMARY_REPORT_CHARS
          ? `${body.slice(0, SUMMARY_REPORT_CHARS)}\n…（后面还有 ${body.length - SUMMARY_REPORT_CHARS} 字没有放进来）`
          : body
      return `## 报告：${span}${names}\n${cut}`
    })
    .join('\n\n')
}

// ---- 提示词 ----

/** 提示词第一行的范围描述：按天写日期，按周写起止 */
function scopeText(win: SummaryWindow) {
  return win.grain === 'day'
    ? `${win.fromDay}`
    : `${win.fromDay} 至 ${win.toDay}（第 ${isoWeek(parseDay(win.fromDay) ?? new Date()).week} 周）`
}

/**
 * 交给 CLI 的提炼提示词：角色设定（写法规则都在「每日工作总结」角色里，用户能自己调）+ 本次范围 + 输出约定 + 材料。
 * 输出约定写在这里而不是角色里：JSON 字段和解析代码绑在一起，改了一边另一边要跟着改
 */
export function extractPrompt(input: {
  role: string
  win: SummaryWindow
  source: SummarySource
  projects: string[]
  context: string
}) {
  const { win } = input
  const from = input.source === 'reports' ? '这段时间已经生成过的工作总结报告' : '这段时间各项目执行过的对话记录'
  const lines: (string | false)[] = [
    input.role.trim(),
    '',
    '## 这一次',
    `- 范围：${scopeText(win)}。只写这段时间里的事，材料里出现的范围外的内容一律不写。`,
    `- 材料：下面给出的是${from}，已经按范围筛好；不要再去读文件或数据目录。`,
    input.projects.length > 0 && `- 项目：${input.projects.join('、')}；分项的 project 写这里面的名字。`,
    '- 输出：只输出一个 ```json 代码块，不要别的文字。格式：',
    '```json',
    '{"items":[',
    '  {"kind":"need","project":"<项目名>","title":"<需求标题>","content":"<做了什么、用户能感受到什么变化>"},',
    '  {"kind":"bug","project":"<项目名>","title":"<问题标题：用户看到的现象>","cause":"<为什么会出现这个现象>","fix":"<改了什么、为什么这样改就好了>"}',
    ']}',
    '```',
    '- 材料里的「总结卡」是 Agent 当时写的现象、原因、修复，优先照它写清因果；材料里有的原因和修法要写进去，不要压成一句「修复了 xx 问题」。',
    `- 最多 ${SUMMARY_ITEMS_MAX} 条；没有可写的内容就输出 {"items":[]}，不要凑数。`,
    '',
    '## 材料',
    input.context.trim() || '（这段时间没有记录）',
  ]
  return lines.filter((l): l is string => l !== false).join('\n')
}

/** 第一次的回答解析不了时追加的提示：带上原因，要求只输出 JSON */
export function extractRetryHint(error: string) {
  return `\n\n上一次的回答没法解析（${error}）。请只输出一个 \`\`\`json 代码块，格式按上面的约定，不要别的文字。`
}

/** 从回答里取 JSON：优先最后一个 ```json 代码块，没有就取第一个 { 到最后一个 } */
function pickJson(text: string): { json?: unknown; error?: string } {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  let raw = blocks.at(-1)?.[1]
  if (raw === undefined) {
    const a = text.indexOf('{')
    const b = text.lastIndexOf('}')
    if (a < 0 || b <= a) return { error: '回答里没有 JSON' }
    raw = text.slice(a, b + 1)
  }
  try {
    return { json: JSON.parse(raw) }
  } catch (e) {
    return { error: `JSON 格式不对：${(e as Error).message}` }
  }
}

const RawEntry = z.object({
  kind: z.string(),
  project: z.unknown().optional(),
  title: z.unknown(),
  content: z.unknown().optional(),
  cause: z.unknown().optional(),
  fix: z.unknown().optional(),
})

const text = (v: unknown, max: number) => (typeof v === 'string' ? clip(v, max) : '')

/**
 * 把 CLI 的回答解析成分项：认不出种类、没有标题的条目丢掉，项目名对不上时按大小写和空白宽松匹配，
 * 还对不上就原样保留（老报告里的项目可能已经改名）。返回 error 时调用方重试或报错，不悄悄当成「没有内容」
 */
export function parseExtract(
  answer: string,
  projects: string[],
  newId: () => string,
): { items: SummaryEntry[]; error?: string } {
  const { json, error } = pickJson(answer)
  if (error) return { items: [], error }
  const list = Array.isArray(json) ? json : (json as { items?: unknown } | null)?.items
  if (!Array.isArray(list)) return { items: [], error: '没有 items 数组' }
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const known = new Map(projects.map((p) => [norm(p), p]))
  const items: SummaryEntry[] = []
  for (const x of list) {
    const r = RawEntry.safeParse(x)
    if (!r.success) continue
    const kind = r.data.kind.toLowerCase()
    if (kind !== 'need' && kind !== 'bug') continue
    const title = text(r.data.title, 120)
    if (!title) continue
    const project = text(r.data.project, 80)
    items.push({
      id: newId(),
      kind,
      project: known.get(norm(project)) ?? project,
      title,
      content: kind === 'need' ? text(r.data.content, 600) : '',
      cause: kind === 'bug' ? text(r.data.cause, 600) : '',
      fix: kind === 'bug' ? text(r.data.fix, 600) : '',
    })
    if (items.length >= SUMMARY_ITEMS_MAX) break
  }
  return { items }
}

// ---- 拼报告 ----

/** 报告的一级标题：按天「2026-10-29 工作总结」，按周「第 44 周工作总结（2026-10-26 至 2026-11-01）」 */
export function reportHeading(grain: SummaryGrain, from: string, to: string) {
  if (grain === 'day' || from === to) return `${from} 工作总结`
  return `第 ${isoWeek(parseDay(from) ?? new Date()).week} 周工作总结（${from} 至 ${to}）`
}

/** 报告固定的两节：需求在前、Bug 在后 */
export const REPORT_SECTIONS = ['## 一、需求', '## 二、Bug'] as const

/** 分项按项目分组，项目顺序按第一次出现的顺序（也就是 CLI 给出 / 用户采纳的顺序） */
function byProject(items: SummaryEntry[]) {
  const map = new Map<string, SummaryEntry[]>()
  for (const x of items) {
    const key = x.project || '其他'
    map.set(key, [...(map.get(key) ?? []), x])
  }
  return [...map.entries()]
}

/**
 * 用采纳的分项拼报告：需求和 Bug 分两节，节内按项目分小节、条目编号。
 * 需求只写「内容」（做了什么、实现了什么），Bug 写「原因」和「修复」；某一节没有条目时写「暂无」
 */
export function renderReport(input: { grain: SummaryGrain; from: string; to: string; items: SummaryEntry[] }) {
  const section = (no: number, kind: SummaryKind) => {
    const groups = byProject(input.items.filter((x) => x.kind === kind))
    if (!groups.length) return ['暂无', '']
    return groups.flatMap(([name, list], gi) => [
      `### ${no}.${gi + 1} ${name}`,
      ...list.flatMap((x, i) => [
        `${i + 1}. **${x.title}**`,
        ...(kind === 'need'
          ? x.content
            ? [`   内容：${x.content}`]
            : []
          : [...(x.cause ? [`   原因：${x.cause}`] : []), ...(x.fix ? [`   修复：${x.fix}`] : [])]),
      ]),
      '',
    ])
  }
  return [
    `# ${reportHeading(input.grain, input.from, input.to)}`,
    '',
    REPORT_SECTIONS[0],
    '',
    ...section(1, 'need'),
    REPORT_SECTIONS[1],
    '',
    ...section(2, 'bug'),
  ]
    .join('\n')
    .trimEnd()
    .concat('\n')
}

/** 报告的字数（去掉空白）：报告头显示规模用，Markdown 标记也算进去，不另算一套口径 */
export function reportChars(md: string) {
  return md.replace(/\s/g, '').length
}

/** 报告在树里的名字：项目名，从报告提炼的写「汇总」；老报告没有项目名时用正文第一行 */
export function reportName(r: Pick<SummaryRecord, 'projectNames' | 'source' | 'md' | 'day'>) {
  if (r.source === 'reports') return t('汇总报告')
  if (r.projectNames.length) return r.projectNames.join('、')
  const line = r.md.split('\n').find((l) => l.trim())
  return clip((line ?? '').replace(/^#+\s*/, ''), 60) || r.day
}

/**
 * 耗时的显示：不到 1 秒 / N 秒 / N 分 M 秒。
 * 0 或非法值返回空串——老报告没有耗时字段，页面就不显示这一段
 */
export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 1) return t('不到 1 秒')
  if (sec < 60) return t('{n} 秒', { n: sec })
  const min = Math.floor(sec / 60)
  const rest = sec % 60
  return rest ? t('{n} 分 {m} 秒', { n: min, m: rest }) : t('{n} 分钟', { n: min })
}
