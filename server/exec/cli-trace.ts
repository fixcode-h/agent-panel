import type { CliEvent } from './parsers.ts'
import { taskLog } from '../task-log.ts'

/**
 * CLI 这一轮的模型请求轨迹：每次请求什么时候发出、多久才有第一段输出、最后一次输出在什么时候、
 * CLI 有没有在自己重试。写进对话日志，内存里留一份最近的现状，状态诊断（见 shared/lifecycle.ts）按它判断
 * 「等待模型」到底卡在哪一步。
 *
 * 以前日志里只有「CLI 进程启动 / 结束」「交付」「停止」，对话卡在「等待模型」时说不清是网关没回、
 * CLI 自己卡住还是面板的执行位卡住（用户报过：对话很容易卡死在等待模型，发消息也进不去）。
 * 只记关键的节点（请求开始、第一段输出、重试、结束），不逐条记输出，日志不会被流式内容撑大。
 */

export interface CliTrace {
  /** 这次 CLI 调用开始的时间：不报「请求开始」的 CLI（Codex、Pi）按它算等了多久 */
  startedAt: number
  /** 这次进程里第几次模型请求 */
  requests: number
  /** 最近一次请求发出的时间（毫秒） */
  requestAt?: number
  /** 最近一次请求第一段输出的时间；还没有就是 undefined（正在等模型） */
  firstOutputAt?: number
  /** 最近一次有任何输出的时间 */
  lastOutputAt?: number
  /** 最近一次输出是什么（text / thinking / tool …） */
  lastEvent?: string
  /** CLI 自己重试模型请求：第几次、原因；接上了就清掉 */
  retry?: { attempt: number; error?: string; at: number }
  /** CLI 报这一轮结束的时间和结论 */
  resultAt?: number
  resultOk?: boolean
}

/** 不算「模型在输出」的事件：用量、会话、请求开始这些是 CLI 自己报的元数据 */
const META = new Set<CliEvent['type']>([
  'session',
  'request_start',
  'usage',
  'limits',
  'notice',
  'retry_ok',
  'model',
  'context',
  'files_changed',
  'todos',
  'turn',
])

/** 键是「对话 id + 步骤 id」：子任务、工作流节点和对话自己这一轮各记各的，不互相覆盖 */
const traces = new Map<string, CliTrace>()
const keyOf = (taskId: string, step = '') => `${taskId}\n${step}`

/** 这个对话（或它的某一步）最近一次 CLI 调用的轨迹（只在内存里，面板重启后没有） */
export const cliTrace = (taskId: string, step = ''): CliTrace | undefined => traces.get(keyOf(taskId, step))

/**
 * 包一层 onEvent：每个事件先记一笔再交给调用方（invokeCli 里调用，runner 不用改）。
 * 每次 CLI 调用开始时清掉这一步上一次的轨迹
 */
export function tracedEvents(taskId: string, step: string | undefined, onEvent: (ev: CliEvent) => void) {
  if (!taskId) return onEvent
  traces.set(keyOf(taskId, step), { requests: 0, startedAt: Date.now() })
  return (ev: CliEvent) => {
    traceCli(taskId, step, ev)
    onEvent(ev)
  }
}

/** 一个 CLI 事件：只在关键节点写日志。日志写在对话的日志文件里，步骤 id 记在每一行上 */
export function traceCli(taskId: string, step: string | undefined, ev: CliEvent, now = Date.now()) {
  if (!taskId) return
  const key = keyOf(taskId, step)
  const tr = traces.get(key) ?? traces.set(key, { requests: 0, startedAt: now }).get(key)!
  const log = (event: string, data: Record<string, unknown> = {}) =>
    taskLog(taskId, event, { ...data, step: step || undefined })
  switch (ev.type) {
    case 'turn':
      // Codex、常驻协议的 CLI 不报「请求开始」，每轮开始时报一个带 id 的 turn（Claude Code 只在结束时报 end）
      if (!ev.id || ev.end) return
    // falls through
    case 'request_start':
      // 上一次请求一个字都没出就开了下一次：多半是插话进来或 CLI 自己重发，记下来
      if (tr.requestAt && !tr.firstOutputAt)
        log('模型请求没有输出就换了下一次', { n: tr.requests, waitedMs: now - tr.requestAt })
      tr.requests++
      tr.requestAt = now
      tr.firstOutputAt = undefined
      log('模型请求开始', { n: tr.requests })
      return
    case 'notice':
      if (ev.kind === 'retry' || ev.kind === 'retry_failed') {
        tr.retry = { attempt: ev.attempt ?? 1, error: ev.error, at: now }
        log(ev.kind === 'retry' ? 'CLI 重试模型请求' : 'CLI 重试后仍失败', {
          attempt: ev.attempt,
          max: ev.maxAttempts,
          error: ev.error,
        })
      }
      return
    case 'retry_ok':
      log('CLI 重试接上了', { attempt: ev.attempt })
      tr.retry = undefined
      return
    case 'result':
      tr.resultAt = now
      tr.resultOk = ev.ok
      log('CLI 报这一轮结束', { ok: ev.ok, error: ev.ok ? undefined : ev.error })
      return
    case 'error':
      log('CLI 报错', { error: ev.message })
      return
  }
  if (META.has(ev.type)) return
  if (!tr.firstOutputAt) {
    tr.firstOutputAt = now
    // 不报「请求开始」的 CLI：从这次调用开始算
    log('模型开始输出', { n: tr.requests, waitedMs: now - (tr.requestAt ?? tr.startedAt), kind: ev.type })
  }
  tr.lastOutputAt = now
  tr.lastEvent = ev.type
  tr.retry = undefined
}
