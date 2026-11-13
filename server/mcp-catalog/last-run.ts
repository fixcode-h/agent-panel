/**
 * 上一次真实对话挂上了哪些 MCP 工具（设置 →「MCP」总览最底下那一行）：
 * 面板服务和插件服务各自在 CLI 取工具清单时记一笔，插件给对话挂工具出错时也记下。
 * 只是给人看的统计，不影响执行，所以只放内存。
 */
import { taskMap } from '../runtime/task-state.ts'

interface Mounted {
  at: string
  servers: Map<string, number>
  errors: string[]
}

const byTask = taskMap<Mounted>('mcp-catalog.last-run')
let lastTask = '' // 模块状态：缓存，最近一次挂载的对话 id，只给设置页看，重启后为空

function entry(taskId: string) {
  const now = new Date().toISOString()
  let e = byTask.get(taskId)
  // 同一个对话隔了一轮再取清单：按新的一轮重新记
  if (!e || Date.now() - Date.parse(e.at) > 10 * 60_000) {
    e = { at: now, servers: new Map(), errors: [] }
    byTask.set(taskId, e)
  }
  e.at = now
  lastTask = taskId
  return e
}

/** CLI 取了某个服务的工具清单 */
export function noteMounted(taskId: string, server: string, count: number) {
  if (!taskId) return
  entry(taskId).servers.set(server, count)
}

/** 插件给这一轮挂工具时出错或超时 */
export function noteMountError(taskId: string, error: string) {
  if (!taskId) return
  const e = entry(taskId)
  if (!e.errors.includes(error)) e.errors.push(error)
}

/** 最近一次：哪个对话、什么时候、一共几个工具、有没有出错 */
export function lastMount(): { taskId: string; at: string; tools: number; errors: string[] } | undefined {
  const e = lastTask ? byTask.get(lastTask) : undefined
  if (!e) return undefined
  return { taskId: lastTask, at: e.at, tools: [...e.servers.values()].reduce((a, b) => a + b, 0), errors: e.errors }
}
