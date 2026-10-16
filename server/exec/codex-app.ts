import path from 'node:path'
import type { BuildOptions } from '../../shared/clis.ts'
import { clipDetail, codexUsage, oneLine, toolText, type CliEvent } from './parsers.ts'

/**
 * Codex 用 `codex app-server`（stdin / stdout 上的 JSON-RPC）执行：`codex exec --json` 只在每一项完成时输出整段文字，
 * 看不到流式输出和实时用量；app-server 会逐字推送回复、推理摘要、token 用量和计划。
 *
 * 流程：initialize → thread/start（续接时 thread/resume）→ turn/start → 收通知直到 turn/completed，然后关掉 stdin 让它退出。
 */
export function codexAppSession(o: BuildOptions & { cwd: string; input: string; platform?: string }) {
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
    // 需要越过沙箱时由 Codex 发来审批请求，任务页上弹出让用户确认；完全访问时不会有审批
    approvalPolicy: sandbox === 'danger-full-access' ? 'never' : 'on-request',
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

  const startThread = () => {
    if (o.resume) send({ id: 2, method: 'thread/resume', params: { threadId: o.resume, ...overrides } })
    else send({ id: 2, method: 'thread/start', params: overrides })
  }
  // Windows 上沙箱要先初始化一次（Codex 自己的界面会弹提示），没初始化时每条命令都报 helper_unknown_error
  const needsWinSandbox = (o.platform ?? process.platform) === 'win32' && sandbox !== 'danger-full-access'
  const sandboxFailed = (why: string): CliEvent[] => [
    {
      type: 'error',
      message: `Codex 的 Windows 沙箱初始化失败（${why}），命令和改文件都无法执行。可以在终端里运行一次 codex 按提示完成沙箱设置，或在设置里把 Codex 的权限改成「完全访问」。`,
    },
    ...finish(false),
  ]

  function onResponse(m: any): CliEvent[] {
    if (m.id === 1) {
      send({ method: 'initialized' })
      if (needsWinSandbox) send({ id: 10, method: 'windowsSandbox/readiness', params: {} })
      else startThread()
      return []
    }
    if (m.id === 10) {
      // 旧版本没有这个接口，直接开始
      if (m.error || m.result?.status === 'ready') startThread()
      // 用不需要管理员权限的方式初始化，不会弹出系统授权框；完成后会收到 windowsSandbox/setupCompleted
      else send({ id: 11, method: 'windowsSandbox/setupStart', params: { mode: 'unelevated', cwd: o.cwd } })
      return []
    }
    if (m.id === 11) {
      if (m.error) return sandboxFailed(String(m.error.message ?? '未知错误'))
      if (m.result?.started === false) startThread()
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

  /** app-server 发来的请求：命令和改文件的审批交给用户确认，其余回不支持 */
  function onRequest(m: any): CliEvent[] {
    const p = m.params ?? {}
    const answer = (result: unknown) => send({ id: m.id, result })
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'execCommandApproval') {
      const legacy = m.method === 'execCommandApproval'
      const cmd = unwrapShell(p.command ?? '')
      return [
        {
          type: 'ask',
          kind: 'command',
          title: cmd ? `运行命令：${oneLine(cmd)}` : '运行一条需要越过沙箱的命令',
          detail: [p.reason, cmd && clipDetail(cmd), p.cwd && `目录：${p.cwd}`].filter(Boolean).join('\n\n'),
          reply: (r) =>
            answer({ decision: legacy ? (r.allow ? 'approved' : 'denied') : r.allow ? 'accept' : 'decline' }),
        },
      ]
    }
    if (m.method === 'item/fileChange/requestApproval' || m.method === 'applyPatchApproval') {
      const legacy = m.method === 'applyPatchApproval'
      return [
        {
          type: 'ask',
          kind: 'file',
          title: p.grantRoot ? `允许写入目录：${p.grantRoot}` : '修改沙箱以外的文件',
          detail: String(p.reason ?? ''),
          reply: (r) =>
            answer({ decision: legacy ? (r.allow ? 'approved' : 'denied') : r.allow ? 'accept' : 'decline' }),
        },
      ]
    }
    // 沙箱里要额外的权限（联网、写沙箱外的目录）：同意就按请求的范围给这一轮，拒绝就一项都不给
    if (m.method === 'item/permissions/requestApproval') {
      const want = p.permissions ?? {}
      const fsPaths = [...(want.fileSystem?.write ?? []), ...(want.fileSystem?.read ?? [])].map(String)
      const what = [want.network?.enabled && '联网', fsPaths.length && `访问 ${fsPaths.join('、')}`].filter(Boolean)
      return [
        {
          type: 'ask',
          kind: 'command',
          title: `需要额外权限：${what.join('，') || '越过沙箱'}`,
          detail: String(p.reason ?? ''),
          reply: (r) => answer(r.allow ? { permissions: want, scope: 'turn' } : { permissions: {} }),
        },
      ]
    }
    send({ id: m.id, error: { code: -32601, message: `面板不支持 ${m.method}` } })
    return []
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
        const cmd = unwrapShell(item.command)
        const failed = item.status === 'failed' || item.status === 'declined' || (code !== null && code !== 0)
        return [
          {
            type: 'tool',
            tool: {
              kind: 'run',
              label: oneLine(cmd),
              detail: item.status === 'declined' ? '被拒绝' : code ? `退出码 ${code}` : '',
              input: clipDetail(cmd),
              output: item.aggregatedOutput ? clipDetail(String(item.aggregatedOutput)) : undefined,
              failed: failed || undefined,
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
            tool: {
              kind: 'edit',
              name: c.kind?.type === 'add' ? '写入' : c.kind?.type === 'delete' ? '删除' : undefined,
              label: p,
              detail: add || del ? `+${add} -${del}` : kind,
              input: c.diff ? clipDetail(String(c.diff)) : undefined,
              failed: item.status === 'failed' || item.status === 'declined' || undefined,
            },
            file: { path: p, add, del },
          }
        })
      case 'mcpToolCall':
        return [
          {
            type: 'tool',
            tool: {
              kind: 'other',
              name: 'MCP',
              label: `${item.server ?? 'mcp'} · ${item.tool ?? ''}`,
              detail: item.error ? '失败' : '',
              input: item.arguments ? clipDetail(JSON.stringify(item.arguments, null, 2)) : undefined,
              output: item.error
                ? clipDetail(toolText(item.error.message ?? item.error))
                : item.result
                  ? clipDetail(toolText(item.result.content ?? item.result))
                  : undefined,
              failed: !!item.error || undefined,
            },
          },
        ]
      case 'dynamicToolCall':
        return [
          {
            type: 'tool',
            tool: {
              kind: 'other',
              name: String(item.tool ?? '工具'),
              label: '',
              detail: '',
              input: item.arguments ? clipDetail(JSON.stringify(item.arguments, null, 2)) : undefined,
              output: item.contentItems ? clipDetail(toolText(item.contentItems)) : undefined,
              failed: item.success === false || undefined,
            },
          },
        ]
      case 'webSearch':
        return [{ type: 'tool', tool: { kind: 'web', name: '网页搜索', label: String(item.query ?? ''), detail: '' } }]
      case 'imageView':
        return [{ type: 'tool', tool: { kind: 'read', name: '查看图片', label: rel(o.cwd, item.path), detail: '' } }]
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
      case 'windowsSandbox/setupCompleted':
        if (thread || finished) return []
        if (m.params?.success === false) return sandboxFailed(String(m.params?.error ?? '未知错误'))
        startThread()
        return []
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
      if (m.id !== undefined && m.method) return onRequest(m)
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

/**
 * 去掉外面包的一层 shell，只留真正的命令：bash -lc '…'、Windows 上的 "…\\cmd.exe" /c "…"、
 * "…\\powershell.exe" -Command '…'（可能套好几层）
 */
export function unwrapShell(cmd: unknown) {
  let s = (Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '')).trim()
  const shells = [
    /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/,
    /^"?(?:[^"\s]*[\\/])?cmd(?:\.exe)?"?\s+\/[cCkK]\s+([\s\S]+)$/i,
    /^"?(?:[^"\s]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?:\s+-(?:NoProfile|NonInteractive|NoLogo|ExecutionPolicy\s+\S+))*\s+-(?:Command|c)\s+([\s\S]+)$/i,
  ]
  for (let i = 0; i < 5; i++) {
    const m = shells.map((r) => s.match(r)).find(Boolean)
    if (!m) break
    s = m[1].trim()
    // 去掉整体包着的一层引号
    if (s.length > 1 && (s[0] === '"' || s[0] === "'") && s.endsWith(s[0])) s = s.slice(1, -1)
  }
  // 命令里的路径在 JSON 里转义成了 \\，显示时还原
  return s.replace(/\\\\/g, '\\')
}

function rel(cwd: string, p: unknown) {
  if (typeof p !== 'string' || !p) return ''
  const r = path.isAbsolute(p) ? path.relative(cwd, p) : p
  return (r.startsWith('..') ? p : r).replaceAll('\\', '/')
}
