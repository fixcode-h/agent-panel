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
  /**
   * 用量。context 是当前上下文占用；add* 是这次新增的 token：输入都按「含缓存」计，缓存命中、缓存写入是输入里的一部分
   */
  | {
      type: 'usage'
      context?: number
      window?: number
      model?: string
      addInput?: number
      addOutput?: number
      addCacheRead?: number
      addCacheWrite?: number
      addCost?: number
    }
  /** CLI 的待办清单 / 计划，每次给出完整列表 */
  | { type: 'todos'; todos: { text: string; status: 'pending' | 'running' | 'done' }[] }
  | { type: 'error'; message: string }
  | { type: 'result'; ok: boolean; error?: string }

export type Parser = (obj: any) => CliEvent[]

/** 文本的行数（末尾换行不算多一行） */
export const lines = (s: unknown) =>
  typeof s === 'string' && s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0
export const oneLine = (s: string, n = 120) => {
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

/** Claude 的 usage：input_tokens 不含缓存，要加上缓存读写才是完整输入 */
function claudeInput(u: any) {
  const read = u?.cache_read_input_tokens ?? 0
  const write = u?.cache_creation_input_tokens ?? 0
  return { input: (u?.input_tokens ?? 0) + read + write, read, write }
}

export function claudeParser(cwd: string): Parser {
  let msgId = ''
  const streamed = new Set<string>()
  let textInMsg = false
  // 流式过程中已经计入的用量；最后的 result 给的是总数，只补上差额
  const live = { input: 0, output: 0, read: 0, write: 0 }
  let msgOut = 0
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
        msgOut = 0
        const u = e.message?.usage
        if (u) {
          const c = claudeInput(u)
          live.input += c.input
          live.read += c.read
          live.write += c.write
          msgOut = u.output_tokens ?? 0
          live.output += msgOut
          out.push({
            type: 'usage',
            context: c.input,
            model: e.message?.model,
            addInput: c.input,
            addCacheRead: c.read,
            addCacheWrite: c.write,
            addOutput: msgOut,
          })
        }
      } else if (e.type === 'message_delta' && e.usage?.output_tokens !== undefined) {
        // output_tokens 是这条消息到目前为止的累计数
        const add = Math.max(0, e.usage.output_tokens - msgOut)
        msgOut = e.usage.output_tokens
        live.output += add
        if (add) out.push({ type: 'usage', addOutput: add })
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
        if (b.type === 'tool_use') {
          out.push(claudeTool(b.name, b.input, cwd))
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos))
            out.push({
              type: 'todos',
              todos: b.input.todos.map((t: any) => ({
                text: String(t.status === 'in_progress' ? (t.activeForm ?? t.content) : (t.content ?? '')),
                status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : 'pending',
              })),
            })
        }
      }
    } else if (o.type === 'result' || (o.total_cost_usd !== undefined && o.usage)) {
      const c = claudeInput(o.usage ?? {})
      const gap = (total: number, seen: number) => Math.max(0, total - seen)
      out.push({
        type: 'usage',
        addInput: gap(c.input, live.input),
        addCacheRead: gap(c.read, live.read),
        addCacheWrite: gap(c.write, live.write),
        addOutput: gap(o.usage?.output_tokens ?? 0, live.output),
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

/** Codex app-server 的用量（delta 是这次新增的累计差额，last 是最近一次请求）：inputTokens 已经包含缓存命中 */
export function codexUsage(delta: Record<string, number>, last: Record<string, number>, window?: number | null) {
  return {
    type: 'usage',
    context: last.totalTokens || (last.inputTokens ?? 0) + (last.outputTokens ?? 0),
    window: window || undefined,
    addInput: delta.inputTokens ?? 0,
    addCacheRead: delta.cachedInputTokens ?? 0,
    addCacheWrite: delta.cacheWriteInputTokens ?? 0,
    addOutput: delta.outputTokens ?? 0,
  } satisfies CliEvent as CliEvent
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
  // 正在流式输出思考；多段思考之间空一行
  let thinking = false
  let thought = false
  const sep = () => {
    const s = thought ? '\n\n' : ''
    thought = true
    return s
  }
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
      } else if (e.type === 'thinking_start') thinking = false
      else if (e.type === 'thinking_delta' && typeof e.delta === 'string') {
        out.push({ type: 'thinking', text: (thinking ? '' : sep()) + e.delta, delta: true })
        thinking = true
      } else if (e.type === 'thinking_end' && !thinking && e.text)
        out.push({ type: 'thinking', text: sep() + e.text, delta: true })
      else if (e.type === 'tool_queued') out.push(genericTool(String(e.toolName ?? 'tool'), e.input, cwd))
      else if (e.type === 'model_request_end' && e.usage) {
        const u = e.usage
        const read = u.cacheReadTokens ?? 0
        const write = u.cacheWriteTokens ?? 0
        // Command Code 的 inputTokens 一般已含缓存（AI SDK 的口径）；比缓存还小说明是不含缓存的口径，要加上
        const raw = u.inputTokens ?? 0
        const input = raw >= read + write ? raw : raw + read + write
        out.push({
          type: 'usage',
          context: input + (u.outputTokens ?? 0),
          model: e.model,
          addInput: input,
          addCacheRead: read,
          addCacheWrite: write,
          addOutput: u.outputTokens ?? 0,
        })
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

/** 一行一个 JSON 事件的 CLI（Claude Code、Command Code）；Codex 走 codex-app.ts 的 app-server 协议 */
export function parserFor(cliId: string, cwd: string): Parser {
  if (cliId === 'claude') return claudeParser(cwd)
  return commandCodeParser(cwd)
}
