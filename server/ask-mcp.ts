import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AskQuestion } from '../shared/schema.ts'
import type { AskReply, CliEvent } from './exec/parsers.ts'

/**
 * 给没有「向用户提问」通道的 CLI（无界面运行的 Command Code、Gemini CLI）一个提问工具：
 * 面板起一个只在这一轮有效的 MCP 服务，工具 ask_user 一直等到用户在页面上回答，再把回答交回给模型。
 * Claude Code、Codex 有自己的提问协议，不走这里。
 *
 * 同一轮里还能挂上 read_user_notes：CLI 没有插话协议时（见 CLI 配置的 notes），
 * 用户在它执行中发的要求先排进队列，模型用这个工具取走——取走的那些从队列里去掉，没取的等这一轮结束后照常处理。
 */

type AskEvent = Extract<CliEvent, { type: 'ask' }>
export type Ask = (ev: AskEvent) => void

/** 提问的等待可能很久（用户不在电脑前），期间定期往流里写一行注释当心跳，免得 HTTP 客户端判定连接空闲 */
const HEARTBEAT_MS = 20_000

const sessions = new Map<string, { ask?: Ask; notes?: () => string[]; pending: Set<(r: AskReply) => void> }>()

const TOOL = {
  name: 'ask_user',
  description:
    '向用户提问并等他在界面上回答。需要用户做选择、补充信息、确认方向时用它，不要把问题写成普通文字。一次可以问几个相关的问题；每个问题给 2~4 个选项，推荐的放第一位并在 label 末尾标「（推荐）」；用户也能自己填写别的答案。',
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
            multiSelect: { type: 'boolean', description: '能不能多选' },
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
    '取用户在你这轮执行中补充的信息。做比较久的事（跑命令、改多处文件、等测试）中间看一眼，取到就结合它继续当前的任务，不要从头重做。取过一次的这些就不会再给；没有时说「没有新的补充」，不要反复调用。',
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

/** 取执行中的补充：拿到的同时从排队里去掉（队列里已经没有了就不算数，例如用户刚撤回了） */
function callNotes(s: NonNullable<ReturnType<typeof sessions.get>>) {
  const list = s.notes?.() ?? []
  return { content: [{ type: 'text', text: list.length ? list.join('\n\n') : '没有新的补充' }] }
}

async function handle(s: NonNullable<ReturnType<typeof sessions.get>>, msg: any) {
  if (msg?.id === undefined || msg?.id === null) return undefined
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  const tools = [...(s.ask ? [TOOL] : []), ...(s.notes ? [NOTES_TOOL] : [])]
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-panel-ask', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools })
    case 'tools/call': {
      const name = msg.params?.name
      if (name === TOOL.name && s.ask) return reply(await callAsk(s, msg.params?.arguments ?? {}))
      if (name === NOTES_TOOL.name && s.notes) return reply(callNotes(s))
      return reply({ content: [{ type: 'text', text: `没有这个工具：${name}` }], isError: true })
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } }
  }
}

/**
 * 开一个面板工具通道：url 交给 CLI，close 在这一轮结束时调用（还没回答的问题作废）。
 * ask 是向用户提问；notes 取用户在这轮执行中补充的信息（CLI 没有插话协议时用）。两个都不给就别开
 */
export function openAskBridge(o: { ask?: Ask; notes?: () => string[] }) {
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

export function askMcpApi() {
  return new Hono()
    .post('/ask/:token', async (c) => {
      const s = sessions.get(c.req.param('token'))
      if (!s) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '这一轮已经结束了' } }, 404)
      const body = await c.req.json().catch(() => null)
      const msgs = Array.isArray(body) ? body : [body]
      // 提问一直挂到用户回答，可能很久：HTTP 客户端（undici 的 bodyTimeout、Node 的 http 客户端）会因为长时间没有数据
      // 断开请求，所以这条用流式响应，等待期间定期写心跳，回答后再把结果写回去
      if (msgs.some((m) => m?.method === 'tools/call' && m?.params?.name === TOOL.name))
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

export const merge = (a: any, b: any): any =>
  Array.isArray(a) && Array.isArray(b)
    ? [...new Set([...a, ...b])]
    : a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)
      ? { ...a, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, k in a ? merge(a[k], v) : v])) }
      : b

const held = new Map<string, { count: number; original: string | null }>()

/** 把配置合并进工作目录里的文件（没有就新建），返回还原的方法；同一个文件被几轮同时用时，最后一轮结束才还原 */
export async function applyConfigFiles(cwd: string, files: { path: string; content: unknown }[]) {
  const done: string[] = []
  for (const f of files) {
    const to = path.join(cwd, f.path)
    const cur = held.get(to)
    if (cur) cur.count++
    else {
      held.set(to, { count: 1, original: existsSync(to) ? await readFile(to, 'utf8') : null })
    }
    done.push(to)
    // 字符串是整个文件的内容（例如 Pi 的扩展脚本），直接写，不合并
    if (typeof f.content === 'string') {
      await mkdir(path.dirname(to), { recursive: true })
      await writeFile(to, f.content)
      continue
    }
    let base: unknown = {}
    const original = held.get(to)!.original
    if (original) {
      try {
        base = JSON.parse(original)
      } catch {
        // 读不懂的配置不动它，这一轮没有提问工具
        base = undefined
      }
    }
    if (base === undefined) continue
    await mkdir(path.dirname(to), { recursive: true })
    // 并行的几轮各自合并同一份原文，内容一样，不会互相覆盖
    await writeFile(to, JSON.stringify(merge(base, f.content), null, 2))
  }
  return async () => {
    for (const to of done) {
      const h = held.get(to)
      if (!h || --h.count > 0) continue
      held.delete(to)
      if (h.original === null) await rm(to, { force: true })
      else await writeFile(to, h.original)
    }
  }
}
