import { bgJobIds, bgPendingIds } from '../panel-tools.ts'
import type { Task } from '../schema.ts'

/**
 * 把一条后台命令的结果接到对话里发起它的那一行（run_background、request_build）后面。
 * 只认还在等这条结果的那一行；那一行交出去的编号全有结果了才记用时和小字，界面从这时起不再转圈。
 * 返回有没有改到
 */
export function settleJobRow(task: Task, id: string, text: string, ok: boolean, ms: number, detail: string) {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const tool = task.messages[i].tools.find((x) => bgPendingIds(x.output ?? '').includes(id))
    if (!tool) continue
    tool.output = `${(tool.output ?? '').replace(/\s+$/, '')}\n\n${text}`
    if (!ok) tool.failed = true
    if (!bgPendingIds(tool.output).length) {
      tool.running = undefined
      // 一行一条命令时用时就是这条命令的；申请的编译有几条，按最后一条的算（它们按目录排队一条接一条）
      tool.ms = bgJobIds(tool.output).length > 1 ? (tool.ms ?? 0) + ms : ms
      tool.detail = tool.failed ? detail || tool.detail : ''
    }
    return true
  }
  return false
}
