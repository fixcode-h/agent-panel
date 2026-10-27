import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskData, TaskMessage } from '../shared/schema.ts'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-store-'))
process.env.AGENT_PANEL_DATA = dir

/** 消息文件按 400ms 窗口合并写：等到目标内容真落地为止，最多等这么久（CI 负载高时窗口会晚于预计） */
const PERSIST_WAIT_TIMEOUT_MS = 5000
/** 轮询间隔：够密才能尽快返回，又不至于空转抢 CPU */
const PERSIST_WAIT_INTERVAL_MS = 20

const { createStampTracker, createTaskStore, messageChars } = await import('./task-store.ts')

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
  // 立即落盘（关键节点就这样调）：不走 400ms 合并窗口，断言才能直接看文件
  await store.update(created.id, { ...created, messages: created.messages }, { now: true })
  assert.equal(readFileSync(file, 'utf8'), marker, '消息没变不重写')

  const ids = (raw: string) => JSON.parse(raw) as { id: string; text: string }[]
  // 消息文件按 400ms 窗口合并写：等到目标内容真的出现在文件里再断言，返回实际等了多久。
  // 固定 sleep 500ms 在高负载（CI）上会读到窗口前的旧内容，那次晚落地不是代码错；
  // 到上限仍未出现就交给下面的断言带等待时长报失败，不静默通过。
  const settle = async (expectedLastText: string) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < PERSIST_WAIT_TIMEOUT_MS) {
      if (ids(readFileSync(file, 'utf8')).at(-1)?.text === expectedLastText) break
      await new Promise((r) => setTimeout(r, PERSIST_WAIT_INTERVAL_MS))
    }
    return Date.now() - startedAt
  }

  // 新增一条：关键节点（changed(true) 就这么调）立即落盘，当场可读
  const added = [...created.messages, msg('c', '第三条')]
  await store.update(created.id, { ...created, messages: added }, { now: true })
  assert.deepEqual(
    ids(readFileSync(file, 'utf8')).map((x) => x.id),
    ['a', 'b', 'c'],
  )

  // 替换最后一条：普通更新（流式中间态）落在窗口里，窗口过去后必须是最新那份
  await store.update(created.id, { ...created, messages: [...added.slice(0, 2), msg('c', '第三条，接着写')] })
  const waited = await settle('第三条，接着写')
  assert.equal(ids(readFileSync(file, 'utf8')).at(-1)?.text, '第三条，接着写', `等了 ${waited}ms 仍未落地`)

  // 返工删消息：回到两条
  await store.update(created.id, { ...created, messages: created.messages }, { now: true })
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

test('合并窗口里紧接着的立即落盘不会被窗口吞掉，也不会被窗口里的旧内容覆盖', async () => {
  const store = createTaskStore()
  const task = await store.create(
    TaskData.parse({ projectId: '', title: '窗口', mode: 'chat', status: 'running', messages: [msg('a', '一')] }),
  )
  const file = path.join(dir, 'tasks', 'chats', `${task.id}.messages.json`)
  const ids = () => (JSON.parse(readFileSync(file, 'utf8')) as { id: string }[]).map((x) => x.id)
  assert.deepEqual(ids(), ['a'], '创建时就写入')

  // 第一次普通更新：落在窗口里，只排队不写
  await store.update(task.id, { ...task, messages: [msg('a', '一'), msg('b', '二')] })
  assert.deepEqual(ids(), ['a'], '窗口内先不写')

  // 紧接着的第二次改动是关键节点（changed(true) 就是这么调的）：必须立即落盘，不能被窗口吞掉
  await store.update(task.id, { ...task, messages: [msg('a', '一'), msg('b', '二'), msg('c', '三')] }, { now: true })
  assert.deepEqual(ids(), ['a', 'b', 'c'], '关键节点立即落盘，不等窗口')

  // 窗口到点不能把更旧的那份（两条）写回来
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(ids(), ['a', 'b', 'c'], '窗口里排着的旧内容作废')
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

test('内存里的完整对话按合计字数限：几个超长对话就把更早的挤出去，读回来内容不变', async () => {
  const store = createTaskStore()
  const big = 'x'.repeat(6_000_000)
  const make = (title: string) =>
    store.create({
      projectId: '',
      title,
      mode: 'chat',
      status: 'done',
      agentId: '',
      workflowId: '',
      steps: [],
      requests: [],
      messages: [
        { id: 'u', role: 'user', text: '做事', tools: [], at: '' },
        { id: 'a', role: 'agent', text: '', tools: [{ kind: 'run', label: 'ls', output: big }], at: '' },
      ],
    } as never)
  const a = await make('a')
  const b = await make('b')
  const c = await make('c')
  assert.equal(messageChars(c.messages), 6_000_000 + 2 + 2)
  // 三个合计 1800 万字符，超过上限：最久没用的 a 不再留在内存里，getMeta 只剩任务文件里的用户消息
  assert.deepEqual(
    (await store.getMeta(a.id))?.messages.map((m) => m.id),
    ['u'],
  )
  assert.deepEqual(
    (await store.getMeta(c.id))?.messages.map((m) => m.id),
    ['u', 'a'],
    '最近用的留着',
  )
  assert.equal((await store.getMeta(b.id))?.messages.length, 2, '最近两个总是留着')
  // 从磁盘读回来的还是完整的
  const back = await store.get(a.id)
  assert.equal(back?.messages[1].tools[0].output?.length, 6_000_000)
})

/** 一个项目目录下的两条真实对话消息（user + agent） */
const conversation = (id: string) => [
  { id: `${id}-u`, role: 'user', text: '帮我看一下这个问题', tools: [], at: '2026-10-25T02:55:00.000Z' },
  { id: `${id}-a`, role: 'agent', text: '看完了', tools: [], at: '2026-10-25T02:56:00.000Z' },
]

test('只有 .messages.json、没有任务记录：从对话重建任务，列表里出现且内容完整', async () => {
  // 断电重启后任务记录丢了、对话文件完好：不能让这个对话从列表里消失
  const project = 'p-rebuild'
  const dirOfProject = path.join(dir, 'tasks', 'projects', project)
  const id = 'only-messages'
  write(path.join(dirOfProject, `${id}.messages.json`), conversation(id))
  assert.equal(existsSync(path.join(dirOfProject, `${id}.json`)), false, '前提：任务记录不存在')

  const list = await createTaskStore().list()
  const task = list.find((t) => t.id === id)
  assert.ok(task, '重建出任务，出现在列表里')
  assert.equal(task.projectId, project, '归回原来的项目')
  assert.equal(task.title, '帮我看一下这个问题', '标题取用户的第一句')
  assert.equal(task.mode, 'chat')
  assert.equal(task.status, 'stopped')
  assert.equal(task.stopReason, 'restart', '当作被重启打断，用户可以继续')
  assert.equal(task.simulated, false, '真实数据不能标成演示')

  // 重建出来的任务记录写回了磁盘：下次启动不用再重建
  const metaFile = path.join(dirOfProject, `${id}.json`)
  assert.ok(existsSync(metaFile), '写出了任务记录文件')
  const saved = JSON.parse(readFileSync(metaFile, 'utf8'))
  assert.equal(saved.id, id)
  assert.deepEqual(
    saved.messages.map((m: { id: string }) => m.id),
    [`${id}-u`],
    '任务记录里只放用户消息（对话本身在消息文件里）',
  )

  // 对话内容完整可打开
  const back = await createTaskStore().get(id)
  assert.deepEqual(
    back?.messages.map((m) => m.id),
    [`${id}-u`, `${id}-a`],
  )
})

test('任务记录损坏（全 0 的空洞文件）：从对话重建，坏文件留档', async () => {
  const project = 'p-broken-meta'
  const dirOfProject = path.join(dir, 'tasks', 'projects', project)
  const id = 'broken-meta'
  write(path.join(dirOfProject, `${id}.messages.json`), conversation(id))
  // Windows 断电的典型产物：长度对得上、内容全是 0x00
  writeFileSync(path.join(dirOfProject, `${id}.json`), Buffer.alloc(2048))

  const task = (await createTaskStore().list()).find((t) => t.id === id)
  assert.ok(task, '任务记录坏了也要出现在列表里')
  assert.equal(task.title, '帮我看一下这个问题')
  // 坏的任务记录挪进了缓存目录留档，不是删掉
  const cacheDir = path.join(dir, 'cache', 'broken')
  const backups = readdirSync(cacheDir).filter((f) => f.startsWith(`${id}.json.broken-`) && !f.endsWith('.broken.json'))
  assert.equal(backups.length, 1, '坏的任务记录被留档')
  assert.equal(readFileSync(path.join(cacheDir, backups[0])).length, 2048, '原样保留原始字节')
  // 重建出来的新记录能正常读到
  assert.ok(existsSync(path.join(dirOfProject, `${id}.json`)))
})

test('对话文件也是全 0：不重建、不伪造，留档后不抛错也不再重试', async () => {
  const project = 'p-broken-messages'
  const dirOfProject = path.join(dir, 'tasks', 'projects', project)
  const id = 'broken-messages'
  mkdirSync(dirOfProject, { recursive: true })
  writeFileSync(path.join(dirOfProject, `${id}.messages.json`), Buffer.alloc(4096))

  // 启动不能因为它失败
  const list = await createTaskStore().list()
  assert.equal(
    list.find((t) => t.id === id),
    undefined,
    '没有可恢复的内容就不出现在列表里',
  )
  assert.equal(existsSync(path.join(dirOfProject, `${id}.json`)), false, '绝不写半截任务记录')
  // 坏对话文件挪进缓存目录留档：下次启动看不到它，不会反复重试
  const cacheDir = path.join(dir, 'cache', 'broken')
  const backups = readdirSync(cacheDir).filter(
    (f) => f.startsWith(`${id}.messages.json.broken-`) && !f.endsWith('.broken.json'),
  )
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(path.join(cacheDir, backups[0])).length, 4096)
  assert.equal(existsSync(path.join(dirOfProject, `${id}.messages.json`)), false)

  // 再启动一次：还是没有它，也不会再产生新的留档（不反复重试）
  assert.equal(
    (await createTaskStore().list()).find((t) => t.id === id),
    undefined,
  )
  assert.equal(
    readdirSync(cacheDir).filter((f) => f.startsWith(`${id}.messages.json.broken-`) && !f.endsWith('.broken.json'))
      .length,
    1,
    '第二次启动不重复归档',
  )
})

test('对话文件能读成 JSON 但内容不是消息列表：不重建，留档', async () => {
  const project = 'p-wrong-shape'
  const dirOfProject = path.join(dir, 'tasks', 'projects', project)
  const id = 'wrong-shape'
  write(path.join(dirOfProject, `${id}.messages.json`), { steps: [], not: 'messages' })

  assert.equal(
    (await createTaskStore().list()).find((t) => t.id === id),
    undefined,
  )
  assert.equal(existsSync(path.join(dirOfProject, `${id}.json`)), false)
  assert.equal(
    existsSync(path.join(dirOfProject, `${id}.messages.json`)),
    false,
    '用不了的文件也留档，免得每次启动重读',
  )
})

test('已经有任务记录的不会被重建覆盖', async () => {
  const project = 'p-keep-meta'
  const dirOfProject = path.join(dir, 'tasks', 'projects', project)
  const id = 'keep-meta'
  // 任务记录和对话文件都在，记录里的标题是用户自己改的：重建会把它盖掉
  write(path.join(dirOfProject, `${id}.json`), base(id, { projectId: project, title: '我自己起的名字' }))
  write(path.join(dirOfProject, `${id}.messages.json`), conversation(id))

  const task = (await createTaskStore().list()).find((t) => t.id === id)
  assert.equal(task?.title, '我自己起的名字')
  assert.equal(JSON.parse(readFileSync(path.join(dirOfProject, `${id}.json`), 'utf8')).title, '我自己起的名字')
})

test('对话文件读不出来（权限 / 占用这类错误）：跳过这一个任务，整个列表照样能用', async () => {
  const project = 'p-unreadable'
  const dirOfProject = path.join(dir, 'tasks', 'projects', project)
  mkdirSync(dirOfProject, { recursive: true })
  // 用一个同名目录顶替文件：readFile 报 EISDIR（不是 ENOENT），模拟「文件在、但读不出来」
  mkdirSync(path.join(dirOfProject, 'unreadable.messages.json'), { recursive: true })
  // 同目录里再放一个正常任务，确认它不受影响
  write(path.join(dirOfProject, 'good.json'), base('good', { projectId: project, title: '正常任务' }))
  write(path.join(dirOfProject, 'good.messages.json'), conversation('good'))

  const store = createTaskStore()
  // 关键：不能因为一个文件读不出来就抛错（抛了的话任务列表整体消失，和这次 bug 的症状一样）
  const list = await store.list()
  assert.equal(list.find((t) => t.id === 'good')?.title, '正常任务')
  assert.equal(
    list.find((t) => t.id === 'unreadable'),
    undefined,
    '读不出来的不伪造',
  )
  // 没有在原位写出一份 meta，也没把它挪走（下次启动还能再试）
  assert.equal(existsSync(path.join(dirOfProject, 'unreadable.json')), false)
  assert.ok(existsSync(path.join(dirOfProject, 'unreadable.messages.json')))
})

test('任务记录过不了 schema 且没能留档：本次可见但不覆盖原文件', async () => {
  const project = 'p-keep-broken-meta'
  const dirOfProject = path.join(dir, 'tasks', 'projects', project)
  const id = 'keep-broken'
  write(path.join(dirOfProject, `${id}.messages.json`), conversation(id))
  // 能读成 JSON、但过不了 Task schema（缺 mode / status 这些必填）
  write(path.join(dirOfProject, `${id}.json`), { id, projectId: project, title: '手改坏了的记录' })
  const metaFile = path.join(dirOfProject, `${id}.json`)
  const before = readFileSync(metaFile, 'utf8')

  // 让归档必然失败：把 cache/broken 本身换成一个普通文件，mkdir 和 rename 到它下面都会失败
  const brokenDir = path.join(dir, 'cache', 'broken')
  rmSync(brokenDir, { recursive: true, force: true })
  mkdirSync(path.dirname(brokenDir), { recursive: true })
  writeFileSync(brokenDir, '占位，不是目录', 'utf8')

  const list = await createTaskStore().list()
  // 原文件一个字节都不能变（新记录不能盖掉那份手改坏的，它可能还能修）
  assert.equal(readFileSync(metaFile, 'utf8'), before, '原来的任务记录没有被覆盖')
  // 这次启动仍然让它可见（能打开、能导出）
  assert.equal(list.find((t) => t.id === id)?.title, '帮我看一下这个问题')
})
