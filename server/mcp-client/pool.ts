/**
 * 别家 MCP 服务的连接池：按「服务配置 + 启动目录」复用一个会话，空闲 5 分钟关掉；连接断了、调用报连接错时丢掉，下次重连。
 * 能力路由代 Agent 调外部工具都从这里走（server/capability-router/external.ts），不各自握手
 */
import { createHash } from 'node:crypto'
import type { McpServer } from '../../shared/library.ts'
import { log } from '../log.ts'
import { callResultOf, openMcp, type McpCallResult, type McpSession } from './session.ts'

const IDLE_MS = 5 * 60_000

interface Slot {
  session: Promise<McpSession>
  timer?: ReturnType<typeof setTimeout>
}

const slots = new Map<string, Slot>() // 模块状态：常驻连接池，进程内共用

const keyOf = (sv: McpServer, cwd: string) =>
  createHash('sha1')
    .update(
      JSON.stringify([
        sv.transport,
        sv.command,
        sv.args,
        sv.env,
        sv.url,
        sv.headers,
        sv.transport === 'stdio' ? cwd : '',
      ]),
    )
    .digest('hex')

function drop(key: string) {
  const s = slots.get(key)
  if (!s) return
  slots.delete(key)
  clearTimeout(s.timer)
  void s.session.then((x) => x.close()).catch(() => {})
}

function touch(key: string) {
  const s = slots.get(key)
  if (!s) return
  clearTimeout(s.timer)
  s.timer = setTimeout(() => drop(key), IDLE_MS)
  s.timer.unref?.()
}

async function sessionFor(sv: McpServer, cwd: string): Promise<{ key: string; s: McpSession }> {
  const key = keyOf(sv, cwd)
  let slot = slots.get(key)
  if (slot) {
    const s = await slot.session.catch(() => undefined)
    if (s?.alive()) {
      touch(key)
      return { key, s }
    }
    drop(key)
  }
  slot = { session: openMcp(sv, cwd) }
  slots.set(key, slot)
  try {
    const s = await slot.session
    touch(key)
    return { key, s }
  } catch (e) {
    drop(key)
    throw e
  }
}

/** 调一个工具；连不上、断了抛出原因（调用方按「这条路不可用」往下走） */
export async function callMcpTool(
  sv: McpServer,
  cwd: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 70_000,
): Promise<McpCallResult> {
  const { key, s } = await sessionFor(sv, cwd)
  try {
    return callResultOf(await s.request('tools/call', { name: tool, arguments: args }, timeoutMs))
  } catch (e) {
    // 超时、进程退出、HTTP 错：这个会话不再可信，丢掉下次重连
    log.warn('mcp', `调 ${sv.name} 的 ${tool} 失败`, { error: (e as Error).message })
    drop(key)
    throw e
  }
}

/** 面板退出、测试收尾时关掉全部连接 */
export function closeMcpPool() {
  for (const k of [...slots.keys()]) drop(k)
}
