import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-store-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')

const write = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data), 'utf8')
}

const base = (id: string, extra: Record<string, unknown>) => ({
  id,
  projectId: '',
  title: id,
  mode: 'chat',
  status: 'done',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
})

test('旧任务记录没有 turnSeenAt：当作看过，不亮成未读', async () => {
  const chats = path.join(dir, 'tasks', 'chats')
  const done = '2026-10-01T01:00:00.000Z'
  // 早期版本写出来的记录没有 turnSeenAt 这个键
  write(path.join(chats, 'old-done.json'), base('old-done', { turnDoneAt: done }))
  // 新版本写出来的记录带着 turnSeenAt，没看过就保持未读
  write(path.join(chats, 'new-unread.json'), base('new-unread', { turnDoneAt: done, turnSeenAt: '' }))

  const store = createTaskStore()
  const list = await store.list()
  assert.equal(list.find((t) => t.id === 'old-done')?.turnSeenAt, done, '旧记录补成已读')
  assert.equal(list.find((t) => t.id === 'new-unread')?.turnSeenAt, '', '新记录保持未读')
})

test('消息连续更新时对话文件按间隔合并写，窗口内的最后一次一定落地', async () => {
  const store = createTaskStore()
  const task = await store.create({
    projectId: '',
    title: 'stream',
    mode: 'chat',
    status: 'running',
    agentId: '',
    workflowId: '',
    prompt: '',
    attachments: [],
    cli: '',
    model: '',
    effort: '',
    isolate: false,
    askUser: false,
    params: {},
    messages: [],
    steps: [],
    requests: [],
  } as never)
  const file = path.join(dir, 'tasks', 'chats', `${task.id}.messages.json`)
  const ids = () => JSON.parse(readFileSync(file, 'utf8')).map((m: { id: string }) => m.id)
  assert.deepEqual(ids(), [], '创建时就写入空对话')

  // 流式输出：同一秒里连着更新好几次，不应该每次都把整个对话文件重写一遍
  for (let i = 0; i < 6; i++)
    await store.update(task.id, {
      ...task,
      messages: [{ id: `m${i}`, role: 'agent', text: `输出 ${i}`, tools: [], at: '' }],
    } as never)
  assert.deepEqual(ids(), [], '窗口内不写，避免每次都重写几 MB 的对话文件')

  // 窗口过去后写到最新的一份
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(ids(), ['m5'], '窗口结束后写最后一次更新的内容')

  // 删除时窗口里等着的那份一起丢掉，不会删完又写回来
  await store.update(task.id, {
    ...task,
    messages: [{ id: 'm9', role: 'agent', text: '删除前', tools: [], at: '' }],
  } as never)
  await store.remove(task.id)
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(existsSync(file), false, '删掉的任务不会被定时器写回来')
})

test('同时在跑的对话超过内存里留的份数：落盘带着完整对话时照样写对，peek 只给任务本身', async () => {
  const store = createTaskStore()
  const make = (title: string) =>
    store.create({
      projectId: '',
      title,
      mode: 'chat',
      status: 'running',
      agentId: '',
      workflowId: '',
      prompt: '',
      attachments: [],
      cli: '',
      model: '',
      effort: '',
      isolate: false,
      askUser: false,
      params: {},
      messages: [{ id: 'u', role: 'user', text: '做事', tools: [], at: '' }],
      steps: [],
      requests: [],
    } as never)
  const first = await make('first')
  // 把第一个挤出内存（内存里只留十几份完整对话）
  for (let i = 0; i < 20; i++) await make(`other-${i}`)
  const messages = [
    { id: 'u', role: 'user', text: '做事', tools: [], at: '' },
    { id: 'a', role: 'agent', text: '做完了', tools: [], at: '' },
  ]
  const saved = await store.update(first.id, { ...first, title: 'renamed', messages } as never)
  assert.equal(saved?.title, 'renamed')
  assert.deepEqual(
    saved?.messages.map((m) => m.id),
    ['u', 'a'],
  )
  const head = await store.peek(first.id)
  assert.equal(head?.title, 'renamed')
  assert.deepEqual(
    head?.messages.map((m) => m.id),
    ['u'],
    'peek 只带用户消息，不读对话文件',
  )
  assert.deepEqual(
    (await store.get(first.id))?.messages.map((m) => m.id),
    ['u', 'a'],
  )
})
