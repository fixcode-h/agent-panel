import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { McpStore, type McpProbe } from '../../shared/cli-spec.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { t } from '../../shared/i18n.ts'
import { isPanelMcpUrl } from '../../shared/project-mcp.ts'
import type { Task } from '../../shared/schema.ts'
import { log } from '../log.ts'
import { readServerTable } from '../mcp-store.ts'
import { taskLog } from '../task-log.ts'
import { systemNote } from './recovery.ts'

/**
 * 启动新会话前探测项目里配的远程 MCP（CLI 定义里的 mcpProbe）。
 *
 * Claude Code 用 --mcp-config 接面板的工具、又关了工具搜索时，第一轮前会等所有 MCP 握手完，单个最多 30 秒。
 * 用户项目的 .mcp.json 配了 Unreal 编辑器插件，编辑器主线程正忙着枚举资产，请求收下了没人回，
 * 新对话的首字等了 40 秒，界面上看不出在等什么（用户 2026-11-05 报）。
 * 等多久交给 CLI 自己的开关（定义 env 里的 CLAUDE_CODE_MCP_STARTUP_WAIT_MS）；这里和 CLI 同时探测，
 * 不响应就在对话里写一行警告：用户知道慢在哪、为什么这一轮少了那个服务的工具。只看远程服务，本地命令要起进程，探测代价太大
 */

export interface McpProbeMiss {
  name: string
  url: string
  /** refused：连接被拒或报错；silent：连上了但限定时间内没有回应 */
  kind: 'refused' | 'silent'
  error: string
}

/** 读出项目里 CLI 会连的远程 MCP；文件不存在、读不懂都当没有（CLI 自己会报） */
export async function projectHttpMcp(cwd: string, probe: McpProbe) {
  const store = McpStore.parse({ file: '', format: 'json', key: probe.key })
  const out: { name: string; url: string; headers: Record<string, string> }[] = []
  for (const file of probe.files) {
    const full = path.join(cwd, file)
    if (!existsSync(full)) continue
    try {
      const table = JSON.parse(await readFile(full, 'utf8'))?.[probe.key]
      if (!table || typeof table !== 'object' || Array.isArray(table)) continue
      for (const sv of Object.values(readServerTable(table, store)))
        if (sv.transport === 'http' && sv.url && !isPanelMcpUrl(sv.url))
          out.push({ name: sv.name, url: sv.url, headers: sv.headers })
    } catch {
      continue
    }
  }
  return out
}

/** 发一个 initialize：有任何 HTTP 回应（哪怕 401、404）就算活着，不会让 CLI 干等 */
async function ping(url: string, headers: Record<string, string>, timeoutMs: number) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agent-panel-probe', version: '1' },
    },
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      // 头里的 ${ENV} 占位不展开：探测只看有没有回应，鉴权失败也是回应
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    // 只等响应头：SSE 的服务会一直开着流，不读正文
    void res.body?.cancel().catch(() => {})
    return null
  } catch (e) {
    if (ac.signal.aborted) return { kind: 'silent' as const, error: t('{s} 秒内没有回应', { s: timeoutMs / 1000 }) }
    const err = e as Error & { cause?: { code?: string; message?: string } }
    return { kind: 'refused' as const, error: err.cause?.code || err.cause?.message || err.message }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeProjectMcp(cwd: string, probe: McpProbe): Promise<McpProbeMiss[]> {
  const servers = await projectHttpMcp(cwd, probe)
  const res = await Promise.all(
    servers.map(async (s) => {
      const miss = await ping(s.url, s.headers, probe.timeoutMs)
      return miss && { name: s.name, url: s.url, ...miss }
    }),
  )
  return res.filter((x): x is McpProbeMiss => !!x)
}

/** CLI 第一轮最多等 MCP 几秒：按这次启动实际带的环境变量；没有这个开关或值不对时不说秒数 */
const waitSecs = (probe: McpProbe, env: NodeJS.ProcessEnv) => {
  const ms = probe.waitEnv ? Number(env[probe.waitEnv]) : NaN
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 100) / 10 : undefined
}

export interface WarnSlowMcpOpts {
  task: Task
  cli: string
  probe: McpProbe | undefined
  cwd: string
  env: NodeJS.ProcessEnv
  agentId: string
  step: string
  newId: () => string
  changed: () => void
}

/** 和 CLI 启动同时跑，不等结果；有不响应的服务就写一行警告 */
export function warnSlowMcp(o: WarnSlowMcpOpts) {
  const { probe } = o
  if (!probe?.files.length) return
  void probeProjectMcp(o.cwd, probe)
    .then((miss) => {
      if (!miss.length) return
      const names = miss.map((m) => m.name).join(t('、'))
      const secs = waitSecs(probe, o.env)
      const text =
        secs === undefined
          ? t('项目里的 MCP「{names}」没有响应：{cli} 可能要等它超时才开始这一轮，连上之前用不了它的工具。', {
              names,
              cli: o.cli,
            })
          : t('项目里的 MCP「{names}」没有响应：{cli} 第一轮最多等它 {s} 秒就先开始，连上之前用不了它的工具。', {
              names,
              cli: o.cli,
              s: secs,
            })
      const detail = miss.map((m) => `${m.name}  ${m.url}  ${m.error}`).join('\n')
      o.task.messages.push({
        ...systemNote(o.newId(), o.agentId, o.step, text),
        alert: makeAlert('warn', detail, 'mcp_slow'),
      })
      taskLog(o.task.id, 'MCP 没有响应', { servers: names })
      log.warn('agent', `项目 MCP 没有响应：${names}`, { task: o.task.id })
      o.changed()
    })
    .catch((e) => log.warn('agent', `探测项目 MCP 出错：${(e as Error).message}`, { task: o.task.id }))
}
