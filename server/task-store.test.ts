import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskData, TaskMessage } from '../shared/schema.ts'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-store-'))
process.env.AGENT_PANEL_DATA = dir

const { createStampTracker, createTaskStore } = await import('./task-store.ts')

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

/** 一条 Agent 回复：带工具输出时才建工具调用（工具输出是指纹里最贵的部分） */
const msg = (id: string, text: string, output = '') =>
  TaskMessage.parse({
    id,
    role: 'agent',
    text,
    at: '2026-10-01T00:00:00.000Z',
    tools: output ? [{ kind: 'run', label: 'npm test', output }] : [],
  })

test('getMeta 只读任务本身，不碰消息文件', async () => {
  const chats = path.join(dir, 'tasks', 'chats')
  write(path.join(chats, 'meta-only.json'), base('meta-only', { usage: { inputTokens: 12 } }))
  // 消息文件故意留成坏的：真去读它就会被当成损坏文件挪走
  const broken = path.join(chats, 'meta-only.messages.json')
  writeFileSync(broken, '{ 坏掉的消息文件', 'utf8')

  const store = createTaskStore()
  const meta = await store.getMeta('meta-only')
  assert.equal(meta?.id, 'meta-only')
  assert.equal(meta?.usage.inputTokens, 12)
  assert.equal(meta?.messages.length, 0, '任务文件里没有消息')
  assert.ok(existsSync(broken), '没读消息文件')

  // 每秒一次的用量统计会反复问同一个任务，问多少遍都不能去读消息文件
  await store.getMeta('meta-only')
  await store.getMeta('meta-only')
  assert.ok(existsSync(broken), '反复调用也不读消息文件')
  assert.equal(await store.getMeta('none'), null)

  // 完整读取才会碰它：坏文件按空处理（损坏的那份被挪进缓存目录）
  const full = await store.get('meta-only')
  assert.equal(full?.messages.length, 0)
  assert.ok(!existsSync(broken), '完整读取才会碰消息文件')
})

test('落盘指纹：新增消息、替换最后一条、返工删消息都能认出来', () => {
  const tracker = createStampTracker()
  const base3 = [msg('a', '第一条', '输出 1'), msg('b', '第二条', '输出 2'), msg('c', '第三条')]
  const stamp = tracker.stamp('t1', base3)
  // 内容没变时指纹必须一样，否则每秒都会白写一次盘
  assert.equal(tracker.stamp('t1', base3), stamp)

  // 新增一条：条数变了
  assert.notEqual(tracker.stamp('t1', [...base3, msg('d', '第四条')]), stamp)

  // 替换最后一条（流式输出一直在改的就是它）
  const replaced = tracker.stamp('t1', [...base3.slice(0, 2), msg('c', '第三条，接着写', '输出 3')])
  assert.notEqual(replaced, stamp)

  // 返工删消息：条数少了、内容还是原来那几条
  const trimmed = tracker.stamp('t1', base3.slice(0, 2))
  assert.notEqual(trimmed, stamp)

  // 删掉的又回来了：指纹跟当时一样，不会因为「回过一趟」就每轮都写盘
  assert.equal(tracker.stamp('t1', base3), stamp)

  // 中间那条被原地改（并发节点会改不是末尾的消息）：骨架变了也要认出来
  assert.notEqual(tracker.stamp('t1', [base3[0], msg('b', '第二条改了'), base3[2]]), stamp)
})

test('落盘指纹：内容没变时只有最后一条重算完整指纹', () => {
  const tracker = createStampTracker()
  const msgs = [msg('a', '第一条', 'x'.repeat(500)), msg('b', '第二条', 'y'.repeat(500)), msg('c', '第三条')]
  tracker.stamp('t2', msgs)
  const before = tracker.stats()
  tracker.stamp('t2', msgs)
  const after = tracker.stats()
  // 剩下的只算骨架（只看长度），不再逐字符扫工具输出
  assert.equal(after.full - before.full, 1, '只有末尾那条重算完整指纹')
  assert.equal(after.shape - before.shape, msgs.length, '每条都算一次骨架')
})

test('落盘指纹：工具输出长度没变、内容变了靠整体核对兜底', () => {
  // 边跑边刷新的状态行：输出长度刚好不变，骨架看不出来。
  // 改的是不是末尾那条很关键：末尾那条每次都重算完整指纹，改它就马上能认出来
  const a = [msg('a', '第一条', 'AAAA'), msg('b', '最后一条')]
  const b = [msg('a', '第一条', 'BBBB'), msg('b', '最后一条')]

  const always = createStampTracker(0)
  assert.notEqual(always.stamp('t3', b), always.stamp('t3', a), '整体核对时能认出来')

  // 默认每 10 秒核对一次：间隔内认不出来，这是换「不再每秒扫一遍全部工具输出」付的代价，
  // 到点之后那次写盘（changed(true) 或下一次核对）会把漏掉的内容补上
  const lazy = createStampTracker(10_000)
  const s = lazy.stamp('t3', a)
  assert.equal(lazy.stamp('t3', b), s, '间隔内只能靠长度类字段判断（改的是中间那条）')
})

test('落盘：消息变了才重写消息文件，新增/替换/返工删除都会重写', async () => {
  const store = createTaskStore()
  const created = await store.create(
    TaskData.parse({
      projectId: '',
      title: '指纹落盘',
      mode: 'chat',
      status: 'done',
      messages: [msg('a', '第一条', '输出 1'), msg('b', '第二条')],
    }),
  )
  const file = path.join(dir, 'tasks', 'chats', `${created.id}.messages.json`)
  // 换成一个能认出来的内容：没重写就还是它
  const marker = '[{"id":"marker","role":"user","text":"手写的","tools":[]}]'
  writeFileSync(file, marker, 'utf8')
  await store.update(created.id, { ...created, messages: created.messages })
  assert.equal(readFileSync(file, 'utf8'), marker, '消息没变不重写')

  const ids = (raw: string) => JSON.parse(raw) as { id: string; text: string }[]
  // 消息文件按 400ms 窗口合并写：等窗口过去再读，否则读到的是上一次落地的那份
  const settle = () => new Promise((r) => setTimeout(r, 500))

  // 新增一条
  const added = [...created.messages, msg('c', '第三条')]
  await store.update(created.id, { ...created, messages: added })
  await settle()
  assert.deepEqual(
    ids(readFileSync(file, 'utf8')).map((x) => x.id),
    ['a', 'b', 'c'],
  )

  // 替换最后一条
  await store.update(created.id, { ...created, messages: [...added.slice(0, 2), msg('c', '第三条，接着写')] })
  await settle()
  assert.equal(ids(readFileSync(file, 'utf8')).at(-1)?.text, '第三条，接着写')

  // 返工删消息：回到两条
  await store.update(created.id, { ...created, messages: created.messages })
  await settle()
  assert.deepEqual(
    ids(readFileSync(file, 'utf8')).map((x) => x.id),
    ['a', 'b'],
  )
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
