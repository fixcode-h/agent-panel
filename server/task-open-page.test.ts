/**
 * `GET /tasks/:id` 的分页和 `GET /tasks/:id/events` 的增量首包：
 * 打开一个很长的对话时只先传最近一段（`?limit=`），往前翻页用 `?before=`；
 * SSE 建连时带上手上那份的版本（`?rev=`，浏览器重连时是 `Last-Event-ID`），
 * 能对上前缀就只发增量，对不上才回整份。不传参数时行为不变。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-open-'))
process.env.AGENT_PANEL_DATA = dir
process.env.AGENT_PANEL_PRESENCE_GRACE_MS = '500'

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask, taskMessageRev } = await import('../shared/task.ts')
const { TaskMessage } = await import('../shared/schema.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()
const at = '2026-10-01T02:00:00.000Z'

const messages = Array.from({ length: 12 }, (_, i) =>
  TaskMessage.parse({ id: `p${i + 1}`, role: 'agent', agentId: '', step: '', text: `第 ${i + 1} 条`, tools: [], at }),
)

await store.create({
  ...newTask({ projectId: '', mode: 'chat', prompt: '很长的对话' } as never, undefined, '', 'open-a'),
  id: 'open-a',
  status: 'done',
  title: '很长的对话',
  messages,
})

type Body = {
  messages: { id: string }[]
  messageTotal?: number
  messageHasMore?: boolean
  messageRev?: string
  messageAnchorMissing?: boolean
}

const page = async (query: string) => {
  const res = await api().routes.request(`/open-a${query}`)
  assert.equal(res.status, 200)
  return (await res.json()) as Body
}

/** SSE 读第一段事件：拿到就断开，不让测试挂在服务端的循环上 */
const firstEvent = async (query: string) => {
  const ac = new AbortController()
  const res = await api().routes.request(`/open-a/events${query}`, { signal: ac.signal })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
    }
  } finally {
    ac.abort()
    await reader.cancel().catch(() => {})
  }
  const chunk = buf.split('\n\n')[0]
  const field = (name: string) =>
    chunk
      .split('\n')
      .find((l) => l.startsWith(`${name}: `))
      ?.slice(name.length + 2) ?? ''
  return { event: field('event'), id: field('id'), data: JSON.parse(field('data') || '{}') }
}

test('不传 limit：仍然回整份对话（老调用方不受影响）', async () => {
  const body = await page('')
  assert.equal(body.messages.length, 12)
  assert.equal(body.messageTotal, undefined, '不截断时不带分页字段')
})

test('limit 只回最近一段，并带上总条数', async () => {
  const body = await page('?limit=5')
  assert.deepEqual(
    body.messages.map((m) => m.id),
    ['p8', 'p9', 'p10', 'p11', 'p12'],
  )
  assert.equal(body.messageTotal, 12)
  assert.equal(body.messageHasMore, true)
})

test('before 往前翻页，翻到头时 hasMore 为 false', async () => {
  const body = await page('?limit=5&before=p8')
  assert.deepEqual(
    body.messages.map((m) => m.id),
    ['p3', 'p4', 'p5', 'p6', 'p7'],
  )
  assert.equal(body.messageHasMore, true)
  const head = await page('?limit=5&before=p3')
  assert.deepEqual(
    head.messages.map((m) => m.id),
    ['p1', 'p2'],
  )
  assert.equal(head.messageHasMore, false)
})

test('翻页的锚点已经被删：回一个标志，不给一页接不上的消息', async () => {
  const body = await page('?limit=5&before=nope')
  assert.deepEqual(body.messages, [])
  assert.equal(body.messageAnchorMissing, true)
  assert.equal(body.messageTotal, 12)
})

test('整份都在这一份里时带上版本：SSE 带它只补发最后一条，不再重传整份', async () => {
  const body = await page('?limit=50')
  assert.equal(body.messages.length, 12, '比 limit 短，整份都在里面')
  assert.equal(body.messageRev, taskMessageRev(messages), '带上整份的版本')

  const patch = await firstEvent(`?rev=${encodeURIComponent(body.messageRev!)}`)
  assert.equal(patch.event, 'patch')
  assert.equal(patch.data.messages.length, 1, '只补发最后一条（它可能还在变）')
  assert.equal(patch.data.total, 12)
})

test('截断的那份不带版本：它不是整份对话的前缀，不能当版本用', async () => {
  const body = await page('?limit=5')
  assert.equal(body.messages.length, 5)
  assert.equal(body.messageRev, undefined)
})

test('SSE 带手上的版本且能对上前缀：首包只发增量，对不上时发整份', async () => {
  const rev = taskMessageRev(messages.slice(0, 9))
  const patch = await firstEvent(`?rev=${encodeURIComponent(rev)}`)
  assert.equal(patch.event, 'patch', '对得上前缀时只补发，不重传整份对话')
  assert.deepEqual(
    patch.data.messages.map((m: { id: string }) => m.id),
    ['p9', 'p10', 'p11', 'p12'],
    '从手上那条开始补（它可能还在变）',
  )
  assert.equal(patch.data.total, 12)
  assert.equal(patch.id, taskMessageRev(messages), '事件带上最新的版本，浏览器重连时自动带回来')

  const full = await firstEvent('')
  assert.equal(full.event, 'full', '没有版本（第一次打开）时发整份')
  assert.equal(full.data.messages.length, 12)

  const stale = await firstEvent(`?rev=${encodeURIComponent('3:p99')}`)
  assert.equal(stale.event, 'full', '对不上就发整份，不猜着拼')
})
