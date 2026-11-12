/**
 * CLI 事件的几种归类（runner.ts 的 apply 用）：从 runner.ts 拆出来，它到了行数上限
 */
import type { TaskMessage } from '../../shared/schema.ts'
import type { CliEvent } from './parsers.ts'

/** 只说明 CLI 收下了、不说明模型在回的事件：不算有了响应 */
// 模块状态：常量，加载后不改
export const NOT_RESPONSE = new Set([
  'session',
  'turn',
  'limits',
  'request_start',
  'files_changed',
  'context',
  'sent',
  'wait',
])
/** 插话收下后还算「同一段输出」的事件：不产生新内容（见 runAgent 的 cutAfter） */
const CONTINUES = new Set(['session', 'turn', 'limits', 'usage', 'gen', 'context', 'files_changed', 'sent', 'wait']) // 模块状态：常量，加载后不改
/**
 * 这个事件还属于正在输出的那一段（cur）：同一段正文、思考的增量，和不产生内容的用量、会话这些事件。
 * 换成工具、新一次模型回应、正文之后又开始思考，这一段就说完了
 */
export const continuesOutput = (ev: CliEvent, cur: TaskMessage | undefined) => {
  if (CONTINUES.has(ev.type)) return true
  if (ev.type === 'text_delta') return !!cur?.text.trim()
  if (ev.type === 'thinking') return !!cur?.thinking && !cur.text.trim() && !cur.tools.length
  return false
}

/** 预热时不记进对话的事件：正文、思考、工具和待办 */
// 模块状态：常量，加载后不改
export const PREWARM_QUIET = new Set([
  'thinking',
  'gen',
  'text_delta',
  'text',
  'tool',
  'tool_result',
  'tool_delta',
  'todos',
])
