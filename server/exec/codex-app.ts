import path from 'node:path'
import type { BuildOptions } from '../../shared/clis.ts'
import { codexUsage, oneLine, type CliEvent } from './parsers.ts'

/**
 * Codex 用 `codex app-server`（stdin / stdout 上的 JSON-RPC）执行：`codex exec --json` 只在每一项完成时输出整段文字，
 * 看不到流式输出和实时用量；app-server 会逐字推送回复、推理摘要、token 用量和计划。
 *
 * 流程：initialize → thread/start（续接时 thread/resume）→ turn/start → 收通知直到 turn/completed，然后关掉 stdin 让它退出。
 */
export function codexAppSession(o: BuildOptions & { cwd: string; input: string }) {
  let io: { write: (s: string) => void; end: () => void } | undefined
  let thread = ''
  let finished = false
  // 回复和推理摘要是否已经流式输出过：输出过的在 item/completed 时不再重复整段
  const streamed = new Set<string>()
  let textSeen = false
  let thinkingSeen = false
  // 用量按累计值做差，重复推送不会算两遍
  let prevTotal: Record<string, number> | undefined
  const send = (m: object) => io?.write(JSON.stringify(m) + '\n')
  const sandbox = o.permission === 'danger-full-access' ? 'danger-full-access' : o.permission || 'workspace-write'
  const overrides = {
    cwd: o.cwd,
    model: o.model || undefined,
    // 面板里没法逐条审批，和 codex exec 一样不询问：越过沙箱的操作直接失败，由模型自己换办法
    approvalPolicy: 'never',
    sandbox,
    developerInstructions: o.systemPrompt || undefined,
  }

  const finish = (ok: boolean, error?: string): CliEvent[] => {
    if (finished) return []
    finished = true
    // 关掉 stdin，app-server 读到 EOF 就会退出
    setTimeout(() => io?.end(), 0)
    return [{ type: 'result', ok, error }]
  }

  function onResponse(m: any): CliEvent[] {
    if (m.id === 1) {
      send({ method: 'initialized' })
      if (o.resume) send({ id: 2, method: 'thread/resume', params: { threadId: o.resume, ...overrides } })
      else send({ id: 2, method: 'thread/start', params: overrides })
      return []
    }
    if (m.id === 2) {
      if (m.error) {
        const msg = String(m.error.message ?? '启动会话失败')
        // 续接失败多半是会话被清理了；带上 thread not found 让上层丢掉旧会话重来
        return [
          { type: 'error', message: o.resume ? `无法续接之前的会话（thread not found）：${msg}` : msg },
          ...finish(false),
        ]
      }
      thread = m.result?.thread?.id ?? o.resume ?? ''
      send({
        id: 3,
        method: 'turn/start',
        params: {
          threadId: thread,
          input: [{ type: 'text', text: o.input, text_elements: [] }],
          effort: o.effort || undefined,
        },
      })
      return thread ? [{ type: 'session', id: thread }] : []
    }
    if (m.id === 3 && m.error) return [{ type: 'error', message: String(m.error.message) }, ...finish(false)]
    return []
  }

  /** app-server 发来的请求：审批一律拒绝（approvalPolicy 已是 never，正常不会来），其余回不支持 */
  function onRequest(m: any) {
    const decline: Record<string, unknown> = {
      'item/commandExecution/requestApproval': { decision: 'decline' },
      'item/fileChange/requestApproval': { decision: 'decline' },
      applyPatchApproval: { decision: 'abort' },
      execCommandApproval: { decision: 'abort' },
    }
    if (decline[m.method]) send({ id: m.id, result: decline[m.method] })
    else send({ id: m.id, error: { code: -32601, message: `面板不支持 ${m.method}` } })
  }

  function onItem(item: any): CliEvent[] {
    switch (item?.type) {
      case 'agentMessage':
        return !streamed.has(item.id) && item.text ? [{ type: 'text', text: item.text }] : []
      case 'reasoning': {
        const parts: string[] = item.summary?.length ? item.summary : (item.content ?? [])
        const text = parts.join('\n\n')
        return !streamed.has(item.id) && text ? [{ type: 'thinking', text: sep('thinking') + text, delta: true }] : []
      }
      case 'commandExecution': {
        const code = item.exitCode
        return [
          {
            type: 'tool',
            tool: {
              kind: 'run',
              label: oneLine(unwrapShell(item.command)),
              detail: item.status === 'declined' ? '被拒绝' : code ? `退出码 ${code}` : '',
            },
          },
        ]
      }
      case 'fileChange':
        return (item.changes ?? []).map((c: any): CliEvent => {
          const p = rel(o.cwd, c.path)
          const { add, del } = diffStat(c.diff)
          const kind = { add: '新建', delete: '删除', update: '修改' }[c.kind?.type as string] ?? ''
          return {
            type: 'tool',
            tool: { kind: 'edit', label: p, detail: add || del ? `+${add} -${del}` : kind },
            file: { path: p, add, del },
          }
        })
      case 'mcpToolCall':
        return [
          { type: 'tool', tool: { kind: 'other', label: `${item.server ?? 'mcp'} · ${item.tool ?? ''}`, detail: '' } },
        ]
      case 'dynamicToolCall':
        return [{ type: 'tool', tool: { kind: 'other', label: String(item.tool ?? '工具'), detail: '' } }]
      case 'webSearch':
        return [{ type: 'tool', tool: { kind: 'search', label: `网页搜索 ${item.query ?? ''}`.trim(), detail: '' } }]
      case 'imageView':
        return [{ type: 'tool', tool: { kind: 'read', label: rel(o.cwd, item.path), detail: '' } }]
      default:
        return []
    }
  }

  // 同一轮里第二段回复 / 推理和前一段之间空一行
  function sep(kind: 'text' | 'thinking') {
    if (kind === 'text') {
      const s = textSeen ? '\n\n' : ''
      textSeen = true
      return s
    }
    const s = thinkingSeen ? '\n\n' : ''
    thinkingSeen = true
    return s
  }

  function onNotification(m: any): CliEvent[] {
    const p = m.params ?? {}
    switch (m.method) {
      case 'item/started':
        // 新的一段回复开始，之前的段落要和它分开
        if (p.item?.type === 'agentMessage' && textSeen) return [{ type: 'text_delta', text: '\n\n' }]
        return []
      case 'item/agentMessage/delta': {
        if (!p.delta) return []
        streamed.add(p.itemId)
        textSeen = true
        return [{ type: 'text_delta', text: p.delta }]
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        if (!p.delta) return []
        const first = !streamed.has(p.itemId)
        streamed.add(p.itemId)
        return [{ type: 'thinking', text: (first ? sep('thinking') : '') + p.delta, delta: true }]
      }
      case 'item/reasoning/summaryPartAdded':
        return streamed.has(p.itemId) ? [{ type: 'thinking', text: '\n\n', delta: true }] : []
      case 'item/completed':
        return onItem(p.item)
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage
        if (!u?.total) return []
        const base = prevTotal ?? minus(u.total, u.last ?? {})
        prevTotal = u.total
        return [codexUsage(minus(u.total, base), u.last ?? u.total, u.modelContextWindow)]
      }
      case 'turn/plan/updated':
        return [
          {
            type: 'todos',
            todos: (p.plan ?? []).map((s: any) => ({
              text: String(s.step ?? ''),
              status: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'running' : 'pending',
            })),
          },
        ]
      case 'model/rerouted':
        return p.toModel ? [{ type: 'usage', model: String(p.toModel) }] : []
      case 'error':
        // 会自动重试的错误不算失败
        return p.willRetry ? [] : [{ type: 'error', message: String(p.error?.message ?? '执行出错') }]
      case 'turn/completed': {
        const t = p.turn ?? {}
        if (t.status === 'completed') return finish(true)
        return finish(false, t.error?.message ?? (t.status === 'interrupted' ? '已中断' : '执行失败'))
      }
      default:
        return []
    }
  }

  return {
    start(w: typeof io) {
      io = w
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-panel', version: '1' } } })
    },
    handle(m: any): CliEvent[] {
      if (m.id !== undefined && m.method) {
        onRequest(m)
        return []
      }
      if (m.id !== undefined) return onResponse(m)
      if (m.method) return onNotification(m)
      return []
    },
    get finished() {
      return finished
    },
  }
}

const minus = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.max(0, (a[k] ?? 0) - (b[k] ?? 0))]))

/** unified diff 的增删行数（不算 ---/+++ 文件头） */
function diffStat(diff: unknown) {
  let add = 0
  let del = 0
  if (typeof diff !== 'string') return { add, del }
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) add++
    else if (l.startsWith('-')) del++
  }
  return { add, del }
}

function unwrapShell(cmd: unknown) {
  const s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '')
  const m = s.match(/^(?:\/bin\/)?(?:ba|z)?sh -l?c ['"]?([\s\S]*?)['"]?$/)
  return m ? m[1] : s
}

function rel(cwd: string, p: unknown) {
  if (typeof p !== 'string' || !p) return ''
  const r = path.isAbsolute(p) ? path.relative(cwd, p) : p
  return (r.startsWith('..') ? p : r).replaceAll('\\', '/')
}
