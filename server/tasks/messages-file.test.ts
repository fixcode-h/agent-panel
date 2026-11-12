import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskData, TaskMessage } from '../../shared/schema.ts'

// 对话文件放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-messages-file-'))
process.env.AGENT_PANEL_DATA = dir

const { parseMessagesJsonl, messagesToJsonl } = await import('./messages-file.ts')
const { createTaskStore } = await import('../task-store.ts')

const msg = (id: string, text: string) =>
  TaskMessage.parse({ id, role: 'agent', text, at: '2026-11-12T00:00:00.000Z', tools: [] })
const line = (id: string, text: string) => JSON.stringify(msg(id, text))

test('JSONL：同 id 后出现的盖掉前面的，位置按第一次出现的算', () => {
  const p = parseMessagesJsonl([line('a', '一'), line('b', '二'), line('a', '一，改过'), ''].join('\n'))
  assert.deepEqual(
    p.messages.map((m) => [m.id, m.text]),
    [
      ['a', '一，改过'],
      ['b', '二'],
    ],
  )
  assert.equal(p.lines, 3)
  assert.equal(p.bad, 0)
  assert.equal(p.cleanEnd, true)
})

test('JSONL：崩溃留下的最后半行丢掉，前面的照常读出来', () => {
  const text = [line('a', '一'), line('b', '二'), line('c', '三').slice(0, 20)].join('\n')
  const p = parseMessagesJsonl(text)
  assert.deepEqual(
    p.messages.map((m) => m.id),
    ['a', 'b'],
  )
  assert.equal(p.bad, 1)
  assert.equal(p.badOnlyTail, true, '只坏了最后半行')
  assert.equal(p.cleanEnd, false, '下次追加前要先补换行')
})

test('JSONL：中间的坏行跳过、不算只坏了结尾；过不了 schema 的行也算坏行', () => {
  const p = parseMessagesJsonl([line('a', '一'), '{坏', JSON.stringify({ id: 'x' }), line('b', '二'), ''].join('\n'))
  assert.deepEqual(
    p.messages.map((m) => m.id),
    ['a', 'b'],
  )
  assert.equal(p.bad, 2)
  assert.equal(p.badOnlyTail, false)
})

test('JSONL：整份写出再读回来一样', () => {
  const msgs = [msg('a', '一'), msg('b', '含\n换行')]
  assert.deepEqual(parseMessagesJsonl(messagesToJsonl(msgs)).messages, msgs)
  assert.equal(messagesToJsonl([]), '')
})

const chatFile = (id: string) => path.join(dir, 'tasks', 'chats', `${id}.messages.jsonl`)
const make = (store: ReturnType<typeof createTaskStore>, messages: TaskMessage[]) =>
  store.create(TaskData.parse({ projectId: '', title: 'jsonl', mode: 'chat', status: 'running', messages }))

test('落盘：关键节点时覆盖记录超过有效内容一半就顺手压实', async () => {
  const store = createTaskStore()
  const t = await make(store, [msg('a', '一'), msg('b', '二')])
  await store.update(t.id, { ...t, messages: [msg('a', '一'), msg('b', '二，改过')] }, { now: true })
  assert.equal(readFileSync(chatFile(t.id), 'utf8').trim().split('\n').length, 2, '压实后没有覆盖记录')
})

test('落盘：新消息只追加一行，原地改的消息追加一条覆盖记录，前面写过的字节不动', async () => {
  const store = createTaskStore()
  const t = await make(store, [msg('a', '一')])
  const file = chatFile(t.id)
  const first = readFileSync(file, 'utf8')
  await store.update(t.id, { ...t, messages: [msg('a', '一'), msg('b', '二')] }, { now: true })
  const second = readFileSync(file, 'utf8')
  assert.ok(second.startsWith(first), '追加写，不整份重写')
  assert.equal(second.trim().split('\n').length, 2)
  // 流式输出中间态（不是关键节点）：走合并窗口，flushAll 把它写掉
  await store.update(t.id, { ...t, messages: [msg('a', '一'), msg('b', '二，写完了')] })
  await store.flushAll()
  const third = readFileSync(file, 'utf8')
  assert.ok(third.startsWith(second))
  assert.deepEqual(
    parseMessagesJsonl(third).messages.map((m) => m.text),
    ['一', '二，写完了'],
  )
  // 重启后读回来是归并后的样子
  const again = await createTaskStore().get(t.id)
  assert.deepEqual(
    again?.messages.map((m) => m.text),
    ['一', '二，写完了'],
  )
})

test('落盘：删了消息（返工、回退）就整份重写，不留被删的那条', async () => {
  const store = createTaskStore()
  const t = await make(store, [msg('a', '一'), msg('b', '二'), msg('c', '三')])
  await store.update(t.id, { ...t, messages: [msg('a', '一'), msg('c', '三')] }, { now: true })
  const text = readFileSync(chatFile(t.id), 'utf8')
  assert.equal(text.trim().split('\n').length, 2, '整份重写')
  assert.deepEqual(
    parseMessagesJsonl(text).messages.map((m) => m.id),
    ['a', 'c'],
  )
})

test('落盘：覆盖记录攒到比有效内容还多时整份压实', async () => {
  const store = createTaskStore()
  const t = await make(store, [msg('a', '一')])
  const big = 'x'.repeat(300_000)
  // 流式输出：同一条消息越写越长，每次都追加一份新版本；攒过 2MB 后压实成一行
  for (let i = 1; i <= 12; i++)
    await store.update(t.id, { ...t, messages: [msg('a', big.slice(0, i * 25_000) + i)] }, { now: true })
  const text = readFileSync(chatFile(t.id), 'utf8')
  assert.ok(text.trim().split('\n').length < 12, '压实过')
  assert.equal(parseMessagesJsonl(text).messages[0].text.endsWith('12'), true, '内容是最新的')
})

test('重启后接着写：最后半行不会和新追加的行粘在一起', async () => {
  const store = createTaskStore()
  const t = await make(store, [msg('a', '一')])
  const file = chatFile(t.id)
  // 模拟崩溃：最后一行只写了一半
  writeFileSync(file, readFileSync(file, 'utf8') + line('b', '二').slice(0, 15))
  const fresh = createTaskStore()
  const got = await fresh.get(t.id)
  assert.deepEqual(
    got?.messages.map((m) => m.id),
    ['a'],
  )
  await fresh.update(t.id, { ...got!, messages: [msg('a', '一'), msg('c', '三')] }, { now: true })
  assert.deepEqual(
    (await createTaskStore().get(t.id))?.messages.map((m) => m.id),
    ['a', 'c'],
  )
})

test('还没转换的旧 .messages.json：照样读得出来，第一次写时转成 JSONL、旧文件挪进备份', async () => {
  const chats = path.join(dir, 'tasks', 'chats')
  writeFileSync(
    path.join(chats, 'old-conv.json'),
    JSON.stringify({
      id: 'old-conv',
      projectId: '',
      title: '旧',
      mode: 'chat',
      status: 'done',
      createdAt: '',
      updatedAt: '',
    }),
  )
  writeFileSync(path.join(chats, 'old-conv.messages.json'), JSON.stringify([msg('a', '旧的一条')]))
  const store = createTaskStore()
  const t = await store.get('old-conv')
  assert.deepEqual(
    t?.messages.map((m) => m.text),
    ['旧的一条'],
  )
  await store.update('old-conv', { ...t!, messages: [...t!.messages, msg('b', '新的')] }, { now: true })
  assert.deepEqual(
    parseMessagesJsonl(readFileSync(chatFile('old-conv'), 'utf8')).messages.map((m) => m.id),
    ['a', 'b'],
  )
  assert.ok(!readdirSync(chats).includes('old-conv.messages.json'), '旧文件挪走了')
  const backup = path.join(dir, 'backup', '0003-messages-jsonl', 'tasks', 'chats')
  assert.ok(readdirSync(backup).includes('old-conv.messages.json'), '旧文件在备份目录里')
})
