/**
 * 面板自己当 MCP 客户端连别家的服务（能力路由代 Agent 调 IDEA 的 lua_code、VS 的 UEToVS，设计稿：统一查找方式 第 3.3 节）。
 *
 * 一个会话 = 握手一次、之后按需 request：
 * - http：Streamable HTTP，带 mcp-session-id；回答可能是 SSE，取 id 对得上的那条；
 * - stdio：起一个常驻进程（runProcess 的 keepStdinOpen，面板统一的进程入口），一行一条 JSON-RPC，按 id 对回答。
 *
 * 连接由 pool.ts 按「服务 + 目录」复用、空闲一段时间关掉：UEToVS 这类 stdio 服务每次起要读一遍磁盘索引，每查一次起一次太慢
 */
import type { McpServer } from '../../shared/library.ts'
import { childEnv, runProcess } from '../exec/process.ts'

const INIT = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'agent-panel', version: '1' },
}

export interface McpSession {
  /** 发一个请求，等 id 对得上的回答；服务报错时抛出它的原话 */
  request(method: string, params: object, timeoutMs?: number): Promise<any>
  /** 服务的自我介绍（initialize 的 serverInfo.name） */
  serverName?: string
  alive(): boolean
  close(): void
}

/** MCP 的 tools/call 结果：拼好的文字和是否出错 */
export interface McpCallResult {
  text: string
  isError: boolean
}

export function callResultOf(r: any): McpCallResult {
  const text = (Array.isArray(r?.content) ? r.content : [])
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n')
  return { text, isError: r?.isError === true }
}

async function openHttp(sv: McpServer): Promise<McpSession> {
  let session = ''
  let id = 0
  let closed = false
  const post = async (body: Record<string, unknown>, timeoutMs: number) => {
    const res = await fetch(sv.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session && { 'mcp-session-id': session }),
        ...sv.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    session = res.headers.get('mcp-session-id') ?? session
    const text = await res.text()
    if (!('id' in body)) return null
    const msgs = res.headers.get('content-type')?.includes('event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)]
    const m = msgs.find((x) => x.id === body.id)
    if (m?.error) throw new Error(String(m.error.message ?? 'error'))
    return m?.result
  }
  const request = (method: string, params: object, timeoutMs = 15_000) =>
    post({ jsonrpc: '2.0', id: ++id, method, params }, timeoutMs)
  const init = await request('initialize', INIT)
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 15_000)
  return {
    request,
    serverName: init?.serverInfo?.name,
    alive: () => !closed,
    close: () => {
      closed = true
    },
  }
}

async function openStdio(sv: McpServer, cwd: string): Promise<McpSession> {
  const ac = new AbortController()
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>()
  let write: ((s: string) => void) | undefined
  let exited = false
  let lastErr = ''
  let id = 0
  const ready = new Promise<void>((resolve) => {
    void runProcess({
      command: sv.command,
      args: sv.args,
      cwd,
      env: childEnv(Object.entries(sv.env).map(([key, value]) => ({ key, value }))),
      signal: ac.signal,
      keepStdinOpen: true,
      onSpawn: (io) => {
        write = io.write
        resolve()
      },
      onStderr: (s) => {
        lastErr = s.trim().split('\n').at(-1) ?? lastErr
      },
      onLine: (l) => {
        let m: any
        try {
          m = JSON.parse(l)
        } catch {
          return
        }
        if (typeof m?.id !== 'number' || m.method) return
        const w = waiting.get(m.id)
        if (!w) return
        waiting.delete(m.id)
        if (m.error) w.fail(new Error(String(m.error.message ?? 'error')))
        else w.ok(m.result ?? null)
      },
    }).then((r) => {
      exited = true
      const why = r.spawnError || lastErr || '服务进程退出了'
      for (const w of waiting.values()) w.fail(new Error(why))
      waiting.clear()
      resolve()
    })
  })
  await ready
  const request = (method: string, params: object, timeoutMs = 15_000) =>
    new Promise<any>((ok, fail) => {
      if (exited || !write) return fail(new Error(lastErr || '服务进程没起来'))
      const n = ++id
      const timer = setTimeout(() => {
        waiting.delete(n)
        fail(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒没有回应`))
      }, timeoutMs)
      waiting.set(n, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      })
      write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    })
  const init = await request('initialize', INIT, 20_000)
  write!(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return {
    request,
    serverName: init?.serverInfo?.name,
    alive: () => !exited,
    close: () => ac.abort(),
  }
}

/** 连上一个服务并握手；连不上抛出原因 */
export function openMcp(sv: McpServer, cwd: string): Promise<McpSession> {
  return sv.transport === 'http' ? openHttp(sv) : openStdio(sv, cwd)
}
