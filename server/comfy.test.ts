import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cancelPrompt, submitGraph } from './comfy.ts'

/** 假的 ComfyUI：记下收到的请求，/queue 返回 running 里的那个 prompt */
async function fakeComfy(opts: { running?: string; promptDelay?: number }) {
  const calls: { method: string; path: string; body: string }[] = []
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    for await (const c of req) body += c
    calls.push({ method: req.method ?? '', path: req.url ?? '', body })
    const json = (x: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(x))
    if (req.url === '/prompt') {
      await new Promise((r) => setTimeout(r, opts.promptDelay ?? 0))
      return json({ prompt_id: 'mine' })
    }
    if (req.url === '/queue' && req.method === 'GET')
      return json({ queue_running: opts.running ? [[1, opts.running, {}, {}]] : [], queue_pending: [] })
    if (req.url?.startsWith('/history/')) return json({})
    json({})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, calls, close: () => new Promise((r) => server.close(r)) }
}
const posts = (calls: { method: string; path: string; body: string }[]) =>
  calls.filter((c) => c.method === 'POST' && c.path !== '/prompt').map((c) => `${c.path} ${c.body}`)

test('停止：ComfyUI 正在跑别人的任务时只从队列里删掉自己的，不 interrupt', async () => {
  const c = await fakeComfy({ running: 'other' })
  try {
    await cancelPrompt(c.url, 'mine')
    assert.deepEqual(posts(c.calls), ['/queue {"delete":["mine"]}'])
  } finally {
    await c.close()
  }
})

test('停止：正在跑的就是自己的才 interrupt，并带上 prompt_id', async () => {
  const c = await fakeComfy({ running: 'mine' })
  try {
    await cancelPrompt(c.url, 'mine')
    assert.deepEqual(posts(c.calls), ['/interrupt {"prompt_id":"mine"}'])
  } finally {
    await c.close()
  }
})

test('等 /prompt 返回期间点了停止：拿到 id 后照样从队列里删掉', async () => {
  const c = await fakeComfy({ running: 'other', promptDelay: 150 })
  try {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    await assert.rejects(
      submitGraph({ url: c.url, graph: {}, name: 'x', meta: {}, onImage: () => {} }, ac.signal),
      /已停止|Stopped/,
    )
    // 取消是后台发的：等它发完
    for (let i = 0; i < 50 && !posts(c.calls).length; i++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(posts(c.calls), ['/queue {"delete":["mine"]}'])
  } finally {
    await c.close()
  }
})
