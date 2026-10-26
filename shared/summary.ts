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
 * 命中这些词就认为这条对话可能在修 Bug：提示词里要求写清问题在哪、怎么修的。
 * 只收明确指向问题修复的词——「错误」「异常」「失败」在日常需求里太常见（例如「接口失败要不要加重试」），
 * 会把普通对话也标成 Bug 修复。只是给 CLI 的线索，最后由它按内容判断
 */
export const SUMMARY_BUG_HINTS = ['bug', '修复', '报错', '崩溃', 'fix']

/** 生成报告：选中的项目、用哪个 CLI / 模型 / 思考强度跑 */
export const SummaryRequest = z.object({
  projectIds: z.array(z.string().min(1)).min(1).max(50),
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
  /** 看起来在修 Bug */
  bug: boolean
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

/** 压成一行、按字数截断：提示词里不放长段落 */
export function clip(text: string, max = SUMMARY_LINE_MAX) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
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
  const hint = [task.title, ...asks, ...outcomes].join(' ').toLowerCase()
  return {
    id: task.id,
    title: clip(task.title, 60),
    status: task.status,
    asks,
    outcomes: outcomes.slice(-SUMMARY_OUTCOMES_MAX),
    steps,
    files,
    at,
    bug: SUMMARY_BUG_HINTS.some((w) => hint.includes(w)),
  }
}

/**
 * 按项目整理今天执行过的对话：只保留有活动的项目，项目顺序按传入的项目顺序。
 * 子对话也算它自己项目里的执行记录（它们本来就在同一个项目下）
 */
export function collectDayProjects(tasks: Task[], projects: SummaryProjectRef[], now = new Date()): DayProject[] {
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
  return projects
    .filter((p) => byProject.has(p.id))
    .map((p) => ({
      projectId: p.id,
      projectName: p.name,
      // 先按最近执行排序再截断：超过上限时留下的是今天最新的对话，不是最早创建的
      tasks: byProject
        .get(p.id)!
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, SUMMARY_TASKS_PER_PROJECT),
    }))
}

/** 报告里交给 CLI 的「今天的执行记录」正文 */
export function summaryContext(projects: DayProject[]) {
  return projects
    .map((p) =>
      [
        `## ${p.projectName}`,
        ...p.tasks.map((task) => {
          const lines = [`- 对话「${task.title || '未命名'}」（${task.status}${task.bug ? '，可能是 Bug 修复' : ''}）`]
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
 * 交给 CLI 的提示词：只根据今天的执行记录写一份简短、分项的 Markdown 报告。
 * 正文是中文，回复语言跟随面板设置（见 prompt-lang.ts）
 */
export function summaryPrompt(input: { day: string; projects: DayProject[] }) {
  return [
    `你在帮用户整理「今天」的工作总结报告。今天是 ${input.day}。`,
    promptLangRules(),
    '',
    '要求：',
    '- 只根据下面给出的「今天的执行记录」写，不要分析更早的历史，也不要编造记录里没有的事。',
    '- 报告用 Markdown，每个项目一个二级标题（`## 项目名`），项目下面用 `-` 分条，每条一句话、不超过 40 字，不贴代码、不复述大段过程。',
    '- 每个项目按这几条写（没有内容的条目整条省略）：`- **做了**：今天完成的事`、`- **关键决策**：定下的做法或取舍`、`- **Bug**：问题在哪（模块或现象），怎么修的`、`- **遗留**：还没做完或要注意的。',
    '- 只有标了「可能是 Bug 修复」的对话才写 `Bug` 一条，要写清问题在哪个模块（或什么现象）、用什么办法修好的，同样一两句话。标了线索的记录也要按内容判断：看不出明确的问题和修法就不要写这一条。',
    '- 今天没有执行记录的项目不要写；今天的记录里全是占位或空白时，只写一行「今天没有执行记录」。',
    '- 直接输出报告正文：第一行就是项目标题，不要开场白、不要总结段落、不要用代码块包起来。',
    '',
    '今天的执行记录：',
    summaryContext(input.projects) || '（今天没有执行记录）',
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
