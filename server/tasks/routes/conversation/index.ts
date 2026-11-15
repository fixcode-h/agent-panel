import { Hono } from 'hono'
import type { TasksScope } from '../../scope.ts'
import { createRoute } from './create.ts'
import { sendRoute } from './send.ts'
import { prewarmRoutes } from './prewarm.ts'
import { presenceRoutes } from './presence.ts'
import { resumeRoutes } from './resume.ts'

export { createTask } from './create.ts'
export { prewarmChat } from './prewarm.ts'

/**
 * 新建对话、发消息、预热、激活与关闭 Agent、在看 / 已读、结束流程、继续执行（连带拉起一起被打断的子对话）。
 * 按分组拆在同目录的几个文件里，各自只拿 TasksScope、返回子应用；这里按原来的顺序挂（Hono 按注册顺序匹配，顺序不能乱）
 */
export function conversationRoutes(s: TasksScope): Hono {
  const app = new Hono()
  for (const group of [createRoute(s), sendRoute(s), prewarmRoutes(s), presenceRoutes(s), resumeRoutes(s)])
    app.route('/', group)
  return app
}
