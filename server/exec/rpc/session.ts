import { t } from '../../../shared/i18n.ts'
import { fmtDuration } from '../../../shared/duration.ts'
import { log } from '../../log.ts'
import type { CliEvent } from '../parsers.ts'
import type { RpcAdapter, RpcContext, RpcIo, RpcRequestOptions } from './types.ts'

/** 初始化、开始一轮、插话这些请求等多久；CLI 正常都是立刻回 */
const REQUEST_TIMEOUT_MS = 15_000

/** 请求等不到回复时，从外面拿进程的状态（会话引擎自己看不到进程） */
export interface RpcDiagnose {
  /** 进程还活着吗；不知道时不实现 */
  alive?: () => boolean
  /** 到目前为止的 stderr */
  stderr?: () => string
}

/**
 * 超时的错误：等了多少秒、进程还在不在、stderr 最后几行。
 * 只报「没有响应」时用户没法判断是自己机器慢、CLI 卡在启动，还是进程已经崩了。
 */
function timeoutError(method: string, ms: number, diagnose?: RpcDiagnose): string {
  const lines = [t('{method} 没有响应（已等 {wait}）', { method, wait: fmtDuration(ms) })]
  const alive = diagnose?.alive?.()
  if (alive !== undefined) lines.push(alive ? t('进程还在运行') : t('进程已经退出'))
  const tail = (diagnose?.stderr?.() ?? '').trim().split('\n').slice(-3).join('\n')
  lines.push(tail ? `${t('stderr 最后几行：')}\n${tail}` : t('stderr 没有输出'))
  return lines.join('\n')
}

export interface RpcSession {
  /** 进程起来后调用：开始握手、开一轮 */
  start: (io: RpcIo) => void
  /** stdout 的一行 */
  line: (raw: string) => void
  /** 已经解析好的消息（测试和复用的入口） */
  handle: (msg: any) => void
  steer: (text: string) => Promise<boolean>
  redirect: (note: string) => Promise<boolean>
  interrupt: () => boolean
  /** 进程结束、或者外层不再需要它了 */
  close: () => void
  readonly finished: boolean
  /** 在等用户的下一条消息（保活中）：CLI 这时没有输出，不算卡住 */
  readonly waiting: boolean
}

/**
 * 一条常驻协议会话的公共部分：stdin/stdout 上的 JSON 行、请求和回复配对、超时、
 * 这一轮结束后的收尾。具体发什么、怎么判断结束由适配器决定。
 *
 * 保活（对话页还开着时）：一轮结束后先不关进程，用 next() 等用户的下一条消息，
 * 交给适配器在同一个进程里开下一轮，不用重启 CLI 再 --resume。
 * next() 返回 null（用户离开了这个对话）才让进程退出。
 */
export function createRpcSession(o: {
  adapter: RpcAdapter
  cwd: string
  input: string
  images?: string[]
  onEvent: (e: CliEvent) => void
  requestTimeoutMs?: number
  /** 超时、进程提前退出时用来补充原因（等了多少秒、进程状态、stderr） */
  diagnose?: RpcDiagnose
  /** 这一轮结束后要不要留着进程等下一句 */
  hold?: () => boolean
  /** 等用户的下一条消息；返回 null 表示用户已经不在这个对话了。不给时不留进程 */
  next?: () => Promise<string | null>
  /**
   * 模型在这一轮里已经调过 wait_user_message 等过下一句了：结束时就不用再保活一次，
   * 否则用户发来的那句话会被等两遍
   */
  waited?: () => boolean
}): RpcSession {
  let io: RpcIo | undefined
  let nextId = 1
  let finished = false
  let ended = false
  let endTimer: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<string | number, (msg: any) => void>()
  /** 保活期间在等用户下一句：CLI 这时本来就没有输出，不算卡住 */
  let waiting = false

  const send = (record: Record<string, unknown>) => {
    if (ended || !io) return
    io.write(JSON.stringify(record) + '\n')
  }

  /** 结束进程：先按协议让它自己退出（会话记录完整），再关 stdin */
  const end = () => {
    if (ended) return
    o.adapter.exit?.(ctx)
    ended = true
    waiting = false
    clearTimeout(endTimer)
    endTimer = undefined
    for (const resolve of pending.values()) resolve({ error: { message: t('已关闭') } })
    pending.clear()
    io?.end()
  }

  /** 保活：这一轮结束后等用户下一句，有就同一进程开下一轮 */
  const keepAlive = async () => {
    if (ended || !o.next) return false
    waiting = true
    let text: string | null = null
    try {
      text = await o.next()
    } catch (e) {
      // 等下一句时出错（任务被删、服务在退出）：按离开处理，正常结束进程
      log.warn('rpc', '保活时等下一句出错', e)
    } finally {
      waiting = false
    }
    if (ended) return false
    if (text === null || !o.adapter.next) {
      end()
      return false
    }
    finished = false
    Promise.resolve(o.adapter.next(ctx, text)).catch((e: Error) => void ctx.finish(false, e.message))
    return true
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
      const timeoutMs = options?.timeoutMs ?? o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
      return new Promise<any>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({
            error: { message: timeoutError(String(record.method ?? record.type ?? ''), timeoutMs, o.diagnose) },
          })
        }, timeoutMs)
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
    async finish(ok, error, delayMs = 0) {
      // 已经关掉了：还挂着的请求是 end() 里用「已关闭」结束的，别再报一次结果
      if (ended) return false
      finished = true
      o.onEvent({ type: 'result', ok, error })
      clearTimeout(endTimer)
      endTimer = undefined
      if (o.adapter.next && o.next && !o.waited?.() && o.hold?.()) return keepAlive()
      if (delayMs > 0) endTimer = setTimeout(end, delayMs)
      else end()
      return false
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
      Promise.resolve(o.adapter.start(ctx)).catch((e: Error) => void ctx.finish(false, e.message))
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
    redirect(note) {
      if (ended || !o.adapter.redirect) return Promise.resolve(false)
      return o.adapter.redirect(ctx, note)
    },
    interrupt() {
      if (ended) return false
      return o.adapter.interrupt(ctx)
    },
    close() {
      end()
    },
    get finished() {
      return finished
    },
    get waiting() {
      return waiting
    },
  }
}
