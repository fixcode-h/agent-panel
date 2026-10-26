/**
 * 工作总结：选几个项目，把「今天」（本机时区的自然日）执行过的对话整理成一份 Markdown 报告。
 *
 * 这里只有纯逻辑：时间窗口、从任务里提炼今天的活动、交给 CLI 的提示词、从回答里取出报告。
 * 跑 CLI 和存报告在 server/summary.ts；页面在 web/src/pages/SummaryPage.tsx
 */
import { z } from 'zod'
import { promptLangRules } from './prompt-lang.ts'
import type { Task } from './schema.ts'
import { dayKey } from './usage.ts'
import { clip as clipText } from './text.ts'

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

/** 报告里固定的三个二级标题：顺序也是这个，缺一节不许省 */
export const SUMMARY_SECTIONS = ['## 一、需求进度', '## 二、用户报告的 Bug', '## 三、今日小结'] as const

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
})
export type SummaryRequest = z.infer<typeof SummaryRequest>

/** 存下来的一份报告：正文可以再编辑（PUT /summary/:id） */
export const SummaryReport = z.object({
  /** 覆盖的本地自然日，格式 2026-10-23 */
  day: z.string(),
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

/** 本机时区的今天 00:00 到现在的窗口 */
export function todayWindow(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return { day: dayKey(now), start: start.getTime(), end: now.getTime() }
}

/** 时间戳是不是落在今天（本机时区） */
export function isToday(iso: string, day: string) {
  if (!iso) return false
  const d = new Date(iso)
  return !Number.isNaN(d.getTime()) && dayKey(d) === day
}

/**
 * 这个任务今天有没有执行过：只看时间字段（任务摘要里没有消息），用来先筛候选任务、页面列出今天的对话。
 * 页面和服务端共用这一处判定，避免「页面列得出来、服务端却当作没执行」
 */
export function activeOnDay(task: Task, day: string) {
  if (isToday(task.updatedAt, day) || isToday(task.turnDoneAt, day) || isToday(task.runStartedAt, day)) return true
  return task.messages.some((m) => isToday(m.at, day))
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

/** 一个任务今天的活动；今天没执行过（没有今天的消息和节点）时返回 null */
export function dayTask(task: Task, day: string): DayTask | null {
  const asks: string[] = []
  const outcomes: string[] = []
  let at = ''
  const touch = (iso: string) => {
    if (isToday(iso, day) && iso > at) at = iso
  }
  for (const m of task.messages) {
    if (!isToday(m.at, day)) continue
    touch(m.at)
    if (isPanelNote(m)) continue
    if (m.role === 'user' && m.text.trim()) {
      if (asks.length < SUMMARY_ASKS_MAX) asks.push(clip(m.text))
    } else if (m.role === 'agent') {
      const one = firstLine(m.text)
      // 只留最后几条：结论在后面的回复里
      if (one) outcomes.push(one)
    }
  }
  const steps = task.steps
    .filter((s) => isToday(s.startedAt, day) || isToday(s.endedAt, day))
    // 和 outcomes 一样只留最后几个：报告要说的是最近做完的节点
    .slice(-SUMMARY_STEPS_MAX)
    .map((s) => ({ title: clip(s.title, 40), status: s.status }))
  for (const s of task.steps) touch(s.endedAt || s.startedAt)
  for (const turn of task.turns) touch(turn.endedAt || turn.startedAt)
  // 今天执行的对话至少留下一条消息或一个节点；今天只是打开了对话、没执行的不算
  if (!asks.length && !outcomes.length && !steps.length) return null
  const files = [...new Set(task.changes.map((c) => c.path))].slice(0, SUMMARY_FILES_MAX)
  // 只看用户提的要求和对话标题：报告里的「用户报告的 Bug」只收用户自己报的问题，
  // Agent 在结论里说的「我顺手修了一个问题」不能算
  const hint = [task.title, ...asks].join(' ').toLowerCase()
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

/** 报告要分析哪个项目的哪些对话：taskIds 为空表示这个项目今天全部对话 */
export interface SummaryDayPick extends SummaryProjectRef {
  taskIds?: string[]
}

/**
 * 按项目整理今天执行过的对话：只保留有活动的项目，项目顺序按传入的顺序（也就是用户加进来的顺序）。
 * 传了 taskIds 时只留这些对话，为空表示该项目今天全部。
 * 子对话也算它自己项目里的执行记录（它们本来就在同一个项目下）
 */
export function collectDayProjects(tasks: Task[], projects: SummaryDayPick[], now = new Date()): DayProject[] {
  const { day } = todayWindow(now)
  const byProject = new Map<string, DayTask[]>()
  for (const task of tasks) {
    if (!task.projectId) continue
    const d = dayTask(task, day)
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
          // 先按最近执行排序再截断：超过上限时留下的是今天最新的对话，不是最早创建的
          tasks: byProject
            .get(p.id)!
            .filter((t) => !only || only.has(t.id))
            .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
            .slice(0, SUMMARY_TASKS_PER_PROJECT),
        }
      })
      // 选中了对话、但这些对话今天都没执行时，这个项目也就没有可写的内容
      .filter((p) => p.tasks.length > 0)
  )
}

/**
 * 用户选了、但今天没有可总结内容的项目名：页面据此提示，不静默把它们从报告里删掉。
 * 服务端算完 collectDayProjects 后调用，判断口径就是「有没有进报告」
 */
export function skippedProjects(picks: SummaryProjectRef[], projects: DayProject[]) {
  const analyzed = new Set(projects.map((p) => p.projectId))
  return picks.filter((p) => !analyzed.has(p.id)).map((p) => p.name)
}

/** 报告里交给 CLI 的「今天的执行记录」正文 */
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
export function summaryPrompt(input: { day: string; projects: DayProject[] }) {
  return [
    `你在帮用户整理今天的工作总结报告。今天是 ${input.day}。`,
    promptLangRules(),
    '',
    '输出格式：必须严格照下面这个结构写，字段、顺序、编号一律不能变，不要自创小节：',
    '',
    `# ${input.day} 工作总结`,
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
    '<一句话：今天整体做完了什么、还剩什么>',
    '',
    '硬性规则：',
    `- 一级标题固定写成 \`# ${input.day} 工作总结\`。`,
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
    '今天的执行记录：',
    summaryContext(input.projects) || '（今天没有执行记录）',
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
  // 一级标题：报告第一行就是它
  if (!new RegExp(`^# \\d{4}-\\d{2}-\\d{2} 工作总结$`).test((body[0] ?? '').trim())) issues.add('title')
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
