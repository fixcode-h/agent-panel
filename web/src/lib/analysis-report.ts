import type { Agent, Task, TaskMessage } from '@shared/schema'
import { EVOLUTION_LANG } from '@shared/task-export'
import { LESSON_REVIEW_LANG } from '@shared/lesson-review'
import { DIAGNOSIS_LANG } from '@shared/diagnosis'

/**
 * AI 分析对话的「分析报告」：分析结果不再固定在输入框上方，而是画在对话右侧的功能面板里（ADR 0016）。
 * 这里是纯逻辑：认出哪条回复是报告、报告是哪种、报告里的某一项有没有在这个对话里修过。
 */

/**
 * 右侧功能面板能画的报告：执行分析（代码问题 + 角色、工作流优化）、教训评审、项目初始化的推荐设置、
 * 排查的结构化结论（根因、证据、修复，见 shared/diagnosis.ts）
 */
export type ReportKind = 'run' | 'lessons' | 'init' | 'diagnosis'

/** 是不是 AI 分析开出的对话：新对话看 analysis，旧对话看是不是用的必备角色「分析」 */
export function isAnalysisTask(
  task: Pick<Task, 'analysis' | 'agentId'> | { analysis?: Task['analysis']; agentId?: string },
  agents: Pick<Agent, 'id' | 'origin'>[],
) {
  if (task.analysis) return true
  const id = task.agentId
  return !!id && agents.some((a) => a.id === id && a.origin === 'builtin:analyzer')
}

/**
 * 最新一条带结果块的回复。正在回复时只看最后一条用户消息之前的：
 * 接着追问、点修复时报告还留着，正在写的那条没写完不解析
 */
export function reportMessage(
  task: Pick<Task, 'mode' | 'status' | 'working' | 'messages'>,
  test: (text: string) => boolean,
): TaskMessage | undefined {
  if (task.mode !== 'chat') return undefined
  const msgs = task.messages
  let end = msgs.length
  if (task.status === 'running' && task.working) while (end > 0 && msgs[end - 1].role !== 'user') end--
  for (let i = end - 1; i >= 0; i--) if (msgs[i].role === 'agent' && test(msgs[i].text)) return msgs[i]
  return undefined
}

const fence = (lang: string) => (text: string) => text.includes('```' + lang)
/** 初始化的结果是回复末尾的 JSON 代码块（服务端 /assist/resolve 解析） */
const hasJson = (text: string) => /```(?:json)?\s*\n[\s\S]*?\{[\s\S]*?```/.test(text)

/** 初始化对话的回复去掉末尾的 JSON：结果画在右侧的设置应用面板里，对话区不再铺一大段 JSON */
export function stripInitJson(text: string) {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n[\s\S]*?```/g)]
  const last = blocks.at(-1)
  return last && last[0].includes('{')
    ? (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trimEnd()
    : text
}

/** 这个对话有哪种报告、在哪条回复里；没有报告时为空 */
export function findReport(
  task: Pick<Task, 'mode' | 'status' | 'working' | 'messages' | 'analysis'>,
): { kind: ReportKind; message: TaskMessage } | null {
  const run = reportMessage(task, fence(EVOLUTION_LANG))
  const lessons = reportMessage(task, fence(LESSON_REVIEW_LANG))
  const init = task.analysis === 'init' ? reportMessage(task, hasJson) : undefined
  const diagnosis = reportMessage(task, fence(DIAGNOSIS_LANG))
  // 同一个对话里先后出过两种（少见）：取最新的那份
  const all = [
    run && { kind: 'run' as const, message: run },
    lessons && { kind: 'lessons' as const, message: lessons },
    init && { kind: 'init' as const, message: init },
    diagnosis && { kind: 'diagnosis' as const, message: diagnosis },
  ].filter((x): x is { kind: ReportKind; message: TaskMessage } => !!x)
  if (!all.length) return null
  return all.reduce((a, b) => (task.messages.indexOf(b.message) > task.messages.indexOf(a.message) ? b : a))
}

/** 「修复」发进分析对话的消息开头：之后按它认出这一项已经修过 */
export const FIX_MARK = '【修复】'
export const fixHead = (title: string) => `${FIX_MARK}${title}`.slice(0, 120)

/**
 * 报告里某一项在这个对话里的状态：没发过修复是 todo；
 * 修复的消息是最后一条用户消息、对话正在回复时是 working；发过并且这一轮结束了是 done
 */
export function fixState(
  task: Pick<Task, 'status' | 'working' | 'messages'>,
  title: string,
): 'todo' | 'working' | 'done' {
  const head = fixHead(title)
  const users = task.messages.filter((m) => m.role === 'user')
  let at = users.length - 1
  while (at >= 0 && !users[at].text.startsWith(head)) at--
  if (at < 0) return 'todo'
  return at === users.length - 1 && task.status === 'running' && task.working ? 'working' : 'done'
}

/** 分析用时：ms 是已经结算的部分，since 有值表示还在跑，要加上从它到现在的时间 */
export interface AnalysisTiming {
  ms: number
  since?: number
}

/**
 * AI 分析窗口状态胶囊上的用时：这一轮分析实际的起止。
 * 有轮次记录（正式版）用最近一轮的开始和结束；没有轮次（在线演示、旧数据）用累计执行时间 runMs
 * 加上正在跑的这一段（runStartedAt）。都拿不到就不显示，不拿对话的创建时间凑
 */
export function analysisTiming(
  task: Pick<Task, 'runMs' | 'runStartedAt'> & { turns?: Task['turns'] },
): AnalysisTiming | undefined {
  const turn = task.turns?.at(-1)
  if (turn) {
    const start = Date.parse(turn.startedAt)
    if (!Number.isFinite(start)) return undefined
    if (!turn.endedAt) return turn.status === 'running' ? { ms: 0, since: start } : undefined
    const end = Date.parse(turn.endedAt)
    return Number.isFinite(end) ? { ms: Math.max(0, end - start) } : undefined
  }
  const since = task.runStartedAt ? Date.parse(task.runStartedAt) : NaN
  if (Number.isFinite(since)) return { ms: task.runMs ?? 0, since }
  return task.runMs > 0 ? { ms: task.runMs } : undefined
}

/** 现在显示多少：只取整秒，实时计时每秒跳一下，不带小数 */
export const timingMs = (x: AnalysisTiming, now = Date.now()) =>
  Math.floor((x.ms + (x.since ? Math.max(0, now - x.since) : 0)) / 1000) * 1000
