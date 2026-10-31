import path from 'node:path'
import type { CliLimits, ToolUse } from '../../shared/schema.ts'
import type { ContextSnapshot } from '../../shared/context-breakdown.ts'
import { t } from '../../shared/i18n.ts'
import { getCli } from '../../shared/clis.ts'
import type { OutputSpec } from '../../shared/cli-spec.ts'
import { panelToolName } from '../../shared/panel-tools.ts'
import { clip } from '../../shared/text.ts'

/** 各 CLI 的输出统一成这几种事件 */
export type CliEvent =
  | { type: 'session'; id: string }
  /** 开始一次模型请求：执行中补充的消息会在这次请求前被 CLI 取走 */
  | { type: 'request_start' }
  | { type: 'text_delta'; text: string }
  /** 一整段文字（没有流式增量时使用） */
  | { type: 'text'; text: string }
  /** 思考过程：Claude 是增量，Codex 是一段段的推理摘要 */
  /** ms：CLI 报得出这段思考用了多久时给（Codex 的推理条目），否则面板按收到的时刻算 */
  | { type: 'thinking'; text: string; delta?: boolean; ms?: number }
  /** id 用来把之后的 tool_result 对应到这次调用 */
  | { type: 'tool'; tool: ToolUse; file?: { path: string; add: number; del: number }; id?: string }
  /** 还在执行的工具新输出的一段（命令的输出边跑边显示）；snapshot 为真时 text 是到目前为止的全部输出 */
  | { type: 'tool_delta'; id: string; text: string; snapshot?: boolean }
  /** CLI 改了文件（还没有逐个文件的统计），面板去 git 里重新读一次改动 */
  | { type: 'files_changed' }
  /** 这一轮在 CLI 会话里的位置：Codex 的 turn id，Claude Code 最后一条回复的 uuid；分叉、撤回时用 */
  | { type: 'turn'; id?: string; end?: string }
  /** 账号额度有了新数据 */
  | { type: 'limits'; limits: CliLimits }
  /** 上下文压缩完了；context 是压缩后的占用（知道时） */
  /** 压缩了上下文：before 是压缩前的 token 数，context 是压缩后的（CLI 给了才有） */
  /**
   * 压缩完了：before 是压缩前的整个上下文；context 是压缩后的整个上下文。
   * messages 是压缩后只算消息（摘要 + 恢复的附件）的大小：Claude Code 的 post_tokens 不含系统提示词和工具定义，
   * 不能直接当成上下文占用，要加上这些固定部分（runner 按 CLI 报的细分补）
   */
  | { type: 'compacted'; context?: number; before?: number; messages?: number }
  /** CLI 自己开始压缩了（Claude Code 的 status: compacting）：先放一行转圈的压缩，压缩完成再填前后大小 */
  | { type: 'compacting' }
  /** patch：改文件的工具给出的 unified diff，用来替换调用时记下的改前改后 */
  /** exitCode：CLI 报得出命令的退出码时给（Claude Code 的 tool_use_result.code、Pi 的 structuredContent.exit_code），没有就不写 */
  | {
      type: 'tool_result'
      id: string
      output: string
      failed?: boolean
      exitCode?: number
      patch?: string
      detail?: string
    }
  /** 模型在生成、但不显示的输出（Pi 流式给出的工具参数）：只算进实时速度，不然写大文件时速度会被校准得偏高 */
  | { type: 'gen'; text: string }
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
  /** CLI 自己报的上下文细分（Claude Code 的 get_context_usage）：会话栏按它分块 */
  | { type: 'context'; snapshot: ContextSnapshot }
  /** 一次模型请求结束：ms 是这次请求从开始到结束的耗时（CLI 报得出起止时才有） */
  | { type: 'model'; ms: number }
  /** CLI 的待办清单 / 计划，每次给出完整列表 */
  | { type: 'todos'; todos: { text: string; status: 'pending' | 'running' | 'done' }[] }
  | { type: 'error'; message: string }
  /** 不影响这一轮结果、但用户应该看到的情况（CLI 自动重试、面板工具没接上）；failed 时标成失败的样子 */
  /**
   * kind 只在重试类上给（retry / retry_failed）：界面靠它把「正在重试」收成已恢复、按原因给出下一步；
   * attempt / maxAttempts / error 是重试的定位信息，写进日志供事后统计「总是失败」
   */
  | {
      type: 'notice'
      text: string
      failed?: boolean
      /** 只有重试类会带（parser 只会产出这两个）：面板按它给界面和日志分类 */
      kind?: 'retry' | 'retry_failed'
      attempt?: number
      maxAttempts?: number
      error?: string
    }
  /** CLI 自动重试成功了：只用来把前面那张「正在重试」收成已恢复，不再多提示一行 */
  | { type: 'retry_ok'; text: string; attempt?: number }
  /** 生成了一张图片（Codex 的 image_gen）：path 是 CLI 存下的文件，data 是 base64；失败时 failed 是原因 */
  | { type: 'image'; path?: string; data?: string; failed?: string }
  /**
   * 环境性卡住：等请求回复超时了，但进程还活着、stderr 一个字都没有（多半是 CLI 启动 / 扩展加载慢）。
   * runner 只对这一类失败自动重试一次；模型明确报错、工具失败这些内容性失败不带它
   */
  | {
      type: 'result'
      ok: boolean
      error?: string
      envStall?: boolean
      /**
       * 模型最后一次回应为什么停（Claude 的 stop_reason：end_turn / tool_use / max_tokens / refusal…）。
       * 只用来写日志排查「说了要做却没调工具就结束」：是模型自己收尾（end_turn），还是被截断
       */
      stopReason?: string
    }
  /** CLI 要用户确认（权限不够的命令、改文件）或回答问题；reply 把用户的选择交回给 CLI */
  | {
      type: 'ask'
      kind: 'command' | 'file' | 'tool' | 'question'
      title: string
      detail: string
      options?: string[]
      /** 一次问了几个问题（Claude Code 的 AskUserQuestion） */
      questions?: import('../../shared/schema.ts').AskQuestion[]
      reply: (r: AskReply) => void
    }

export type AskReply = {
  allow: boolean
  answer?: string
  /** 一次问了几个问题时，每个问题的回答 */
  answers?: string[]
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
  clip(s, MAX_DETAIL, { mark: (omitted) => `\n…` + t('（还有 {n} 个字符没有显示）', { n: omitted }) })

/** 工具输出可能是字符串，也可能是 [{type:'text', text}] 这样的内容块 */
export function toolText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : (b?.text ?? b?.content ?? ''))).join('\n')
  if (c && typeof c === 'object') return toolText((c as any).content ?? (c as any).text ?? JSON.stringify(c, null, 2))
  return c === undefined || c === null ? '' : String(c)
}

// 各家 CLI 改文件工具的字段名不同（old_string、oldString、old_str，Pi 是 oldText）
const oldText = (e: any): unknown => e?.old_string ?? e?.oldString ?? e?.old_str ?? e?.oldText
const newText = (e: any): unknown => e?.new_string ?? e?.newString ?? e?.new_str ?? e?.newText

/** 工具的输入整理成便于阅读的文字：命令直接显示，改文件显示改前改后，其余显示 JSON */
function inputText(name: string, input: any): string {
  if (!input || typeof input !== 'object') return toolText(input)
  const cmd = input.command ?? input.cmd
  if (typeof cmd === 'string') return cmd
  const edits: any[] = Array.isArray(input.edits) ? input.edits : [input]
  const pairs = edits.filter((e) => typeof oldText(e) === 'string')
  if (pairs.length)
    return pairs
      .map((e) => {
        const minus = String(oldText(e))
          .split('\n')
          .map((l) => `-${l}`)
        const plus = String(newText(e) ?? '')
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
      // Claude Code 拿不到命令的中间输出，所以这里不标 running、也不发 tool_delta，只能跑完一次性显示：
      // stream-json 的 --include-partial-messages 只流文字、思考和工具入参（input_json_delta），不流工具结果；
      // 它内部确实有 bash_progress，但只在 CLAUDE_CODE_REMOTE / CLAUDE_CODE_CONTAINER_ID 下才转成 tool_progress，
      // 而且只带 elapsed_time_seconds 和 task_id，没有输出正文。不要在这里补心跳行假装实时
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
  // 流式过程中已经计入的用量；最后的 result 给的是本轮的总数，只补上差额。
  // 保活时同一进程连着跑多轮，每轮的 result 都要从零做差（见 result 分支）
  const live = { input: 0, output: 0, read: 0, write: 0 }
  let msgOut = 0
  /** 这条回应已经计入的输入（开头 message_start 报的），结尾 message_delta 报得更多时只补差额 */
  let msgIn = { input: 0, read: 0, write: 0 }
  // result 的 total_cost_usd：stream-json 常驻多轮时是会话累计值（每轮重述 running total），
  // 和 usage 的「本轮」口径不同，要按差值记，不能每轮直接累加
  let costTotal = 0
  /** 最近一次模型回应停下的原因（流式 message_delta 里报），result 时带出去 */
  let stopReason = ''
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
        // 每次模型回应的开头：插话收下后说完的那段话到这里为止，之后的回应排在用户消息后面
        out.push({ type: 'request_start' })
        const u = e.message?.usage
        msgIn = { input: 0, read: 0, write: 0 }
        if (u) {
          const c = claudeInput(u)
          msgIn = c
          live.input += c.input
          live.read += c.read
          live.write += c.write
          msgOut = u.output_tokens ?? 0
          live.output += msgOut
          out.push({
            type: 'usage',
            // 有的网关（DeepSeek 等兼容 Anthropic 的接口）开头报 0、结尾的 message_delta 才报真实输入：
            // 0 不当成上下文，不然每次回应开头都把上下文改回 0，会话栏一直显示 0（用户报过）
            ...(c.input > 0 ? { context: c.input } : {}),
            model: e.message?.model,
            addInput: c.input,
            addCacheRead: c.read,
            addCacheWrite: c.write,
            addOutput: msgOut,
          })
        }
      } else if (e.type === 'message_delta') {
        if (typeof e.delta?.stop_reason === 'string') stopReason = e.delta.stop_reason
        const u = e.usage ?? {}
        // 结尾才报输入的网关：输入比开头报的多就补上，上下文按它算（见 message_start 那里的说明）
        const c = claudeInput(u)
        if (c.input > msgIn.input) {
          const add = {
            input: c.input - msgIn.input,
            read: Math.max(0, c.read - msgIn.read),
            write: Math.max(0, c.write - msgIn.write),
          }
          msgIn = c
          live.input += add.input
          live.read += add.read
          live.write += add.write
          out.push({
            type: 'usage',
            context: c.input,
            addInput: add.input,
            addCacheRead: add.read,
            addCacheWrite: add.write,
          })
        }
        if (u.output_tokens !== undefined) {
          // output_tokens 是这条消息到目前为止的累计数
          const add = Math.max(0, u.output_tokens - msgOut)
          msgOut = u.output_tokens
          live.output += add
          if (add) out.push({ type: 'usage', addOutput: add })
        }
      } else if (e.type === 'content_block_start' && e.content_block?.type === 'text' && textInMsg) {
        out.push({ type: 'text_delta', text: '\n\n' })
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
        out.push({ type: 'thinking', text: e.delta.thinking ?? '', delta: true })
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') {
        // 模型在写工具入参（写大文件时能写一两分钟）：算在输出，不然没有响应的检测会把它当成卡住
        if (e.delta.partial_json) out.push({ type: 'gen', text: e.delta.partial_json })
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        streamed.add(msgId)
        textInMsg = true
        out.push({ type: 'text_delta', text: e.delta.text ?? '' })
      }
    } else if (o.type === 'system' && o.subtype === 'status' && o.status === 'compacting') {
      out.push({ type: 'compacting' })
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const meta = o.compact_metadata ?? {}
      out.push({
        type: 'compacted',
        ...(typeof meta.pre_tokens === 'number' ? { before: meta.pre_tokens } : {}),
        // post_tokens 只算压缩后的消息（摘要和恢复的附件），不含系统提示词、工具定义：不能当整个上下文
        ...(typeof meta.post_tokens === 'number' ? { messages: meta.post_tokens } : {}),
      })
    } else if (o.type === 'rate_limit_event' && o.rate_limit_info) {
      const l = claudeLimits(o.rate_limit_info)
      if (l) out.push({ type: 'limits', limits: l })
    } else if (o.type === 'assistant' && o.message) {
      const id = o.message.id ?? ''
      if (typeof o.uuid === 'string' && !o.parent_tool_use_id) out.push({ type: 'turn', end: o.uuid })
      // 有的网关流式 message_start 不报用量（全 0），真实输入只在完整消息的 usage 里：在这里补一次上下文占用。
      // 累计仍由 message_start / result 负责，这里不带 add*，不重复累加；子 Agent 的上下文和主会话无关，不算
      if (o.message.usage && !o.parent_tool_use_id) {
        const c = claudeInput(o.message.usage)
        if (c.input > 0) out.push({ type: 'usage', context: c.input, model: o.message.model })
      }
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
            // Bash 的 tool_use_result 里有 { code, stdout, stderr }，之前只取了 content，退出码就这么丢了
            exitCode: num(o.tool_use_result?.code),
            patch,
          })
    } else if (o.type === 'result' || (o.total_cost_usd !== undefined && o.usage)) {
      const c = claudeInput(o.usage ?? {})
      const gap = (total: number, seen: number) => Math.max(0, total - seen)
      // 费用是会话累计：这一轮只记比上次多了多少（第一次就是总数）；没报这个字段时按不变算
      const totalCost = o.total_cost_usd ?? costTotal
      const addCost = Math.max(0, totalCost - costTotal)
      costTotal = totalCost
      out.push({
        type: 'usage',
        addInput: gap(c.input, live.input),
        addCacheRead: gap(c.read, live.read),
        addCacheWrite: gap(c.write, live.write),
        addOutput: gap(o.usage?.output_tokens ?? 0, live.output),
        addCost,
        // modelUsage 里每个用到的模型都有 contextWindow；子 Agent 可能用了别的小模型，取最大的那个
        window:
          Math.max(0, ...Object.values(o.modelUsage ?? {}).map((m: any) => Number(m?.contextWindow) || 0)) || undefined,
      })
      // 这一轮的总量已经上报：流式累计清零，下一轮（保活时同一进程）从零重新做差
      live.input = 0
      live.read = 0
      live.write = 0
      live.output = 0
      if (o.session_id) out.push({ type: 'session', id: o.session_id })
      const ok = !o.is_error && (o.subtype === undefined || o.subtype === 'success')
      // 新版 result 里直接带 stop_reason；旧版只能从流式的 message_delta 里拿最后一次
      const why = typeof o.stop_reason === 'string' ? o.stop_reason : stopReason
      stopReason = ''
      out.push({
        type: 'result',
        ok,
        error: ok ? undefined : String(o.result || o.errors?.join('\n') || o.subtype || t('执行失败')),
        ...(why ? { stopReason: why } : {}),
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
  // 面板自己的工具（Pi 的桥接扩展注册的是裸名字）：记成 MCP 调用，界面按做了什么显示；
  // 不先认出来的话 wait_agents、spawn_agents 会因为名字里有 agent 被当成 CLI 自己的子 Agent。
  // 带服务名前缀的（panel_run_background 这类）也要认：不然名字里有 run 就被当成 CLI 自己的命令，
  // 界面显示成「运行命令」、0.09 秒就「完成」，看不出命令还在后台跑
  const panel = panelToolName(name)
  if (panel) return otherTool(`mcp__panel__${panel}`, input)
  const n = name.toLowerCase()
  const file = rel(cwd, input?.path ?? input?.file_path ?? input?.filePath ?? input?.absolute_path ?? input?.file)
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
    // 一次改多处（edits 数组）时把每处的行数加起来
    const edits: any[] = Array.isArray(input?.edits) ? input.edits : [input]
    const add = edits.reduce((n, e) => n + lines(e?.content ?? newText(e)), 0)
    const del = edits.reduce((n, e) => n + lines(oldText(e)), 0)
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
  // 这次模型请求开始的时间：结束时报给面板，用来说明两步之间等的是模型
  let reqStart = 0
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
      else if (e.type === 'model_request_start') {
        reqStart = Date.now()
        out.push({ type: 'request_start' })
      } else if (e.type === 'model_request_end') {
        const u = e.usage
        if (u) {
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
        }
        // 模型请求本身要几秒到几十秒，记下来：界面上才能说是「在等模型」而不是卡住了
        if (reqStart) out.push({ type: 'model', ms: Date.now() - reqStart })
        reqStart = 0
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

// ---- 配置文件描述的输出：按事件映射转成面板的事件 ----
/** 取事件里的字段（$.a.b，数组可以用 -1 取最后一项）、比较（$.a == x、$.a != x），其余是字面值 */
function evalExpr(o: any, v: unknown): unknown {
  if (typeof v !== 'string' || !v.startsWith('$.')) return v
  const m = /^\$\.([\w.-]+)\s*(==|!=)\s*(.*)$/.exec(v)
  const get = (p: string) =>
    p
      .split('.')
      .reduce((x, k) => (x == null ? undefined : Array.isArray(x) && /^-\d+$/.test(k) ? x.at(Number(k)) : x[k]), o)
  if (!m) return get(v.slice(2))
  const got = String(get(m[1]) ?? '')
  return m[2] === '==' ? got === m[3].trim() : got !== m[3].trim()
}

const str = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : toolText(v))
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function specParser(spec: OutputSpec, cwd: string): Parser {
  // 这段思考已经流式推过增量：final 的整段（Pi 的 thinking_end）就不再发，免得重复一遍
  let thinkingStreamed = false
  return (o) => {
    const rule = spec.events.find((r) => Object.entries(r.when).every(([k, want]) => evalExpr(o, `$.${k}`) === want))
    if (!rule) return []
    const out: CliEvent[] = []
    for (const e of rule.emit) {
      const g = (k: string) => evalExpr(o, e[k])
      switch (e.type) {
        case 'session':
          if (str(g('id'))) out.push({ type: 'session', id: str(g('id')) })
          break
        case 'text_delta':
        case 'text':
        case 'error':
          if (str(g(e.type === 'error' ? 'message' : 'text')))
            out.push(
              e.type === 'error'
                ? { type: 'error', message: str(g('message')) }
                : { type: e.type, text: str(g('text')) },
            )
          break
        case 'gen':
          if (str(g('text'))) out.push({ type: 'gen', text: str(g('text')) })
          break
        case 'thinking': {
          // final：这段思考结束时的完整内容。有的接口（一些 Responses 中转）不推增量，只在结束时给整段，
          // 只认增量的话思考就整段丢了；推过增量的照旧用增量
          if (e.final === true) {
            const streamed = thinkingStreamed
            thinkingStreamed = false
            if (streamed) break
          } else if (g('delta')) thinkingStreamed = true
          if (str(g('text'))) out.push({ type: 'thinking', text: str(g('text')), delta: !!g('delta') })
          break
        }
        case 'tool': {
          const name = str(g('name')) || 'tool'
          const input = g('input') ?? {}
          const ev = detailed(genericTool(name, input, cwd), g('id'), name, input)
          // 定义里写了 running 的工具表示调用已开始、结果还没来：界面按它决定是否边跑边显示输出。
          // 不写这个字段的 CLI（结果和调用一起到达）不算还在跑
          if (ev.type === 'tool' && g('running') === true) ev.tool.running = true
          out.push(ev)
          break
        }
        case 'tool_result': {
          const exitCode = num(g('exitCode'))
          if (str(g('id')))
            out.push({
              type: 'tool_result',
              id: str(g('id')),
              output: clipDetail(str(g('output')) || str(g('error'))),
              failed: !!g('failed'),
              ...(exitCode === undefined ? {} : { exitCode }),
            })
          break
        }
        // 命令执行中推送的输出：`text` 是新增的一段（Codex 的增量），`snapshot` 是到目前为止的全部输出
        // （Pi 的 partialResult），两种都发成 tool_delta，由接收方按快照处理
        case 'tool_delta': {
          const id = str(g('id'))
          // 快照是完整的工具结果对象时取正文：Pi 的 partialResult 是 { content: [{ type: 'text', text }] }
          const text = str(e.snapshot === true ? toolText(g('text')) : g('text'))
          if (!id) break
          // 空快照也要发：CLI 用空快照表示「现在没有输出了」，跳过的话接收方还留着上一段旧输出。
          // 空的新增（不是快照）没有意义，照旧丢掉
          if (text || e.snapshot === true)
            out.push(
              e.snapshot === true ? { type: 'tool_delta', id, text, snapshot: true } : { type: 'tool_delta', id, text },
            )
          break
        }
        case 'usage': {
          // 各家 CLI 对 inputTokens 的口径不同：有的已含缓存（AI SDK），有的只算未命中的部分。
          // 定义里写明 inputExcludesCache（Pi 的 usage.input 只算未命中的）时总是加上缓存；没写时按大小猜：
          // 比缓存还小说明是不含缓存的口径。只靠猜不行：某一次未命中的比命中的多时会少算缓存那部分
          const rawIn = num(g('addInput'))
          const read = num(g('addCacheRead'))
          const write = num(g('addCacheWrite'))
          const cache = (read ?? 0) + (write ?? 0)
          const u = {
            context: num(g('context')),
            window: num(g('window')),
            model: str(g('model')) || undefined,
            addInput:
              rawIn === undefined ? undefined : e.inputExcludesCache === true || rawIn < cache ? rawIn + cache : rawIn,
            addOutput: num(g('addOutput')),
            addCacheRead: read,
            addCacheWrite: write,
            addCost: num(g('addCost')),
          }
          if (Object.values(u).some((x) => x !== undefined)) out.push({ type: 'usage', ...u } as CliEvent)
          break
        }
        case 'files_changed':
          out.push({ type: 'files_changed' })
          break
        // 文字由面板按 kind 拼（跟着界面语言），配置里只给字段；没有 kind 时用 text 原文
        case 'notice': {
          const err = oneLine(str(g('error')), 300)
          const n = num(g('attempt')) ?? 1
          const max = num(g('maxAttempts'))
          const retry = e.kind === 'retry' || e.kind === 'retry_failed'
          const text =
            e.kind === 'retry'
              ? t('模型请求失败，{s} 秒后第 {n}/{max} 次重试：{error}', {
                  s: Math.max(1, Math.round((num(g('delayMs')) ?? 0) / 1000)),
                  n,
                  max: max ?? '?',
                  error: err,
                })
              : e.kind === 'retry_failed'
                ? t('自动重试 {n} 次后仍然失败：{error}', { n, error: err })
                : e.kind === 'compact_failed'
                  ? err && t('压缩上下文失败：{error}', { error: err })
                  : e.kind === 'tools_failed'
                    ? t(
                        '面板的工具没接上（{error}）：缺的那些这一轮用不了，只能直接改文件、用普通命令跑；要这些工具就重开一轮',
                        {
                          error: err || t('原因未知'),
                        },
                      )
                    : str(g('text'))
          if (text)
            out.push({
              type: 'notice',
              text,
              failed:
                e.kind === 'retry_failed' || e.kind === 'compact_failed' || e.kind === 'tools_failed' || !!g('failed'),
              // 重试类才带定位字段：别的 notice 保持原样，日志和界面都不需要
              ...(retry
                ? {
                    kind: e.kind === 'retry' ? 'retry' : 'retry_failed',
                    attempt: n,
                    ...(max === undefined ? {} : { maxAttempts: max }),
                    ...(err ? { error: err } : {}),
                  }
                : {}),
            })
          break
        }
        // 自动重试成功不是提示：单独一种事件，runner 用它把前面那张「正在重试」收成已恢复
        case 'retry_ok': {
          const n = num(g('attempt')) ?? 1
          out.push({ type: 'retry_ok', text: t('第 {n} 次重试成功了，接着做。', { n }), attempt: n })
          break
        }
        // 压缩前后的 token 数都没有时（例如压缩被中断）不算压缩过
        case 'compacted': {
          const before = num(g('before'))
          const context = num(g('context'))
          if (before !== undefined || context !== undefined) out.push({ type: 'compacted', before, context })
          break
        }
        case 'request_start':
          out.push({ type: 'request_start' })
          break
        case 'result': {
          const ok = g('ok') !== false && g('ok') !== undefined
          out.push({ type: 'result', ok, error: ok ? undefined : str(g('error')) || t('执行失败') })
          break
        }
      }
    }
    return out
  }
}

/** 一行一个 JSON 事件的 CLI：内置解析器按名字找，配置文件写的事件映射用 specParser；Codex 走 rpc/codex.ts 的 app-server 协议 */
export function parserFor(cliId: string, cwd: string): Parser {
  const p = getCli(cliId)?.parser
  if (p && typeof p === 'object') return specParser(p, cwd)
  if (p === 'claude') return claudeParser(cwd)
  return commandCodeParser(cwd)
}
