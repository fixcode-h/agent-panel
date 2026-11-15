import type { TasksScope } from '../../scope.ts'
import { registerRevertRoutes } from './revert.ts'
import { registerAnswerRoutes } from './answers.ts'
import { registerPatchRoute } from './patch.ts'
import { registerHistoryRoutes } from './history.ts'
import { registerStopRoutes } from './stop.ts'

/**
 * 对话上的操作：应用排查结论的修复、撤销改动、回答子对话提问和权限确认、改对话设置、倒回、分叉、压缩、评审、停止。
 * 按分组拆在同目录的几个文件里，各自只拿 TasksScope；这里按原来的顺序注册（Hono 按注册顺序匹配，顺序不能乱）
 */
export function registerActionRoutes(s: TasksScope) {
  registerRevertRoutes(s)
  registerAnswerRoutes(s)
  registerPatchRoute(s)
  registerHistoryRoutes(s)
  registerStopRoutes(s)
}
