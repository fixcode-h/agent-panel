import path from 'node:path'
import type { ToolUse } from '../../shared/schema.ts'

/** 各 CLI 的输出统一成这几种事件 */
export type CliEvent =
  | { type: 'session'; id: string }
  | { type: 'text_delta'; text: string }
  /** 一整段文字（没有流式增量时使用） */
  | { type: 'text'; text: string }
  /** 思考过程：Claude 是增量，Codex 是一段段的推理摘要 */
  | { type: 'thinking'; text: string; delta?: boolean }
  | { type: 'tool'; tool: ToolUse; file?: { path: string; add: number; del: number } }
  | { type: 'usage'; context?: number; model?: string; addInput?: number; addOutput?: number; addCost?: number }
  | { type: 'error'; message: string }
  | { type: 'result'; ok: boolean; error?: string }

export type Parser = (obj: any) => CliEvent[]

/** 文本的行数（末尾换行不算多一行） */
export const lines = (s: unknown) =>
  typeof s === 'string' && s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0
const oneLine = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function rel(cwd: string, p: unknown) {
  if (typeof p !== 'string' || !p) return ''
  const r = path.isAbsolute(p) ? path.relative(cwd, p) : p
  return (r.startsWith('..') ? p : r).replaceAll('\\', '/')
}

// ---- Claude Code：--output-format stream-json --verbose --include-partial-messages ----
function claudeTool(name: string, input: any, cwd: string): CliEvent {
  const file = rel(cwd, input?.file_path ?? input?.notebook_path ?? input?.path)
  switch (name) {
    case 'Read':
      return { type: 'tool', tool: { kind: 'read', label: file, detail: '' } }
    case 'Write': {
      const add = lines(input?.content)
      return { type: 'tool', tool: { kind: 'edit', label: file, detail: `+${add}` }, file: { path: file, add, del: 0 } }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const edits: any[] = input?.edits ?? [input]
      const add = edits.reduce((n, e) => n + lines(e?.new_string ?? e?.new_source), 0)
      const del = edits.reduce((n, e) => n + lines(e?.old_string), 0)
      return {
        type: 'tool',
        tool: { kind: 'edit', label: file, detail: `+${add} -${del}` },
        file: { path: file, add, del },
      }
    }
    case 'Bash':
      return { type: 'tool', tool: { kind: 'run', label: oneLine(String(input?.command ?? '')), detail: '' } }
    case 'Grep':
    case 'Glob':
      return {
        type: 'tool',
        tool: { kind: 'search', label: `${name === 'Grep' ? '搜索' : '查找文件'} ${input?.pattern ?? ''}`, detail: '' },
      }
    case 'WebSearch':
      return { type: 'tool', tool: { kind: 'search', label: `网页搜索 ${input?.query ?? ''}`, detail: '' } }
    case 'WebFetch':
      return { type: 'tool', tool: { kind: 'read', label: String(input?.url ?? ''), detail: '' } }
    case 'TodoWrite':
      return { type: 'tool', tool: { kind: 'other', label: '更新待办清单', detail: `${input?.todos?.length ?? 0} 项` } }
    case 'Task':
    case 'Agent':
      return {
        type: 'tool',
        tool: { kind: 'other', label: `子任务：${input?.description ?? ''}`, detail: input?.subagent_type ?? '' },
      }
    default:
      return { type: 'tool', tool: { kind: 'other', label: name, detail: '' } }
  }
}

export function claudeParser(cwd: string): Parser {
  let msgId = ''
  const streamed = new Set<string>()
  let textInMsg = false
  return (o) => {
    const out: CliEvent[] = []
    if (o.type === 'system' && o.subtype === 'init' && o.session_id) {
      out.push({ type: 'session', id: o.session_id })
      if (o.model) out.push({ type: 'usage', model: o.model })
    } else if (o.type === 'stream_event') {
      const e = o.event ?? {}
      if (e.type === 'message_start') {
        msgId = e.message?.id ?? ''
        textInMsg = false
        const u = e.message?.usage
        if (u)
          out.push({
            type: 'usage',
            context: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            model: e.message?.model,
          })
      } else if (e.type === 'content_block_start' && e.content_block?.type === 'text' && textInMsg) {
        out.push({ type: 'text_delta', text: '\n\n' })
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
        out.push({ type: 'thinking', text: e.delta.thinking ?? '', delta: true })
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        streamed.add(msgId)
        textInMsg = true
        out.push({ type: 'text_delta', text: e.delta.text ?? '' })
      }
    } else if (o.type === 'assistant' && o.message) {
      const id = o.message.id ?? ''
      for (const b of o.message.content ?? []) {
        if (b.type === 'text' && b.text && !streamed.has(id)) out.push({ type: 'text', text: b.text })
        if (b.type === 'tool_use') out.push(claudeTool(b.name, b.input, cwd))
      }
    } else if (o.type === 'result' || (o.total_cost_usd !== undefined && o.usage)) {
      const u = o.usage ?? {}
      out.push({
        type: 'usage',
        addInput: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        addOutput: u.output_tokens ?? 0,
        addCost: o.total_cost_usd ?? 0,
      })
      if (o.session_id) out.push({ type: 'session', id: o.session_id })
      const ok = !o.is_error && (o.subtype === undefined || o.subtype === 'success')
      out.push({
        type: 'result',
        ok,
        error: ok ? undefined : String(o.result || o.errors?.join('\n') || o.subtype || '执行失败'),
      })
    }
    return out
  }
}

// ---- Codex：codex exec --json ----
const unwrapShell = (cmd: unknown) => {
  const s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '')
  const m = s.match(/^(?:\/bin\/)?(?:ba|z)?sh -l?c ['"]?([\s\S]*?)['"]?$/)
  return m ? m[1] : s
}

export function codexParser(cwd: string): Parser {
  return (o) => {
    const out: CliEvent[] = []
    const item = o.item ?? {}
    const type = item.type ?? item.item_type
    if (o.type === 'thread.started' && o.thread_id) out.push({ type: 'session', id: o.thread_id })
    else if (o.type === 'item.completed') {
      if ((type === 'agent_message' || type === 'assistant_message') && item.text)
        out.push({ type: 'text', text: item.text })
      else if (type === 'reasoning' && item.text) out.push({ type: 'thinking', text: item.text })
      else if (type === 'command_execution') {
        const code = item.exit_code
        out.push({
          type: 'tool',
          tool: { kind: 'run', label: oneLine(unwrapShell(item.command)), detail: code ? `退出码 ${code}` : '' },
        })
      } else if (type === 'file_change') {
        for (const c of item.changes ?? []) {
          const p = rel(cwd, c.path)
          const kind = { add: '新建', delete: '删除', update: '修改' }[c.kind as string] ?? ''
          out.push({ type: 'tool', tool: { kind: 'edit', label: p, detail: kind }, file: { path: p, add: 0, del: 0 } })
        }
      } else if (type === 'mcp_tool_call')
        out.push({
          type: 'tool',
          tool: { kind: 'other', label: `${item.server ?? 'mcp'} · ${item.tool ?? ''}`, detail: '' },
        })
      else if (type === 'web_search')
        out.push({ type: 'tool', tool: { kind: 'search', label: `网页搜索 ${item.query ?? ''}`, detail: '' } })
      else if (type === 'error' && item.message) out.push({ type: 'error', message: item.message })
    } else if (o.type === 'turn.completed' && o.usage) {
      const u = o.usage
      out.push({
        type: 'usage',
        context: u.input_tokens ?? 0,
        addInput: u.input_tokens ?? 0,
        addOutput: u.output_tokens ?? 0,
      })
    } else if (o.type === 'turn.failed') out.push({ type: 'error', message: o.error?.message ?? '执行失败' })
    else if (o.type === 'error' && o.message) out.push({ type: 'error', message: o.message })
    return out
  }
}

// ---- Command Code：cmdc -p --output-format json（NDJSON 事件流 + 最后一行结果） ----
function genericTool(name: string, input: any, cwd: string): CliEvent {
  const n = name.toLowerCase()
  const file = rel(cwd, input?.path ?? input?.file_path ?? input?.filePath ?? input?.file)
  if (/write|edit|patch|replace|create_file/.test(n)) {
    const add = lines(input?.content ?? input?.new_string ?? input?.newString ?? input?.new_str)
    const del = lines(input?.old_string ?? input?.oldString ?? input?.old_str)
    return {
      type: 'tool',
      tool: { kind: 'edit', label: file || name, detail: add || del ? `+${add} -${del}` : '' },
      file: file ? { path: file, add, del } : undefined,
    }
  }
  if (/read|view|cat|open/.test(n)) return { type: 'tool', tool: { kind: 'read', label: file || name, detail: '' } }
  if (/bash|shell|exec|command|terminal|run/.test(n))
    return {
      type: 'tool',
      tool: { kind: 'run', label: oneLine(String(input?.command ?? input?.cmd ?? name)), detail: '' },
    }
  if (/grep|glob|search|find|list|ls/.test(n))
    return {
      type: 'tool',
      tool: { kind: 'search', label: `${name} ${input?.pattern ?? input?.query ?? file ?? ''}`.trim(), detail: '' },
    }
  return { type: 'tool', tool: { kind: 'other', label: name, detail: '' } }
}

export function commandCodeParser(cwd: string): Parser {
  let deltas = false
  return (o) => {
    const out: CliEvent[] = []
    if (o.type === 'event' && o.event) {
      const e = o.event
      if (e.type === 'run_start' && e.sessionId) out.push({ type: 'session', id: e.sessionId })
      else if (e.type === 'message_start') deltas = false
      else if (e.type === 'text_delta' && typeof e.delta === 'string') {
        deltas = true
        out.push({ type: 'text_delta', text: e.delta })
      } else if (e.type === 'message_end') {
        const text = (e.content ?? [])
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text)
          .join('\n\n')
        if (!deltas && text) out.push({ type: 'text', text })
        else if (deltas) out.push({ type: 'text_delta', text: '\n\n' })
        deltas = false
      } else if (e.type === 'tool_queued') out.push(genericTool(String(e.toolName ?? 'tool'), e.input, cwd))
      else if (e.type === 'model_request_end' && e.usage) {
        const u = e.usage
        const input = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
        out.push({ type: 'usage', context: input, model: e.model, addInput: input, addOutput: u.outputTokens ?? 0 })
      } else if (e.type === 'notice' && e.level === 'warning') out.push({ type: 'error', message: e.message })
      else if (e.type === 'run_error')
        out.push({ type: 'error', message: e.error?.message ?? String(e.error ?? '执行失败') })
    } else if (o.type === 'result') {
      if (o.sessionId) out.push({ type: 'session', id: o.sessionId })
      const ok = o.subtype === 'success'
      out.push({ type: 'result', ok, error: ok ? undefined : String(o.error || o.subtype) })
    }
    return out
  }
}

export function parserFor(cliId: string, cwd: string): Parser {
  if (cliId === 'claude') return claudeParser(cwd)
  if (cliId === 'codex') return codexParser(cwd)
  return commandCodeParser(cwd)
}
