import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import type { AskQuestion } from '../shared/schema.ts'
import type { AskReply, CliEvent } from './exec/parsers.ts'

/**
 * 给没有「向用户提问」通道的 CLI（无界面运行的 Command Code、Gemini CLI）一个提问工具：
 * 面板起一个只在这一轮有效的 MCP 服务，工具 ask_user 一直等到用户在页面上回答，再把回答交回给模型。
 * Claude Code、Codex 有自己的提问协议，不走这里。
 */

type AskEvent = Extract<CliEvent, { type: 'ask' }>
type Ask = (ev: AskEvent) => void

const sessions = new Map<string, { ask: Ask; pending: Set<(r: AskReply) => void> }>()

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
  const qs = toQuestions(args)
  if (!qs.length) return { content: [{ type: 'text', text: 'questions 是空的，每个问题要写 question' }], isError: true }
  const reply = await new Promise<AskReply>((resolve) => {
    s.pending.add(resolve)
    s.ask({
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

async function handle(s: NonNullable<ReturnType<typeof sessions.get>>, msg: any) {
  if (msg?.id === undefined || msg?.id === null) return undefined
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
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
      return reply({ tools: [TOOL] })
    case 'tools/call':
      return reply(
        msg.params?.name === TOOL.name
          ? await callAsk(s, msg.params?.arguments ?? {})
          : { content: [{ type: 'text', text: `没有这个工具：${msg.params?.name}` }], isError: true },
      )
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } }
  }
}

/** 开一个提问通道：url 交给 CLI，close 在这一轮结束时调用（还没回答的问题作废） */
export function openAskBridge(ask: Ask) {
  const token = randomUUID()
  const s = { ask, pending: new Set<(r: AskReply) => void>() }
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

const merge = (a: any, b: any): any =>
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
