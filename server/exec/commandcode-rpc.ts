/**
 * Command Code 的常驻 JSON-RPC：`cmdc --experimental --rpc`。
 *
 * 和一次性 `-p` 的区别是进程一直开着，一轮执行中还能收到 `turn/steer`：
 * 面板把用户执行中的补充发过去，CLI 在下一个模型请求前取走，不用等整轮结束。
 * 事件格式和 `-p --output-format json` 是同一套，所以解析直接复用 commandCodeParser。
 */
import { t } from '../../shared/i18n.ts'
import { commandCodeParser, type CliEvent } from './parsers.ts'

type Io = { write: (s: string) => void; end: () => void }

/** 初始化、开始一轮、插话这些请求等多久；CLI 正常都是立刻回 */
const REQUEST_TIMEOUT_MS = 15_000

export function commandCodeRpcSession(o: {
  cwd: string
  input: string
  /** 一轮最多多少回合（模型请求次数）；RPC 模式由 turn/start 的参数控制，--max-turns 只对 -p 生效 */
  maxTurns?: number
  onEvent: (e: CliEvent) => void
}) {
  const parse = commandCodeParser(o.cwd)
  let io: Io | undefined
  let nextId = 1
  let turnId = ''
  let done = false
  let finished = false
  const pending = new Map<number, (r: any) => void>()

  const send = (m: object) => io?.write(JSON.stringify(m) + '\n')

  const emit = (events: CliEvent[]) => {
    for (const e of events) {
      if (e.type === 'result') finished = true
      o.onEvent(e)
    }
  }

  const request = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ error: { message: t('{method} 没有响应', { method }) } })
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      send({ jsonrpc: '2.0', id, method, params })
    })

  /** 这一轮结束或出错：先给面板结果，再让 CLI 退出，外层 runProcess 才能结束 */
  const stop = (stopReason: string, error?: unknown) => {
    if (done) return
    done = true
    const ok = stopReason !== 'run_error' && stopReason !== 'interrupted'
    const reason = stopReason === 'interrupted' ? t('已中断') : t('执行失败')
    emit([
      {
        type: 'result',
        ok,
        error: ok ? undefined : String((error as any)?.message ?? error ?? reason),
      },
    ])
    send({ jsonrpc: '2.0', id: nextId++, method: 'session/exit', params: {} })
    setTimeout(() => io?.end(), 0)
  }

  const start = async (i: Io) => {
    io = i
    const init = await request('initialize', {})
    if (init?.error) return stop('run_error', init.error)
    const id = init?.result?.session?.id
    if (id) emit([{ type: 'session', id }])
    const turn = await request('turn/start', {
      input: o.input,
      ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
    })
    if (turn?.error) return stop('run_error', turn.error)
    turnId = String(turn?.result?.turnId ?? '')
  }

  const line = (raw: string) => {
    let m: any
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m?.id !== undefined && pending.has(m.id)) {
      const resolve = pending.get(m.id)!
      pending.delete(m.id)
      resolve(m)
      return
    }
    if (m?.type === 'event') {
      emit(parse(m))
      return
    }
    // 一轮结束：stopReason 是 end_turn / max_turns / run_error / interrupted
    if (m?.method === 'turn/completed') {
      const p = m.params ?? {}
      stop(String(p.stopReason ?? ''), p.error)
    }
  }

  /** 把执行中的补充交给正在跑的这一轮；CLI 报错（例如这一轮刚好结束）时返回 false，外层会排进队列 */
  const steer = async (text: string) => {
    if (done || !turnId) return false
    const r = await request('turn/steer', { input: text })
    return !r?.error
  }

  const interrupt = () => {
    if (done || !turnId) return false
    send({ jsonrpc: '2.0', id: nextId++, method: 'turn/interrupt', params: {} })
    return true
  }

  /** 进程被停掉时别让等响应的请求一直挂着 */
  const close = () => {
    done = true
    for (const resolve of pending.values()) resolve({ error: { message: t('已关闭') } })
    pending.clear()
  }

  return {
    start,
    line,
    steer,
    interrupt,
    close,
    get finished() {
      return finished
    },
  }
}
