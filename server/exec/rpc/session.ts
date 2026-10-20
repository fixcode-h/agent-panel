import { t } from '../../../shared/i18n.ts'
import type { CliEvent } from '../parsers.ts'
import type { RpcAdapter, RpcContext, RpcIo, RpcRequestOptions } from './types.ts'

/** 初始化、开始一轮、插话这些请求等多久；CLI 正常都是立刻回 */
const REQUEST_TIMEOUT_MS = 15_000

export interface RpcSession {
  /** 进程起来后调用：开始握手、开一轮 */
  start: (io: RpcIo) => void
  /** stdout 的一行 */
  line: (raw: string) => void
  /** 已经解析好的消息（测试和复用的入口） */
  handle: (msg: any) => void
  steer: (text: string) => Promise<boolean>
  interrupt: () => boolean
  /** 进程结束、或者外层不再需要它了 */
  close: () => void
  readonly finished: boolean
}

/**
 * 一条常驻协议会话的公共部分：stdin/stdout 上的 JSON 行、请求和回复配对、超时、
 * 这一轮结束后的收尾。具体发什么、怎么判断结束由适配器决定。
 */
export function createRpcSession(o: {
  adapter: RpcAdapter
  cwd: string
  input: string
  images?: string[]
  onEvent: (e: CliEvent) => void
  requestTimeoutMs?: number
}): RpcSession {
  let io: RpcIo | undefined
  let nextId = 1
  let finished = false
  let ended = false
  let endTimer: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<string | number, (msg: any) => void>()

  const send = (record: Record<string, unknown>) => {
    if (ended || !io) return
    io.write(JSON.stringify(record) + '\n')
  }

  const end = () => {
    if (ended) return
    ended = true
    clearTimeout(endTimer)
    endTimer = undefined
    for (const resolve of pending.values()) resolve({ error: { message: t('已关闭') } })
    pending.clear()
    io?.end()
  }

  const ctx: RpcContext = {
    cwd: o.cwd,
    input: o.input,
    images: o.images ?? [],
    get finished() {
      return finished
    },
    send,
    request(record, options?: RpcRequestOptions) {
      if (ended) return Promise.resolve({ error: { message: t('已关闭') } })
      const id = options?.id ?? nextId++
      const field = options?.idField ?? 'id'
      const msg = { ...record, [field]: id }
      return new Promise<any>((resolve) => {
        const timer = setTimeout(
          () => {
            pending.delete(id)
            resolve({
              error: { message: t('{method} 没有响应', { method: String(record.method ?? record.type ?? '') }) },
            })
          },
          options?.timeoutMs ?? o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        )
        timer.unref?.()
        pending.set(id, (reply) => {
          clearTimeout(timer)
          resolve(reply)
        })
        send(msg)
      })
    },
    emit(event) {
      for (const e of Array.isArray(event) ? event : [event]) o.onEvent(e)
    },
    finish(ok, error, delayMs = 0) {
      // 已经关掉了：还挂着的请求是 end() 里用「已关闭」结束的，别再报一次结果
      if (ended) return
      finished = true
      o.onEvent({ type: 'result', ok, error })
      clearTimeout(endTimer)
      if (delayMs > 0) endTimer = setTimeout(end, delayMs)
      else end()
    },
    hold() {
      clearTimeout(endTimer)
      endTimer = undefined
    },
  }

  const handle = (msg: any) => {
    if (!msg || typeof msg !== 'object') return
    const id = o.adapter.correlate ? o.adapter.correlate(msg) : msg.id
    if (id !== undefined && pending.has(id)) {
      const resolve = pending.get(id)!
      pending.delete(id)
      resolve(msg)
      return
    }
    const isRequest = o.adapter.isRequest
      ? o.adapter.isRequest(msg)
      : msg.id !== undefined && typeof msg.method === 'string'
    if (isRequest) {
      o.adapter.request?.(ctx, msg)
      return
    }
    o.adapter.message(ctx, msg)
  }

  return {
    start(startIo) {
      io = startIo
      Promise.resolve(o.adapter.start(ctx)).catch((e: Error) => ctx.finish(false, e.message))
    },
    line(raw) {
      let msg: any
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      handle(msg)
    },
    handle,
    steer(text) {
      if (ended) return Promise.resolve(false)
      return o.adapter.steer(ctx, text)
    },
    interrupt() {
      if (ended) return false
      return o.adapter.interrupt(ctx)
    },
    close() {
      o.adapter.close?.(ctx)
      end()
    },
    get finished() {
      return finished
    },
  }
}
