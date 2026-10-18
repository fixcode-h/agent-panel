import path from 'node:path'
import type { CliLimits, ToolUse } from '../../shared/schema.ts'
import { t } from '../../shared/i18n.ts'

/** 各 CLI 的输出统一成这几种事件 */
export type CliEvent =
  | { type: 'session'; id: string }
  | { type: 'text_delta'; text: string }
  /** 一整段文字（没有流式增量时使用） */
  | { type: 'text'; text: string }
  /** 思考过程：Claude 是增量，Codex 是一段段的推理摘要 */
  | { type: 'thinking'; text: string; delta?: boolean }
  /** id 用来把之后的 tool_result 对应到这次调用 */
  | { type: 'tool'; tool: ToolUse; file?: { path: string; add: number; del: number }; id?: string }
  /** 还在执行的工具新输出的一段（命令的输出边跑边显示） */
  | { type: 'tool_delta'; id: string; text: string }
  /** CLI 改了文件（还没有逐个文件的统计），面板去 git 里重新读一次改动 */
  | { type: 'files_changed' }
  /** 这一轮在 CLI 会话里的位置：Codex 的 turn id，Claude Code 最后一条回复的 uuid；分叉、撤回时用 */
  | { type: 'turn'; id?: string; end?: string }
  /** 账号额度有了新数据 */
  | { type: 'limits'; limits: CliLimits }
  /** 上下文压缩完了；context 是压缩后的占用（知道时） */
  | { type: 'compacted'; context?: number }
  /** patch：改文件的工具给出的 unified diff，用来替换调用时记下的改前改后 */
  | { type: 'tool_result'; id: string; output: string; failed?: boolean; patch?: string; detail?: string }
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
  /** 生成了一张图片（Codex 的 image_gen）：path 是 CLI 存下的文件，data 是 base64；失败时 failed 是原因 */
  | { type: 'image'; path?: string; data?: string; failed?: string }
  | { type: 'result'; ok: boolean; error?: string }
  /** CLI 要用户确认（权限不够的命令、改文件）或回答问题；reply 把用户的选择交回给 CLI */
  | {
      type: 'ask'
      kind: 'command' | 'file' | 'tool' | 'question'
      title: string
      detail: string
      options?: string[]
      reply: (r: AskReply) => void
    }

export type AskReply = {
  allow: boolean
  answer?: string
  /** 拒绝时交给 CLI 的原话；不给时按 answer 拼一句「用户拒绝了」 */
  message?: string
}

export type Parser = (obj: any) => CliEvent[]

/** 文本的行数（末尾换行不算多一行） */
export const lines = (s: unknown) =>
  typeof s === 'string' && s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0
/** 工具详情最多保留的字数：命令输出可能很长，任务文件不能无限变大 */
const MAX_DETAIL = 8000
export const clipDetail = (s: string) =>
  s.length > MAX_DETAIL
    ? `${s.slice(0, MAX_DETAIL)}\n…` + t('（还有 {n} 个字符没有显示）', { n: s.length - MAX_DETAIL })
    : s

/** 工具输出可能是字符串，也可能是 [{type:'text', text}] 这样的内容块 */
export function toolText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : (b?.text ?? b?.content ?? ''))).join('\n')
  if (c && typeof c === 'object') return toolText((c as any).content ?? (c as any).text ?? JSON.stringify(c, null, 2))
  return c === undefined || c === null ? '' : String(c)
}

/** 工具的输入整理成便于阅读的文字：命令直接显示，改文件显示改前改后，其余显示 JSON */
function inputText(name: string, input: any): string {
  if (!input || typeof input !== 'object') return toolText(input)
  const cmd = input.command ?? input.cmd
  if (typeof cmd === 'string') return cmd
  const edits: any[] = Array.isArray(input.edits) ? input.edits : [input]
  const pairs = edits.filter((e) => typeof (e?.old_string ?? e?.oldString ?? e?.old_str) === 'string')
  if (pairs.length)
    return pairs
      .map((e) => {
        const minus = String(e.old_string ?? e.oldString ?? e.old_str)
          .split('\n')
          .map((l) => `-${l}`)
        const plus = String(e.new_string ?? e.newString ?? e.new_str ?? '')
          .split('\n')
          .map((l) => `+${l}`)
        // 每处改动一段，段头不带行号（调用时还不知道在第几行，CLI 给出结果后会换成带行号的 diff）
        return ['@@ @@', ...minus, ...plus].join('\n')
      })
      .join('\n')
  // 新写的文件按「全部是新增行」的 diff 显示
  if (typeof input.content === 'string' && /write|create/i.test(name))
    return input.content
      .replace(/\n$/, '')
      .split('\n')
      .map((l: string) => `+${l}`)
      .join('\n')
  return JSON.stringify(input, null, 2)
}

/** Claude Code 改文件后在 tool_use_result.structuredPatch 里给出带行号的 diff，转成 unified diff */
function claudePatch(r: any): string | undefined {
  const hunks: any[] = Array.isArray(r?.structuredPatch) ? r.structuredPatch : []
  if (!hunks.length) return undefined
  return clipDetail(
    hunks
      .map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines ?? []).join('\n')}`)
      .join('\n'),
  )
}

/** 给工具事件补上 id 和完整输入 */
function detailed(ev: CliEvent, id: unknown, name: string, input: unknown): CliEvent {
  if (ev.type !== 'tool') return ev
  const text = inputText(name, input)
  return {
    ...ev,
    id: typeof id === 'string' ? id : undefined,
    tool: { ...ev.tool, input: text ? clipDetail(text) : undefined },
  }
}

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
  const tool = (t: Omit<ToolUse, 'detail'> & { detail?: string }): Extract<CliEvent, { type: 'tool' }> => ({
    type: 'tool',
    tool: { detail: '', ...t },
  })
  switch (name) {
    case 'Read':
      return tool({ kind: 'read', label: file })
    case 'Write': {
      const add = lines(input?.content)
      return {
        ...tool({ kind: 'edit', name: t('写入'), label: file, detail: `+${add}` }),
        file: { path: file, add, del: 0 },
      }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const edits: any[] = input?.edits ?? [input]
      const add = edits.reduce((n, e) => n + lines(e?.new_string ?? e?.new_source), 0)
      const del = edits.reduce((n, e) => n + lines(e?.old_string), 0)
      return { ...tool({ kind: 'edit', label: file, detail: `+${add} -${del}` }), file: { path: file, add, del } }
    }
    case 'Bash':
      return tool({ kind: 'run', label: oneLine(String(input?.command ?? '')) })
    case 'Grep':
      return tool({ kind: 'search', label: searchLabel(input?.pattern, rel(cwd, input?.path)) })
    case 'Glob':
      return tool({ kind: 'search', name: t('查找文件'), label: searchLabel(input?.pattern, rel(cwd, input?.path)) })
    case 'WebSearch':
      return tool({ kind: 'web', name: t('网页搜索'), label: String(input?.query ?? '') })
    case 'WebFetch':
      return tool({ kind: 'web', name: t('打开网页'), label: String(input?.url ?? '') })
    case 'TodoWrite':
      return tool({
        kind: 'other',
        name: t('待办'),
        label: t('更新待办清单'),
        detail: t('{n} 项', { n: input?.todos?.length ?? 0 }),
      })
    case 'Task':
    case 'Agent':
      return tool({ kind: 'agent', label: String(input?.description ?? ''), detail: input?.subagent_type ?? '' })
    case 'Skill':
      return tool({
        kind: 'skill',
        label: String(input?.skill ?? input?.name ?? ''),
        detail: oneLine(String(input?.args ?? ''), 60),
      })
    case 'SlashCommand':
      return tool({ kind: 'other', name: t('命令'), label: oneLine(String(input?.command ?? '')) })
    default:
      return otherTool(name, input)
  }
}

const searchLabel = (pattern: unknown, where: string) => `${pattern ?? ''}${where ? ` · ${where}` : ''}`

/** 没有专门处理的工具：MCP 工具拆出服务名，其他的用工具名，后面跟第一个参数，和 Claude Code 的「工具名(参数)」一样 */
function otherTool(name: string, input: any): CliEvent {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  const first = Object.values(input ?? {}).find((v) => typeof v === 'string' && v.trim()) as string | undefined
  if (mcp) return { type: 'tool', tool: { kind: 'other', name: 'MCP', label: `${mcp[1]} · ${mcp[2]}`, detail: '' } }
  return { type: 'tool', tool: { kind: 'other', name, label: first ? oneLine(first, 80) : '', detail: '' } }
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
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
      out.push({ type: 'compacted' })
    } else if (o.type === 'rate_limit_event' && o.rate_limit_info) {
      const l = claudeLimits(o.rate_limit_info)
      if (l) out.push({ type: 'limits', limits: l })
    } else if (o.type === 'assistant' && o.message) {
      const id = o.message.id ?? ''
      if (typeof o.uuid === 'string' && !o.parent_tool_use_id) out.push({ type: 'turn', end: o.uuid })
      for (const b of o.message.content ?? []) {
        if (b.type === 'text' && b.text && !streamed.has(id)) out.push({ type: 'text', text: b.text })
        if (b.type === 'tool_use') {
          out.push(detailed(claudeTool(b.name, b.input, cwd), b.id, b.name, b.input))
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
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      const patch = claudePatch(o.tool_use_result)
      for (const b of o.message.content)
        if (b?.type === 'tool_result' && b.tool_use_id)
          out.push({
            type: 'tool_result',
            id: b.tool_use_id,
            output: clipDetail(toolText(b.content)),
            failed: !!b.is_error,
            patch,
          })
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
        // modelUsage 里每个用到的模型都有 contextWindow；子 Agent 可能用了别的小模型，取最大的那个
        window:
          Math.max(0, ...Object.values(o.modelUsage ?? {}).map((m: any) => Number(m?.contextWindow) || 0)) || undefined,
      })
      if (o.session_id) out.push({ type: 'session', id: o.session_id })
      const ok = !o.is_error && (o.subtype === undefined || o.subtype === 'success')
      out.push({
        type: 'result',
        ok,
        error: ok ? undefined : String(o.result || o.errors?.join('\n') || o.subtype || t('执行失败')),
      })
    }
    return out
  }
}

/** Claude Code 的 rate_limit_event：utilization 是 0~1 的比例，resetsAt 是秒 */
export function claudeLimits(info: any): CliLimits | undefined {
  const names: Record<string, number> = {
    five_hour: 300,
    seven_day: 10080,
    seven_day_opus: 10080,
    seven_day_sonnet: 10080,
  }
  const windows: CliLimits['windows'] = []
  for (const [id, w] of Object.entries((info?.unifiedWindows ?? {}) as Record<string, any>))
    if (w && typeof w.utilization === 'number')
      windows.push({
        id,
        usedPercent: Math.round(w.utilization * 1000) / 10,
        resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined,
        minutes: names[id],
      })
  // 旧版本只有当前起限制作用的那个窗口
  if (!windows.length && typeof info?.utilization === 'number' && info.rateLimitType)
    windows.push({
      id: String(info.rateLimitType),
      usedPercent: Math.round(info.utilization * 1000) / 10,
      resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined,
      minutes: names[info.rateLimitType],
    })
  if (!windows.length && info?.status !== 'rejected') return undefined
  return { windows, limited: info?.status === 'rejected' || undefined, at: new Date().toISOString() }
}

/** Codex 的额度快照：primary 是短窗口（5 小时），secondary 是长窗口（每周），resetsAt 是秒 */
export function codexLimits(snap: any): CliLimits | undefined {
  if (!snap) return undefined
  const windows: CliLimits['windows'] = []
  for (const w of [snap.primary, snap.secondary])
    if (w && typeof w.usedPercent === 'number')
      windows.push({
        id: w.windowDurationMins >= 1440 ? 'seven_day' : w.windowDurationMins ? 'five_hour' : 'window',
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined,
        minutes: w.windowDurationMins ?? undefined,
      })
  if (!windows.length) return undefined
  return {
    windows,
    plan: snap.planType ?? undefined,
    limited: !!snap.rateLimitReachedType || undefined,
    at: new Date().toISOString(),
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
  if (/skill/.test(n))
    return {
      type: 'tool',
      tool: {
        kind: 'skill',
        label: String(input?.name ?? input?.skill ?? input?.skill_name ?? ''),
        detail: oneLine(String(input?.arguments ?? input?.args ?? ''), 60),
      },
    }
  if (/web_?search/.test(n))
    return { type: 'tool', tool: { kind: 'web', name: t('网页搜索'), label: String(input?.query ?? ''), detail: '' } }
  if (/fetch|url|browse/.test(n))
    return { type: 'tool', tool: { kind: 'web', name: t('打开网页'), label: String(input?.url ?? ''), detail: '' } }
  if (/write|edit|patch|replace|create_file/.test(n)) {
    const add = lines(input?.content ?? input?.new_string ?? input?.newString ?? input?.new_str)
    const del = lines(input?.old_string ?? input?.oldString ?? input?.old_str)
    return {
      type: 'tool',
      tool: {
        kind: 'edit',
        name: /write|create/.test(n) ? t('写入') : undefined,
        label: file || name,
        detail: add || del ? `+${add} -${del}` : '',
      },
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
      tool: {
        kind: 'search',
        name: /glob|find|list|ls/.test(n) ? t('查找文件') : undefined,
        label: String(input?.pattern ?? input?.query ?? file ?? ''),
        detail: '',
      },
    }
  if (/todo/.test(n))
    return { type: 'tool', tool: { kind: 'other', name: t('待办'), label: t('更新待办清单'), detail: '' } }
  if (/task|agent/.test(n))
    return {
      type: 'tool',
      tool: { kind: 'agent', label: String(input?.description ?? input?.prompt ?? '').slice(0, 80), detail: '' },
    }
  return otherTool(name, input)
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
      else if (e.type === 'tool_queued')
        out.push(
          detailed(
            genericTool(String(e.toolName ?? 'tool'), e.input, cwd),
            e.toolCallId,
            String(e.toolName ?? ''),
            e.input,
          ),
        )
      else if ((e.type === 'tool_completed' || e.type === 'tool_errored') && e.toolCallId)
        out.push({
          type: 'tool_result',
          id: e.toolCallId,
          output: clipDetail(toolText(e.type === 'tool_errored' ? e.error : e.result)),
          failed: e.type === 'tool_errored',
        })
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
        out.push({ type: 'error', message: e.error?.message ?? String(e.error ?? t('执行失败')) })
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
