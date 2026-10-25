import type { Agent, Task, TaskMessage } from '@shared/schema'
import { EVOLUTION_LANG } from '@shared/task-export'
import { LESSON_REVIEW_LANG } from '@shared/lesson-review'

/**
 * AI 分析对话的「分析报告」：分析结果不再固定在输入框上方，而是画在对话右侧的功能面板里（ADR 0015）。
 * 这里是纯逻辑：认出哪条回复是报告、报告是哪种、报告里的某一项有没有在这个对话里修过。
 */

/** 右侧功能面板能画的报告：执行分析（代码问题 + 角色、工作流优化）、教训评审、项目初始化的推荐设置 */
export type ReportKind = 'run' | 'lessons' | 'init'

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
  // 同一个对话里先后出过两种（少见）：取最新的那份
  const all = [
    run && { kind: 'run' as const, message: run },
    lessons && { kind: 'lessons' as const, message: lessons },
    init && { kind: 'init' as const, message: init },
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
