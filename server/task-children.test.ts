/**
 * 子对话列表：只列进程还活着的、排序规则、父对话的「有子对话在跑」和 CLI 生命周期约定。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../shared/i18n.ts'
import { sortChildren } from '../shared/task.ts'

setLang('zh')

const kid = (id: string, over: Partial<Parameters<typeof sortChildren>[0][number]> = {}) => ({
  id,
  title: id,
  working: false,
  cliAlive: false,
  lastMessageAt: '2026-10-21T00:00:00.000Z',
  ...over,
})

test('子对话排序：正在执行的排最上面，其余按最近消息时间倒序', () => {
  const list = [
    kid('old', { lastMessageAt: '2026-10-20T10:00:00.000Z' }),
    kid('new', { lastMessageAt: '2026-10-21T09:00:00.000Z' }),
    kid('paused', { working: true, lastMessageAt: '2026-10-19T09:00:00.000Z' }),
    kid('mid', { lastMessageAt: '2026-10-21T08:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['paused', 'new', 'mid', 'old'],
    '执行中的优先，其余越新越靠前',
  )
})

test('子对话排序：同时有多个在执行时，它们之间也按最近消息时间倒序', () => {
  const list = [
    kid('a', { working: true, lastMessageAt: '2026-10-21T07:00:00.000Z' }),
    kid('b', { working: true, lastMessageAt: '2026-10-21T09:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['b', 'a'],
  )
})

test('子对话排序不改传入的数组', () => {
  const list = [kid('old', { lastMessageAt: '2026-10-20T00:00:00.000Z' }), kid('new')]
  sortChildren(list)
  assert.deepEqual(
    list.map((x) => x.id),
    ['old', 'new'],
  )
})

test('默认只看进程还活着的：cliAlive 决定进不进默认列表，已关闭的只在「全部」里', () => {
  const list = [
    kid('alive', { cliAlive: true, lastMessageAt: '2026-10-20T00:00:00.000Z' }),
    kid('closed', { lastMessageAt: '2026-10-21T00:00:00.000Z' }),
  ]
  assert.deepEqual(
    list.filter((x) => x.cliAlive).map((x) => x.id),
    ['alive'],
    '默认列表只列进程还活着的',
  )
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['closed', 'alive'],
    '「全部」里都列出来，仍然按最近消息时间倒序',
  )
})

test('父对话的「执行中」：自己有子对话在跑时也算，但不改变完成状态和通知语义', async () => {
  const { taskSummary } = await import('../shared/task.ts')
  const { Task } = await import('../shared/schema.ts')
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
