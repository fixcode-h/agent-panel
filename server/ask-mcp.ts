import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AskQuestion } from '../shared/schema.ts'
import type { AskReply, CliEvent } from './exec/parsers.ts'
import type { Orchestra } from '../shared/engine.ts'
import { callOrchTool, orchTools } from './orch-mcp.ts'
import { APP_TOOLS, callAppTool } from './app-actions/mcp.ts'
import { MORE_TOOLS, moreTools, splitDeferred } from '../shared/panel-tools.ts'
import type { ActionCaller } from './app-actions/registry.ts'

/**
 * 给没有「向用户提问」通道的 CLI（无界面运行的 Command Code）一个提问工具：
 * 面板起一个只在这一轮有效的 MCP 服务，工具 ask_user 一直等到用户在页面上回答，再把回答交回给模型。
 * Claude Code、Codex 有自己的提问协议，不走这里。
 *
 * 同一轮里还能挂上 read_user_notes：CLI 没有插话协议时（见 CLI 配置的 notes），
 * 用户在它执行中发的要求会直接记进对话并登记给它，模型用这个工具取走；这一轮结束还没取走的，
 * 面板会马上开新一轮接着处理。
 *
 * 对话页开着时再挂上 wait_user_message：模型回复完调用它停在进程里等用户下一句，
 * 面板把新消息直接作为工具结果交回去，不用结束进程再 --resume。
 *
 * 编排工具（派子 Agent、分派子对话、和父对话通讯、认领文件，见 orch-mcp.ts）也挂在这同一个服务上：
 * 一次调用只给 CLI 一个面板 MCP，少一个连接，配置文件里也只多一项。
 */

type AskEvent = Extract<CliEvent, { type: 'ask' }>
export type Ask = (ev: AskEvent) => void

/** 长等待（提问、等下一句）期间定期往流里写一行注释当心跳，免得 HTTP 客户端判定连接空闲 */
const HEARTBEAT_MS = 20_000

const sessions = new Map<
  string,
  {
    ask?: Ask
    notes?: () => string[]
    /** 等用户在这个对话里的下一句；用户离开时返回空 */
    wait?: () => Promise<string | null>
    /** 编排工具：工作流节点和对话的调用才有 */
    orch?: Orchestra
    /** 操控软件的动作（app_actions / app_do）：对话的调用才有，值是调用者 */
    app?: ActionCaller
    onTools?: (listed: { name: string; chars: number }[], deferred: { name: string; chars: number }[]) => void
    pending: Set<(r: AskReply) => void>
  }
>()

const TOOL = {
  name: 'ask_user',
  description:
    '向用户提问并等他在界面上回答。需要用户做选择、补充信息、确认方向时用它，不要把问题写成普通文字。一次可以问几个相关的问题；每个问题给 2~4 个选项，推荐的放第一位并在 label 末尾标「（推荐）」；用户也能自己填写别的答案。' +
    '问题本身可以同时选好几项时（例如「现在修哪些」「要包含哪些」「要改哪几个文件」），必须把 multiSelect 设为 true：界面会变成方框、可以多选，标题后面也会标出「多选」。只有一个答案能选时才用单选（不写或 false）。',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: '问题的短标题（几个字）' },
            question: { type: 'string', description: '完整的问题' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, description: { type: 'string' } },
                required: ['label'],
              },
            },
            multiSelect: {
              type: 'boolean',
              description:
                '问题可以同时选好几项时为 true（例如「现在修哪些」「要包含哪些」）。为 true 时界面按多选显示，用户能勾选多个选项',
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** 执行中取用户补充的工具：只在 CLI 没有插话协议、本轮挂了补充通道时给（见 CLI 配置的 notes） */
const NOTES_TOOL = {
  name: 'read_user_notes',
  description:
    '取用户在你这轮执行中补充的信息。开始动手前先调用一次；做比较久的事（跑命令、改多处文件、等测试）中间也每隔一会儿调用一次。' +
    '取到后先判断它和当前任务的关系：相关的按它调整方向继续，无关的先记下，做完手上的事再处理，不要从头重做。' +
    '取过的不会再给；暂时没有时会等几秒再回答「没有新的补充」，这时继续做手上的事，过一会儿可以再调用。',
  inputSchema: { type: 'object', properties: {} },
}

/** 回复完停在进程里等用户下一句的工具：对话页开着时才有，避免每句话都重新 --resume */
const WAIT_TOOL = {
  name: 'wait_user_message',
  description:
    '等用户在这个对话里的下一条消息。每次回复结束后调用一次：用户发来消息时返回消息内容，接着处理；返回「用户已经离开了这个对话」时结束本轮，不要继续做别的事。',
  inputSchema: { type: 'object', properties: {} },
}

/** 模型传来的参数整理成面板的问题；也认只问一个问题的简单写法 */
export function toQuestions(a: any): AskQuestion[] {
  const list = Array.isArray(a?.questions) ? a.questions : a?.question ? [a] : []
  return list
    .map((q: any) => ({
      header: str(q?.header),
      question: str(q?.question),
      options: (Array.isArray(q?.options) ? q.options : [])
        .map((x: any) =>
          typeof x === 'string'
            ? { label: x, description: '' }
            : { label: str(x?.label), description: str(x?.description) },
        )
        .filter((x: { label: string }) => x.label),
      multiSelect: !!q?.multiSelect,
    }))
    .filter((q: AskQuestion) => q.question)
    .slice(0, 6)
}

async function callAsk(s: NonNullable<ReturnType<typeof sessions.get>>, args: unknown) {
  const ask = s.ask
  if (!ask) return { content: [{ type: 'text', text: '这一轮没有提问通道' }], isError: true }
  const qs = toQuestions(args)
  if (!qs.length) return { content: [{ type: 'text', text: 'questions 是空的，每个问题要写 question' }], isError: true }
  const reply = await new Promise<AskReply>((resolve) => {
    s.pending.add(resolve)
    ask({
      type: 'ask',
      kind: 'question',
      title: qs[0].question,
      detail: qs[0].header,
      options: qs[0].options.map((x) => x.label),
      questions: qs,
      reply: resolve,
    })
  })
  if (!reply.allow)
    return {
      content: [
        { type: 'text', text: reply.message ?? (reply.answer ? `用户拒绝了：${reply.answer}` : '用户没有回答') },
      ],
    }
  const got = reply.answers?.length ? reply.answers : [reply.answer ?? '']
  return {
    content: [
      { type: 'text', text: `用户的回答：\n${qs.map((q, i) => `${q.question} → ${got[i] ?? ''}`).join('\n')}` },
    ],
  }
}

/** 没有补充时等一会儿再回答：用户可能在模型检查之后的几秒里发来补充 */
const NOTES_WAIT_MS = 5000

/** 取执行中的补充：拿到的同时交出去，之后再取只给新的 */
async function callNotes(s: NonNullable<ReturnType<typeof sessions.get>>) {
  let list = s.notes?.() ?? []
  const until = Date.now() + NOTES_WAIT_MS
  while (!list.length && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250))
    list = s.notes?.() ?? []
  }
  return { content: [{ type: 'text', text: list.length ? list.join('\n\n') : '没有新的补充' }] }
}

type ToolChars = { name: string; chars: number }
/** 一个工具定义交给 CLI 时的字数：名字、标题、说明和参数的 JSON */
const toolChars = (x: { name: string; title?: string; description?: string; inputSchema?: unknown }): ToolChars => ({
  name: x.name,
  chars:
    x.name.length + (x.title?.length ?? 0) + (x.description?.length ?? 0) + JSON.stringify(x.inputSchema ?? {}).length,
})

async function handle(s: NonNullable<ReturnType<typeof sessions.get>>, msg: any) {
  if (msg?.id === undefined || msg?.id === null) return undefined
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  const orch = s.orch ? orchTools(s.orch) : []
  const all = [
    ...(s.ask ? [TOOL] : []),
    ...(s.notes ? [NOTES_TOOL] : []),
    ...(s.wait ? [WAIT_TOOL] : []),
    ...orch,
    ...(s.app ? APP_TOOLS : []),
  ]
  // 不常用的工具不直接列出，收进 more_tools（见 shared/panel-tools.ts 的 DEFERRED_TOOLS）：
  // 工具说明每个会话都要整份带着，父对话一次二十多个、上万字，大多数一轮都用不到
  const { listed: tools, deferred } = splitDeferred(all)
  const call = async (name: string, args: any): Promise<unknown> => {
    if (name === TOOL.name && s.ask) return callAsk(s, args)
    if (name === NOTES_TOOL.name && s.notes) return callNotes(s)
    if (s.orch && orch.some((x) => x.name === name)) return callOrchTool(s.orch, name, args)
    if (s.app && APP_TOOLS.some((x) => x.name === name)) return callAppTool(s.app, name, args)
    if (name === WAIT_TOOL.name && s.wait) {
      const text = await s.wait()
      return { content: [{ type: 'text', text: text ?? '用户已经离开了这个对话，本轮到此结束。' }] }
    }
    return { content: [{ type: 'text', text: `没有这个工具：${name}` }], isError: true }
  }
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        // 额外告诉桥接扩展这一轮挂没挂编排工具：它据此决定要不要核对核心工具。
        // 压缩轮、原生审查轮只挂提问工具（见 runner 里 def.mcp && !op），清单里本来就没有核心编排工具，
        // 不声明这一项的话扩展只能按服务名猜，会把这种正常情况报成「工具清单不完整」（见 shared/clis/pi.json 的扩展）。
        // 值必须是对象：MCP 的 capabilities.experimental 是 Record<string, object>，写成布尔值
        // Claude Code（2.1.226 起按 zod 校验）会判整个握手失败、一个工具都不注册
        capabilities: { tools: {}, experimental: { orchestration: { enabled: !!s.orch } } },
        serverInfo: { name: 'agent-panel', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      // 会话栏的上下文细分按这份算 MCP 工具占了多少（见 shared/context-breakdown.ts）
      s.onTools?.(tools.map(toolChars), deferred.map(toolChars))
      return reply({ tools })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = msg.params?.arguments ?? {}
      if (name === MORE_TOOLS && deferred.length) {
        const r = moreTools(deferred, args)
        return reply('call' in r ? await call(r.call, r.args) : r)
      }
      // 收起来的工具直接按名字调也照样执行：保活的旧进程、记住了工具名的模型都会这么调
      return reply(await call(name, args))
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } }
  }
}

/**
 * 开一个面板工具通道：url 交给 CLI，close 在这一轮结束时调用（还没回答的问题作废）。
 * ask 是向用户提问；notes 取用户在这轮执行中补充的信息（CLI 没有插话协议时用）；
 * wait 等用户在这个对话里的下一句；orch 是编排工具；app 是操控软件的动作（调用者）。都不给就别开
 */
export function openAskBridge(o: {
  ask?: Ask
  notes?: () => string[]
  wait?: () => Promise<string | null>
  orch?: Orchestra
  app?: ActionCaller
  /** CLI 取了工具清单：直接列出的和收进 more_tools 的各自多少字 */
  onTools?: (listed: ToolChars[], deferred: ToolChars[]) => void
}) {
  const token = randomUUID()
  const s = { ...o, pending: new Set<(r: AskReply) => void>() }
  sessions.set(token, s)
  const port = Number(process.env.PORT ?? 8787)
  return {
    url: `http://127.0.0.1:${port}/api/mcp/ask/${token}`,
    close: () => {
      sessions.delete(token)
      for (const r of s.pending) r({ allow: false, message: '这一轮已经结束了' })
    },
  }
}

/**
 * 这个随机地址还有效吗：联网搜索的扩展复用同一份地址（见 server/web-search.ts），
 * 拿已经结束的地址来调时不能继续花用户的密钥额度
 */
export const hasAskSession = (token: string) => sessions.has(token)

export function askMcpApi() {
  return new Hono()
    .post('/ask/:token', async (c) => {
      const s = sessions.get(c.req.param('token'))
      if (!s) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '这一轮已经结束了' } }, 404)
      const body = await c.req.json().catch(() => null)
      const msgs = Array.isArray(body) ? body : [body]
      // 提问、等下一句都可能很久：HTTP 客户端（undici 的 bodyTimeout、Node 的 http 客户端）会因为长时间没有数据
      // 断开请求，所以这些用流式响应，等待期间定期写心跳，有结果后再写回去
      if (msgs.some((m) => m?.method === 'tools/call' && [TOOL.name, WAIT_TOOL.name].includes(m?.params?.name)))
        return streamSSE(c, async (stream) => {
          const beat = setInterval(() => {
            try {
              stream.write(': ping\n\n').catch(() => {})
            } catch {}
          }, HEARTBEAT_MS)
          try {
            const outs = (await Promise.all(msgs.map((m) => handle(s, m)))).filter(Boolean)
            for (const out of outs) await stream.writeSSE({ data: JSON.stringify(out) })
          } finally {
            clearInterval(beat)
          }
        })
      const out = Array.isArray(body)
        ? (await Promise.all(body.map((m) => handle(s, m)))).filter(Boolean)
        : await handle(s, body)
      if (!out || (Array.isArray(out) && !out.length)) return c.body(null, 202)
      return c.json(out)
    })
    .get('/ask/:token', (c) => c.body(null, 405))
    .delete('/ask/:token', (c) => c.body(null, 200))
}

// ---- 配置文件：在用户的项目目录里写 MCP 配置，要合并进已有的内容，用完还原 ----

const parseJson = (text: string): unknown => {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const merge = (a: any, b: any): any =>
  Array.isArray(a) && Array.isArray(b)
    ? [...new Set([...a, ...b])]
    : a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)
      ? { ...a, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, k in a ? merge(a[k], v) : v])) }
      : b

const held = new Map<string, { count: number; original: string | null }>()
/** 同一个文件的读改写排队做：几个子对话共用一个目录时会同时往同一个配置文件里加自己的工具 */
const locks = new Map<string, Promise<unknown>>()
export function lockedFile<T>(file: string, fn: () => Promise<T>) {
  const prev = locks.get(file) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(
    file,
    next.catch(() => {}),
  )
  return next
}

/** 这个令牌的面板工具通道还开着（清理项目里留下的面板条目时，正在用的不能删） */
export const liveAskToken = (token: string) => sessions.has(token)

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const isEmpty = (v: unknown) => (Array.isArray(v) ? !v.length : isObj(v) && !Object.keys(v).length)

/**
 * 从文件现在的内容里撤掉这一轮加进去的部分（original 是第一次写之前的内容）：
 * 只动自己加的键和数组项，用户在执行期间改的别的内容、同时在跑的另几轮加的那一项都留着。
 * 单个值只在还是自己写的那个时才改回原值：同时在跑的另一轮可能已经改成了它要的值
 */
export function unmerge(now: any, added: any, original: any): any {
  if (Array.isArray(now) && Array.isArray(added)) {
    const keep = new Set(Array.isArray(original) ? original : [])
    return now.filter((x) => !added.includes(x) || keep.has(x))
  }
  if (!isObj(now) || !isObj(added)) return now
  const out = { ...now }
  for (const [k, v] of Object.entries(added)) {
    if (!(k in out)) continue
    const o = isObj(original) ? original[k] : undefined
    const nested = (isObj(v) && isObj(out[k])) || (Array.isArray(v) && Array.isArray(out[k]))
    if (nested) {
      const r = unmerge(out[k], v, o)
      if (o === undefined && isEmpty(r)) delete out[k]
      else out[k] = r
    } else if (JSON.stringify(out[k]) !== JSON.stringify(v)) continue
    else if (o === undefined) delete out[k]
    else out[k] = o
  }
  return out
}

/**
 * 把配置合并进工作目录里的文件（没有就新建；绝对路径原样用），返回还原的方法。
 * 还原只撤掉这一轮自己加的那几项，不把整个文件写回执行前的样子：同时在跑的另几轮的条目不受影响，
 * 执行期间用户（或别的程序）在同一个文件里改的内容也不会被冲掉。文件是这一轮新建的、撤完只剩空壳就删掉。
 * 写到一半失败时把已经写的还原再抛出：调用方据此不加引用这些文件的参数（例如 Pi 的 -e 指向不存在的文件会直接起不来）
 */
export async function applyConfigFiles(cwd: string, files: { path: string; content: unknown }[]) {
  const done: { to: string; content: unknown; original: string | null }[] = []
  const restore = async () => {
    for (const d of done.splice(0)) {
      const h = held.get(d.to)
      const last = !h || --h.count <= 0
      if (last) held.delete(d.to)
      // 字符串是整个文件的内容（Pi 的桥接扩展）：最后一轮结束时删掉或写回原文
      if (typeof d.content === 'string') {
        if (!last) continue
        if (d.original === null) await rm(d.to, { force: true })
        else await writeFile(d.to, d.original)
        continue
      }
      await lockedFile(d.to, async () => {
        if (!existsSync(d.to)) return
        const now = parseJson(await readFile(d.to, 'utf8').catch(() => ''))
        // 用户把文件改成读不懂的样子了：不动它
        if (now === undefined) return
        const before = d.original === null ? undefined : parseJson(d.original)
        const out = unmerge(now, d.content, before)
        if (d.original === null && isEmpty(out)) await rm(d.to, { force: true })
        // 撤完和执行前一样：原文写回去，用户的格式（缩进、换行）不变
        else if (d.original !== null && JSON.stringify(out) === JSON.stringify(before))
          await writeFile(d.to, d.original)
        else await writeFile(d.to, JSON.stringify(out, null, 2))
      })
    }
  }
  try {
    await writeAll(cwd, files, done)
  } catch (e) {
    await restore().catch(() => {})
    throw e
  }
  return restore
}

async function writeAll(
  cwd: string,
  files: { path: string; content: unknown }[],
  done: { to: string; content: unknown; original: string | null }[],
) {
  for (const f of files) {
    const to = path.resolve(cwd, f.path)
    const cur = held.get(to)
    if (cur) cur.count++
    else {
      held.set(to, { count: 1, original: existsSync(to) ? await readFile(to, 'utf8') : null })
    }
    const original = held.get(to)!.original
    // 读不懂的原配置不动它，这一轮没有面板工具
    if (typeof f.content !== 'string' && original && parseJson(original) === undefined) {
      done.push({ to, content: {}, original })
      continue
    }
    done.push({ to, content: f.content, original })
    // 字符串是整个文件的内容（例如 Pi 的扩展脚本），直接写，不合并
    if (typeof f.content === 'string') {
      await mkdir(path.dirname(to), { recursive: true })
      await writeFile(to, f.content)
      continue
    }
    // 合并进文件现在的内容：同一个目录里同时在跑的几轮各用一个名字，谁都不会把别人的那一项冲掉
    await lockedFile(to, async () => {
      const now = existsSync(to) ? parseJson(await readFile(to, 'utf8').catch(() => '')) : undefined
      await mkdir(path.dirname(to), { recursive: true })
      await writeFile(to, JSON.stringify(merge(now ?? parseJson(original ?? '') ?? {}, f.content), null, 2))
    })
  }
}
