import type { CliEvent } from './parsers.ts'
import { taskLog } from '../tasks/log.ts'

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
  /**
   * 面板交出去、CLI 还没报下一次请求的时间（输入交给 CLI、工具结果回来）：下一次请求从这里算起。
   * 只有「请求开始」报得晚的 CLI 才需要（Claude Code），报得准的 CLI 也按它算，差的是 CLI 自己准备请求的那点时间
   */
  pendingSince?: number
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
  /**
   * 这一轮怎么停的（ADR 0041）：模型最后一次回应的 stop_reason、最后一段输出是什么、这一轮调了几次工具。
   * 用来分清「说了要做却没做」是模型把说明单独发成一条（end_turn + 最后是正文 + 没调工具）、网关截断（max_tokens），
   * 还是真的做完了
   */
  lastTurn?: { stopReason?: string; endedOn?: string; tools: number }
  /** 这一轮到现在调过的工具（按 id 去重：同一个工具会报好几次进度；报结束时清空） */
  turnTools?: Set<string>
}

/** 不算「模型在输出」的事件：用量、会话、请求开始这些是 CLI 自己报的元数据 */
// 模块状态：常量，加载后不改
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
  'sent',
  'wait',
])

/** 键是「对话 id + 步骤 id」：子任务、工作流节点和对话自己这一轮各记各的，不互相覆盖 */
const traces = new Map<string, CliTrace>() // 模块状态：会话，跟着进程或连接一起没
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
    // 这次请求第一段输出到了：先交一个「等了多久」，runner 记进用量（会话栏的首包时间）
    const waited = traceCli(taskId, step, ev)
    if (waited !== undefined) onEvent({ type: 'wait', ms: waited })
    onEvent(ev)
  }
}

/**
 * 一个 CLI 事件：只在关键节点写日志。日志写在对话的日志文件里，步骤 id 记在每一行上。
 * 这次请求的第一段输出到达时返回等了多久（毫秒），其余返回 undefined
 */
export function traceCli(taskId: string, step: string | undefined, ev: CliEvent, now = Date.now()): number | undefined {
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
      // 从交出去的那一刻算（输入交给 CLI、上一批工具结果回来）：Claude Code 的「请求开始」在模型回出第一段时才到，
      // 按它算首包只有零点几秒，真正等的十几秒全漏掉了（2026-11-04 实测）
      tr.requestAt = tr.pendingSince ?? now
      tr.pendingSince = undefined
      tr.firstOutputAt = undefined
      log('模型请求开始', { n: tr.requests, ...(tr.requestAt < now ? { sentMsAgo: now - tr.requestAt } : {}) })
      return
    case 'sent':
      tr.pendingSince = now
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
      tr.pendingSince = undefined
      tr.resultAt = now
      tr.resultOk = ev.ok
      tr.lastTurn = { stopReason: ev.stopReason, endedOn: tr.lastEvent, tools: tr.turnTools?.size ?? 0 }
      tr.turnTools = undefined
      log('CLI 报这一轮结束', {
        ok: ev.ok,
        error: ev.ok ? undefined : ev.error,
        stopReason: ev.stopReason,
        endedOn: tr.lastTurn.endedOn,
        tools: tr.lastTurn.tools,
      })
      return
    case 'error':
      log('CLI 报错', { error: ev.message })
      return
  }
  // 工具结果交回去以后 CLI 马上发下一次请求：几个工具并行时以最后一个结果为准
  if (ev.type === 'tool_result') tr.pendingSince = now
  if (META.has(ev.type)) return
  // 交出去之后又有了输出：不报「请求开始」的 CLI（Codex）这次请求已经开始回了，别留到下一轮去算（会把用户发呆的时间也算进去）
  if (ev.type !== 'tool_result') tr.pendingSince = undefined
  let waited: number | undefined
  if (!tr.firstOutputAt) {
    tr.firstOutputAt = now
    // 不报「请求开始」的 CLI：从这次调用开始算
    waited = now - (tr.requestAt ?? tr.startedAt)
    log('模型开始输出', { n: tr.requests, waitedMs: waited, kind: ev.type })
  }
  tr.lastOutputAt = now
  tr.lastEvent = ev.type
  // 只数带 id 的：同一个工具会报好几次进度，没有 id 时分不清是不是同一个，宁可少数也不多算
  if (ev.type === 'tool' && ev.id) (tr.turnTools ??= new Set()).add(ev.id)
  tr.retry = undefined
  return waited
}
