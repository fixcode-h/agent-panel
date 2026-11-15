import type { NewTaskInput, Task } from '../../../../shared/schema.ts'
import type { TasksScope } from '../../scope.ts'
import { createTask, registerCreateRoute } from './create.ts'
import { registerSendRoute } from './send.ts'
import { prewarmChat, registerPrewarmRoutes } from './prewarm.ts'
import { registerPresenceRoutes } from './presence.ts'
import { registerResumeRoutes } from './resume.ts'

/**
 * 新建对话、发消息、预热、激活与关闭 Agent、在看 / 已读、结束流程、继续执行（连带拉起一起被打断的子对话）。
 * 按分组拆在同目录的几个文件里，各自只拿 TasksScope；这里按原来的顺序注册（Hono 按注册顺序匹配，顺序不能乱）
 */
export function registerConversationRoutes(s: TasksScope) {
  registerCreateRoute(s)
  registerSendRoute(s)
  registerPrewarmRoutes(s)
  registerPresenceRoutes(s)
  registerResumeRoutes(s)
  return {
    prewarmChat: (task: Task, force?: boolean) => prewarmChat(s, task, force),
    createTask: (input: NewTaskInput, raw: unknown) => createTask(s, input, raw),
  }
}
