import { t } from '../../../shared/i18n.ts'
import type { RpcAction } from '../../../shared/cli-spec.ts'
import { runProcess } from '../process.ts'
import { createRpcSession } from './session.ts'
import type { RpcAdapter, RpcContext } from './types.ts'

/**
 * 只问几句、不跑任务的 RPC 查询（额度、Skill 列表）。
 * 和任务执行共用同一条会话引擎：握手、请求/回复配对、超时和收尾都一样。
 */
export async function rpcQuery(o: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  handshake: RpcAction[]
  jsonrpc?: boolean
  requests: { method: string; params: object; timeoutMs?: number }[]
  timeoutMs?: number
}): Promise<any[]> {
  const results: any[] = []
  let error = ''
  const record = (action: RpcAction) =>
    action.record
      ? (action.record as Record<string, unknown>)
      : {
          ...(o.jsonrpc ? { jsonrpc: '2.0' } : {}),
          method: action.method ?? '',
          params: action.params ?? {},
        }
  const adapter: RpcAdapter = {
    async start(ctx: RpcContext) {
      for (const action of o.handshake) {
        if (action.if) continue
        const msg = record(action)
        if (action.notify) {
          ctx.send(msg)
          continue
        }
        const r = await ctx.request(msg)
        if (r?.error) {
          error = String(r.error.message ?? '')
          return ctx.finish(false, error)
        }
      }
      for (const q of o.requests) {
        // 每个请求的原样回复都交回去：有的查询允许个别接口报错（旧版本的 Codex 不认 account/read）
        const { timeoutMs, ...req } = q
        results.push(await ctx.request({ ...req, ...(o.jsonrpc ? { jsonrpc: '2.0' } : {}) }, { timeoutMs }))
      }
      ctx.finish(true)
    },
    message() {},
    steer: async () => false,
    interrupt: () => false,
  }
  const session = createRpcSession({
    adapter,
    cwd: o.cwd,
    input: '',
    onEvent: () => {},
    requestTimeoutMs: o.timeoutMs ?? 20_000,
  })
  const r = await runProcess({
    command: o.command,
    args: o.args,
    cwd: o.cwd,
    env: o.env,
    signal: undefined,
    timeoutMs: o.timeoutMs ?? 20_000,
    onSpawn: (io) => session.start(io),
    onLine: (line) => session.line(line),
  })
  if (results.length < o.requests.length) {
    if (r.spawnError) throw new Error(r.spawnError)
    throw new Error(error || r.stderr.trim().split('\n').at(-1) || t('Codex 没有返回'))
  }
  return results
}
