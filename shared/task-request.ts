/**
 * Agent 等用户处理的请求（确认、提问）的结构。从 schema.ts 拆出来（那个文件到了行数上限），
 * schema.ts 原样转出，引用的地方不用改
 */
import { z } from 'zod'

// 等你操作的结构在 user-action.ts：和提问、确认同属「Agent 等用户」，从这里转给 schema.ts
export { UserAction } from './user-action.ts'

/** CLI 一次提的一个问题（Claude Code 的 AskUserQuestion 一次可以问几个） */
export const AskQuestion = z.object({
  /** 很短的标签，多个问题时显示在页签上 */
  header: z.string().default(''),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().default('') })).default([]),
  multiSelect: z.boolean().default(false),
})
export type AskQuestion = z.infer<typeof AskQuestion>

/** Agent 等用户确认的操作（权限不够的命令、改文件）或问题；确认在输入框上方显示，问题换掉输入框 */
export const TaskRequest = z.object({
  id: z.string(),
  step: z.string().default(''),
  agentId: z.string().default(''),
  /** confirm：工作流节点完成后等用户确认结果 */
  kind: z.enum(['command', 'file', 'tool', 'question', 'confirm']),
  /**
   * 面板自己发起的授权（不是 CLI 的权限请求）：push 是 ask_push 的推送授权卡，用户点的「允许 / 拒绝」
   * 由面板记进 task.remotePush（见 server/exec/panel-requests.ts）。旧数据没有这个字段，照普通请求处理
   */
  purpose: z.enum(['push']).optional(),
  title: z.string(),
  detail: z.string().default(''),
  /** 问题的选项；也可以自己填 */
  options: z.array(z.string()).default([]),
  /** 一次问了几个问题时的每一个（有它时 title、options 是第一个问题的） */
  questions: z.array(AskQuestion).optional(),
  /** 改文件的请求：要改的内容（unified diff 文本），审批卡上按行显示，不用只凭文件名决定 */
  diff: z.string().optional(),
  /** 「一直允许这类」的规则键（shared/allow-rules.ts）；没有就不能一直允许 */
  rule: z.string().optional(),
  at: z.string(),
})
export type TaskRequest = z.infer<typeof TaskRequest>
