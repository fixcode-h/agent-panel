import { Hono } from 'hono'
import type { TasksScope } from '../../scope.ts'
import { revertRoutes } from './revert.ts'
import { answerRoutes } from './answers.ts'
import { patchRoute } from './patch.ts'
import { historyRoutes } from './history.ts'
import { stopRoutes } from './stop.ts'

/**
 * 对话上的操作：应用排查结论的修复、撤销改动、回答子对话提问和权限确认、改对话设置、倒回、分叉、压缩、评审、停止。
 * 按分组拆在同目录的几个文件里，各自只拿 TasksScope、返回子应用；这里按原来的顺序挂（Hono 按注册顺序匹配，顺序不能乱）
 */
export function actionRoutes(s: TasksScope): Hono {
  const app = new Hono()
  for (const group of [revertRoutes(s), answerRoutes(s), patchRoute(s), historyRoutes(s), stopRoutes(s)])
    app.route('/', group)
  return app
}
