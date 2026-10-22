/**
 * 子对话列表：排序规则（先状态分类、同类按本次开启时间）、本次开启时间的口径、
 * 只列进程还活着的、父对话的「有子对话在跑」和 CLI 生命周期约定。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../shared/i18n.ts'
import { Task } from '../shared/schema.ts'
import { childStartedAt, runningChildren, sortChildren, taskSummary } from '../shared/task.ts'

setLang('zh')

const kid = (id: string, over: Partial<Parameters<typeof sortChildren>[0][number]> = {}) => ({
  id,
  title: id,
  status: 'running' as const,
  working: false,
  cliAlive: false,
  startedAt: '2026-10-21T00:00:00.000Z',
  ...over,
})

test('子对话排序：先按状态分类（需要你处理 → 执行中 → 已完成 → 已停止），分类顺序不随时间变', () => {
  const list = [
    kid('stopped', { status: 'stopped', startedAt: '2026-10-21T09:00:00.000Z' }),
    kid('done', { status: 'done', startedAt: '2026-10-21T08:00:00.000Z' }),
    kid('running', { working: true, startedAt: '2026-10-21T07:00:00.000Z' }),
    kid('failed', { status: 'failed', startedAt: '2026-10-21T06:30:00.000Z' }),
    kid('asking', { asking: 1, startedAt: '2026-10-21T06:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['failed', 'asking', 'running', 'done', 'stopped'],
    '失败和提问都算「需要你处理」（这一类里按开启时间倒序）；分类顺序不随开启时间变',
  )
})

test('子对话排序：同一类里按本次开启的时间倒序', () => {
  const list = [
    kid('old', { startedAt: '2026-10-20T10:00:00.000Z' }),
    kid('new', { startedAt: '2026-10-21T09:00:00.000Z' }),
    kid('mid', { startedAt: '2026-10-21T08:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['new', 'mid', 'old'],
    '越新开启的越靠前',
  )
})

test('子对话排序：同时有多个在执行时，它们之间也按本次开启的时间倒序', () => {
  const list = [
    kid('a', { working: true, startedAt: '2026-10-21T07:00:00.000Z' }),
    kid('b', { working: true, startedAt: '2026-10-21T09:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['b', 'a'],
  )
})

test('子对话排序：排序键相同用 id 兜底，同样的数据每次排出来一样', () => {
  const same = '2026-10-21T00:00:00.000Z'
  const list = [kid('c', { startedAt: same }), kid('a', { startedAt: same }), kid('b', { startedAt: same })]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    sortChildren(list.slice().reverse()).map((x) => x.id),
    ['a', 'b', 'c'],
    '传入顺序变了一样排得出来同样的结果',
  )
})

test('本次开启的时间：取最近一轮开始执行的时间，没执行过按创建时间', () => {
  const turn = (startedAt: string) => ({
    id: startedAt,
    title: '做点什么',
    status: 'done' as const,
    startedAt,
    from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
  })
  const task = (createdAt: string, turns: ReturnType<typeof turn>[]) =>
    Task.parse({
      id: 'kid',
      projectId: '',
      title: '子对话',
      mode: 'chat',
      status: 'done',
      messages: [],
      steps: [],
      turns,
      createdAt,
      updatedAt: createdAt,
      working: false,
    })

  assert.equal(childStartedAt(task('2026-10-20T00:00:00.000Z', [])), '2026-10-20T00:00:00.000Z', '没执行过按创建时间')
  const first = task('2026-10-20T00:00:00.000Z', [turn('2026-10-20T00:00:00.000Z')])
  assert.equal(childStartedAt(first), '2026-10-20T00:00:00.000Z')
})

test('子对话排序：做完后又接到新任务的排到最前面', () => {
  const turn = (startedAt: string) => ({
    id: startedAt,
    title: '做点什么',
    status: 'done' as const,
    startedAt,
    from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
  })
  const task = (id: string, createdAt: string, turns: ReturnType<typeof turn>[]) =>
    Task.parse({
      id,
      projectId: '',
      title: id,
      mode: 'chat',
      status: 'done',
      messages: [],
      steps: [],
      turns,
      createdAt,
      updatedAt: createdAt,
      working: false,
    })
  // 两个都是一直等着的子对话：老的先建、新的后建，老的做完后又被派了新任务
  const fresh = task('fresh', '2026-10-21T00:00:00.000Z', [turn('2026-10-21T00:00:00.000Z')])
  const resumed = task('resumed', '2026-10-20T00:00:00.000Z', [
    turn('2026-10-20T00:00:00.000Z'),
    turn('2026-10-21T12:00:00.000Z'),
  ])
  const list = [fresh, resumed].map((x) => ({
    ...kid(x.id, { status: x.status }),
    startedAt: childStartedAt(x),
  }))
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['resumed', 'fresh'],
    '重新接了新任务的按本次开启时间排到最前面',
  )
})

test('子对话排序：计划没做完的归「未完成」，排在执行中后面、已完成前面', () => {
  const list = [
    kid('done', { startedAt: '2026-10-21T09:00:00.000Z' }),
    kid('unfinished', { plan: { done: 7, total: 8 }, startedAt: '2026-10-21T08:00:00.000Z' }),
    kid('running', { working: true, startedAt: '2026-10-21T07:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['running', 'unfinished', 'done'],
    '计划没做完的不算已完成，开启时间再新也压不过执行中的',
  )
})

test('「运行中」只列真正在执行（working）的：只在等下一句的不混进来', () => {
  const list = [
    kid('running', { working: true }),
    kid('waiting', { startedAt: '2026-10-21T09:00:00.000Z' }),
    kid('waitingPlan', { plan: { done: 7, total: 8 } }),
    kid('resolvedRunning', { working: true, resolved: true }),
  ]
  assert.deepEqual(
    runningChildren(list).map((x) => x.id),
    ['running'],
    '等下一句的、计划没做完等着继续的、已解决的都不算运行中',
  )
})

test('子对话排序不改传入的数组', () => {
  const list = [kid('old', { startedAt: '2026-10-20T00:00:00.000Z' }), kid('new')]
  sortChildren(list)
  assert.deepEqual(
    list.map((x) => x.id),
    ['old', 'new'],
  )
})

test('默认只看进程还活着的：cliAlive 决定进不进默认列表，已关闭的只在「全部」里', () => {
  const list = [
    kid('alive', { cliAlive: true, startedAt: '2026-10-20T00:00:00.000Z' }),
    kid('closed', { startedAt: '2026-10-21T00:00:00.000Z' }),
  ]
  assert.deepEqual(
    list.filter((x) => x.cliAlive).map((x) => x.id),
    ['alive'],
    '默认列表只列进程还活着的',
  )
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['closed', 'alive'],
    '「全部」里都列出来，仍然按本次开启的时间倒序',
  )
})

test('父对话的「执行中」：自己有子对话在跑时也算，但不改变完成状态和通知语义', () => {
  const base = {
    id: 'parent',
    projectId: '',
    title: '父对话',
    mode: 'chat',
    status: 'done',
    messages: [],
    steps: [],
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    working: false,
  }
  const parsed = Task.parse(base)
  // 摘要里带上 childrenWorking 时，侧栏据此转圈
  const withKids = taskSummary({ ...parsed, childrenWorking: 2 })
  assert.equal(withKids.childrenWorking, 2)
  assert.equal(withKids.status, 'done', '任务本身仍然是完成：不因为子对话在跑就把状态改成执行中')
  assert.equal(withKids.working, false, '也不是父对话自己在跑')
  // 没有子对话在跑时字段不出现，侧栏按原来的 working 判断
  assert.equal(taskSummary(parsed).childrenWorking, undefined)
})
