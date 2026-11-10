/**
 * 任务接口的返回形状（契约）：演示后端（web/src/lib/demo-backend.ts）和正式后端（server/tasks/*-routes.ts）
 * 用同一份 schema 校验，免得演示版悄悄少了字段、界面分支在演示和界面检查里永远走不到。
 *
 * 只收界面真正读的几个最常用接口：任务列表、任务详情（分页）、子对话列表、发消息。
 * 用 looseObject：两边都可以多带字段，这里只拦「界面要读的字段缺了或类型变了」。
 * Task 本身的 schema 带大量默认值，parse 时缺字段会被补上、拦不住漂移，所以这里单独写出必须有的字段。
 */
import { z } from 'zod'
import { TaskMessage, TaskMode, TaskStatus } from './schema.ts'

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

/** 顶层对话额外带的三项计数：侧栏、子对话刷新信号、输入框「在等什么」都读它们 */
const ChildCounts = { childrenWorking: z.number(), childrenCli: z.number(), childrenNeeds: z.number() }

/** GET /tasks?projectId=：顶层对话的摘要（消息只留第一条用户消息） */
export const TaskListContract = z.array(TaskShape.extend(ChildCounts))

/** GET /tasks/:id?limit=：对话页打开时的第一页（顶层对话） */
export const TaskPageContract = TaskShape.extend({
  ...ChildCounts,
  cliAlive: z.boolean(),
  messageTotal: z.number(),
  messageHasMore: z.boolean(),
})

/** GET /tasks/:id/children：子对话栏的一行（字段和 web/src/lib/api.ts 的 taskChildren 一致） */
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
  requests: z.number().optional(),
  asking: z.number().optional(),
  childNeeds: z.number().optional(),
  resolved: z.boolean().optional(),
  gone: z.boolean().optional(),
  stopReason: z.string().optional(),
  waiting: z.unknown().optional(),
  activity: z.unknown().optional(),
})
export const ChildListContract = z.array(ChildRowContract)

/** POST /tasks/:id/messages：返回整份任务，页面按它替换本地那份 */
export const SendMessageContract = TaskShape
