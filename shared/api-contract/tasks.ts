/**
 * 任务接口的契约（写法见 ./define.ts）：任务列表、详情、子对话、发消息、新建。
 *
 * Task 本身的 schema 带大量默认值，parse 时缺字段会被补上、拦不住漂移，所以这里单独写出界面必读的字段
 * （looseObject：两边都可以多带字段，这里只拦「界面要读的字段缺了或类型变了」），完整类型用 shaped 指定。
 */
import { z } from 'zod'
import type { ChildRow } from '../children/row.ts'
import { FollowUpInput, NewTaskInput, TaskMessage, TaskMode, TaskStatus, type Task } from '../schema.ts'
import { endpoint, shaped } from './define.ts'

const MessageShape = z.looseObject({
  id: z.string(),
  role: TaskMessage.shape.role,
  text: z.string(),
  tools: z.array(z.unknown()),
  at: z.string(),
})

/** 列表、详情、发消息都返回一份任务：这几项侧栏、对话页、输入框都直接读 */
const TaskShape = z.looseObject({
  id: z.string(),
  title: z.string(),
  status: TaskStatus,
  mode: TaskMode,
  projectId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(MessageShape),
  steps: z.array(z.unknown()),
  plans: z.array(z.unknown()),
  turns: z.array(z.unknown()),
  usage: z.looseObject({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }),
})

/** 顶层对话额外带的三项计数（shared/children/row.ts 的 childCountsScan）：侧栏、子对话刷新信号、输入框「在等什么」都读它们 */
const ChildCounts = { childrenWorking: z.number(), childrenCli: z.number(), childrenNeeds: z.number() }

/**
 * 打开对话时只取最近一段消息（`?limit=` / 往前翻页 `?before=`）时多带的分页信息：
 * messageTotal 是完整条数，比 messages 多就说明还有更早的要往前翻；不传 limit 时没有这两个字段。
 * messageRev 只在整份对话都在这一份里时给（见 server/tasks.ts 的 GET /:id）：前端建 SSE 时带上它，
 * 首包就只补发增量；截断的那段不是整份的前缀，不能当版本用
 */
export type TaskPage = Task & {
  messageTotal?: number
  messageHasMore?: boolean
  messageRev?: string
  /** 翻页的锚点（`before`）那条已经被删了：要重新取最后一页，不能拼一段不连续的历史 */
  messageAnchorMissing?: boolean
}

/** GET /tasks?projectId=：顶层对话的摘要（消息只留第一条用户消息） */
export const TaskListContract = z.array(TaskShape.extend(ChildCounts))

/** GET /tasks/:id?limit=：对话页打开时的第一页（顶层对话） */
export const TaskPageContract = TaskShape.extend({
  ...ChildCounts,
  cliAlive: z.boolean(),
  messageTotal: z.number(),
  messageHasMore: z.boolean(),
})

/** GET /tasks/:id/children：子对话栏的一行（正式后端和演示后端都由 shared/children/row.ts 的 childRow 拼） */
export const ChildRowContract = z.looseObject({
  id: z.string(),
  title: z.string(),
  status: TaskStatus,
  summary: z.string(),
  working: z.boolean(),
  updatedAt: z.string(),
  cliAlive: z.boolean(),
  startedAt: z.string(),
  turnDoneAt: z.string(),
  turnSeenAt: z.string(),
  requests: z.number(),
  asking: z.number(),
  childNeeds: z.number(),
  background: z.number(),
  worktreeChecked: z.boolean(),
  resolved: z.boolean(),
  gone: z.boolean(),
  stopReason: z.string(),
  waiting: z.unknown().optional(),
  activity: z.unknown().optional(),
})
export const ChildListContract = z.array(ChildRowContract)

/** POST /tasks/:id/messages：返回整份任务，页面按它替换本地那份 */
export const SendMessageContract = TaskShape

export const tasksContract = {
  list: endpoint({ method: 'GET', path: '/tasks', res: shaped<Task[]>(TaskListContract) }),
  page: endpoint({ method: 'GET', path: '/tasks/:id', res: shaped<TaskPage>(TaskShape) }),
  children: endpoint({ method: 'GET', path: '/tasks/:id/children', res: shaped<ChildRow[]>(ChildListContract) }),
  stopChildren: endpoint({
    method: 'POST',
    path: '/tasks/:id/children/stop',
    body: z.object({}),
    res: z.object({ stopped: z.number() }),
  }),
  send: endpoint({
    method: 'POST',
    path: '/tasks/:id/messages',
    body: FollowUpInput,
    res: shaped<Task>(SendMessageContract),
  }),
  create: endpoint({ method: 'POST', path: '/tasks', body: NewTaskInput, res: shaped<Task>(TaskShape) }),
}
