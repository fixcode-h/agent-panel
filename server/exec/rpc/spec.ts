import type { RpcAction, RpcSpec } from '../../../shared/cli-spec.ts'
import type { BuildOptions } from '../../../shared/clis.ts'
import { t } from '../../../shared/i18n.ts'
import type { Parser } from '../parsers.ts'
import type { RpcAdapter, RpcContext } from './types.ts'

/** 配置里能用的变量：都是普通值，按 {名字} 填进消息 */
export type SpecVars = Record<string, unknown>

export interface SpecAdapterOptions {
  parser: Parser
  cwd: string
  input: string
  model?: string
  effort?: string
  maxTurns?: number
  resume?: string
  fork?: boolean
  images?: string[]
  /** 不是普通的一轮：压缩上下文时按 rpc.compact 发，不发 start */
  op?: BuildOptions['op']
}

const getPath = (obj: any, path: string): any => {
  if (!path) return undefined
  const p = path.startsWith('$.') ? path.slice(2) : path
  return p.split('.').reduce((x, k) => {
    if (x == null) return undefined
    return Array.isArray(x) && /^-\d+$/.test(k) ? x.at(Number(k)) : x[k]
  }, obj)
}

/** 把 {input}、{maxTurns} 这些占位换成实际值；整条就是占位且没值时，这个字段直接不要 */
function fill(value: unknown, vars: SpecVars): unknown {
  if (typeof value === 'string') {
    const one = /^\{(\w+)\}$/.exec(value)
    if (one) return vars[one[1]]
    return value.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = vars[k]
      return v === undefined || v === null ? '' : String(v)
    })
  }
  if (Array.isArray(value)) return value.map((x) => fill(x, vars)).filter((x) => x !== undefined)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).flatMap(([k, v]) => {
        const got = fill(v, vars)
        return got === undefined ? [] : [[k, got]]
      }),
    )
  return value
}

function holds(cond: string, vars: SpecVars) {
  const m = /^(!?)(\w+)(?:(!?=)(.*))?$/.exec(cond.trim())
  if (!m) return false
  const [, not, key, op, want] = m
  const v = vars[key]
  if (op === '=') return String(v ?? '') === want
  if (op === '!=') return String(v ?? '') !== want
  return not ? !v : !!v
}

const literal = (s: string): unknown => {
  const v = s.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v)
  return v.replace(/^["']|["']$/g, '')
}

function evalExpr(expr: string, msg: any, saved: Record<string, any>): unknown {
  const m = /^([\w.$-]+)\s*(==|!=)\s*(.*)$/.exec(expr.trim())
  const get = (p: string) => (p.startsWith('$.') ? getPath(msg, p) : getPath(saved, p))
  if (!m) return get(expr.trim())
  const got = get(m[1])
  const want = literal(m[3])
  return m[2] === '==' ? got === want : got !== want
}

const matches = (when: Record<string, unknown>, msg: any) =>
  Object.entries(when).every(([k, v]) => getPath(msg, k) === v)

const every = (expr: string | string[] | undefined, msg: any, saved: Record<string, any>) => {
  if (expr === undefined) return true
  return (Array.isArray(expr) ? expr : [expr]).every((x) => !!evalExpr(x, msg, saved))
}

/** 回复里的错误：JSON-RPC 是 error.message，记录流（Pi）是 success: false 加一句 error */
const replyError = (reply: any): string | undefined => {
  if (!reply || (reply.error === undefined && reply.success !== false)) return undefined
  const e = reply.error
  return typeof e === 'string' && e ? e : typeof e?.message === 'string' ? e.message : t('执行失败')
}

const first = (expr: string | string[] | undefined, msg: any, saved: Record<string, any>) => {
  for (const x of expr === undefined ? [] : Array.isArray(expr) ? expr : [expr]) {
    const v = evalExpr(x, msg, saved)
    if (v !== undefined && v !== null && String(v)) return String(v)
  }
  return ''
}

/**
 * 按配置发消息的适配器：标准的 JSON-RPC（Command Code）和按 type 区分的记录流（Pi）
 * 只写配置就能接；协议里有特别的地方时用 codex / claude 适配器。
 */
export function createSpecAdapter(spec: RpcSpec, o: SpecAdapterOptions): RpcAdapter {
  const saved: Record<string, any> = {}
  let last: any
  // 保活时同一进程里会开下一轮，输入换成新的那句
  let input = o.input ?? ''
  const vars = (extra: SpecVars = {}): SpecVars => ({
    input,
    model: o.model,
    effort: o.effort,
    maxTurns: o.maxTurns,
    resume: o.resume,
    cwd: o.cwd,
    fork: o.fork ? true : undefined,
    ...extra,
  })
  const record = (action: RpcAction, extra: SpecVars) => {
    const v = vars(extra)
    if (action.record) return fill(action.record, v) as Record<string, unknown>
    return {
      ...(spec.jsonrpc ? { jsonrpc: '2.0' } : {}),
      method: action.method ?? '',
      params: fill(action.params ?? {}, v) as Record<string, unknown>,
    }
  }
  const run = async (ctx: RpcContext, actions: RpcAction[], extra: SpecVars = {}) => {
    for (const action of actions) {
      if (action.if !== undefined) {
        const conds = Array.isArray(action.if) ? action.if : [action.if]
        if (!conds.every((c) => holds(c, vars(extra)))) continue
      }
      const msg = record(action, extra)
      if (action.notify) {
        ctx.send(msg)
        continue
      }
      const reply = await ctx.request(msg, { timeoutMs: action.timeoutMs }).catch((e: Error) => {
        if (!action.optional) throw e
        return undefined
      })
      const error = replyError(reply)
      if (action.optional && (error || reply === undefined)) continue
      last = reply
      if (action.save) saved[action.save] = reply
      if (error) {
        ctx.finish(false, error)
        return false
      }
      if (action.parse) for (const ev of o.parser(reply)) ctx.emit(ev)
      emitIds(ctx)
    }
    return true
  }
  const idOf = (path: string) => (path ? getPath(saved, path) : undefined)
  let sessionSent = ''
  let turnSent = ''
  // 会话、轮次 id 一拿到就发，后面的输出不用等所有启动步骤走完
  function emitIds(ctx: RpcContext) {
    const session = idOf(spec.sessionId) ?? getPath(last, spec.sessionId)
    if (session && String(session) !== sessionSent) {
      sessionSent = String(session)
      ctx.emit({ type: 'session', id: sessionSent })
    }
    const turn = idOf(spec.turnId) ?? getPath(last, spec.turnId)
    if (turn && String(turn) !== turnSent) {
      turnSent = String(turn)
      ctx.emit({ type: 'turn', id: turnSent })
    }
  }

  const adapter: RpcAdapter = {
    async start(ctx) {
      if (!(await run(ctx, spec.handshake))) return
      // 压缩：续接会话后直接压缩，回复成功就是压缩完了（压缩前后的大小走输出里的压缩事件）
      if (o.op?.kind === 'compact' && spec.compact?.length) {
        if (!(await run(ctx, spec.compact))) return
        emitIds(ctx)
        void ctx.finish(true)
        return
      }
      const actions =
        o.resume && o.fork && spec.fork?.length ? spec.fork : o.resume && spec.resume?.length ? spec.resume : spec.start
      if (!(await run(ctx, actions))) return
      emitIds(ctx)
    },
    message(ctx, msg) {
      for (const r of spec.remember) if (matches(r.when, msg)) saved[r.as] = msg
      const done = spec.done.find((d) => matches(d.when, msg))
      let ok = true
      let error = ''
      if (done) {
        ok = every(done.ok, msg, saved)
        error = first(done.error, msg, saved)
      }
      const event = spec.unwrap ? (getPath(msg, spec.unwrap) ?? msg) : msg
      for (const ev of o.parser(event)) ctx.emit(ev)
      if (!done) return
      // 退出消息等确认真的不用这个进程了再发（见 exit）；保活时进程要留着开下一轮
      const end = () => void ctx.finish(ok, ok ? undefined : error || t('执行失败'), spec.closeDelayMs)
      // 交结果前再问一次（例如准确的上下文占用）；这些请求都是可选的，失败了照常结束
      if (spec.after.length) void run(ctx, spec.after).then(end, end)
      else end()
    },
    request(ctx, msg) {
      const ask = spec.asks.find((a) => matches(a.when, msg))
      // 不用回答的（例如 Pi 扩展的通知、状态栏）当普通记录，按输出映射显示或忽略
      if (!ask) return adapter.message(ctx, msg)
      const field = (v: string) => (v.startsWith('$.') ? getPath(msg, v) : v)
      const options = ask.options ? field(ask.options) : undefined
      ctx.emit({
        type: 'ask',
        kind: ask.kind,
        title: String(field(ask.title) ?? ''),
        detail: String(field(ask.detail) ?? ''),
        ...(Array.isArray(options) && options.length ? { options: options.map(String) } : {}),
        reply: (r) => {
          if (ctx.finished) return
          ctx.send(fill(r.allow ? ask.allow : ask.deny, { id: msg.id, answer: r.answer }) as Record<string, unknown>)
        },
      })
    },
    async next(ctx, text) {
      // 同一进程里开下一轮：会话已经开着，直接按 start 里的步骤把新的那句交过去
      input = text
      turnSent = ''
      if (!(await run(ctx, spec.start))) return
      emitIds(ctx)
    },
    exit(ctx) {
      if (!spec.exit) return
      const exit = record(spec.exit, {})
      if (spec.exit.notify) ctx.send(exit)
      else void ctx.request(exit, { timeoutMs: 3000 })
    },
    async steer(ctx, text) {
      if (!spec.steer) return false
      const msg = record(spec.steer, { text })
      if (spec.steer.notify) {
        ctx.send(msg)
        return true
      }
      const reply = await ctx.request(msg, { timeoutMs: spec.steer.timeoutMs })
      return !reply?.error
    },
    interrupt(ctx) {
      if (!spec.interrupt) return false
      const msg = record(spec.interrupt, {})
      if (spec.interrupt.notify) ctx.send(msg)
      else void ctx.request(msg, { timeoutMs: spec.interrupt.timeoutMs })
      return true
    },
  }
  return adapter
}
