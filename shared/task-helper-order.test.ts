import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskStep } from './schema.ts'
import type { ChildEntry } from './task.ts'
import { newestFirst, sortChildren, sortHelpers } from './task.ts'

/** 子任务列表排序只看这四个字段，用最小对象就够 */
const h = (id: string, status: string, startedAt = '') =>
  ({ id, slot: 'sub', status, startedAt }) as unknown as TaskStep

test('子任务列表：同一档里最新的在最上面', () => {
  const list = [
    h('@chat/sub/h1', 'done', '2026-10-24T10:00:00.000Z'),
    h('@chat/sub/h2', 'done', '2026-10-24T10:05:00.000Z'),
    h('@chat/sub/h3', 'done', '2026-10-24T10:02:00.000Z'),
  ]
  assert.deepEqual(
    sortHelpers(list).map((s) => s.id),
    ['@chat/sub/h2', '@chat/sub/h3', '@chat/sub/h1'],
  )
})

test('子任务列表：开始时间相同时按派出序号倒序，旧数据没有时间也不乱', () => {
  const same = [
    h('@chat/sub/h1', 'done', '2026-10-24T10:00:00.000Z'),
    h('@chat/sub/h3', 'done', '2026-10-24T10:00:00.000Z'),
    h('@chat/sub/h2', 'done', '2026-10-24T10:00:00.000Z'),
  ]
  assert.deepEqual(
    sortHelpers(same).map((s) => s.id),
    ['@chat/sub/h3', '@chat/sub/h2', '@chat/sub/h1'],
  )
  // 旧记录、演示数据里 startedAt 可能是空的：全部为空时同样按派出序号倒序，不会退回成派出的先后
  const empty = [h('@chat/sub/h1', 'done'), h('@chat/sub/h2', 'done')]
  assert.deepEqual(
    sortHelpers(empty).map((s) => s.id),
    ['@chat/sub/h2', '@chat/sub/h1'],
  )
})

test('子任务列表：状态档位优先，最新派出的做完的也在执行中下面', () => {
  const list = [
    h('@chat/sub/h1', 'done', '2026-10-24T10:00:00.000Z'),
    h('@chat/sub/h2', 'running', '2026-10-24T09:00:00.000Z'),
    h('@chat/sub/h3', 'pending', ''),
    h('@chat/sub/h4', 'failed', ''),
    h('@chat/sub/h5', 'skipped', ''),
  ]
  assert.deepEqual(
    sortHelpers(list).map((s) => s.id),
    ['@chat/sub/h2', '@chat/sub/h3', '@chat/sub/h4', '@chat/sub/h1', '@chat/sub/h5'],
  )
})

test('newestFirst：没有开始时间时按 id 兜底（也是新的在前），顺序稳定不抖', () => {
  const rows = [
    { id: 'a', startedAt: '' },
    { id: 'b', startedAt: '' },
  ]
  assert.deepEqual(
    rows
      .slice()
      .sort(newestFirst)
      .map((x) => x.id),
    ['b', 'a'],
  )
})

test('子对话排序不变：先按阶段分，同一类里新的在前', () => {
  const row = (id: string, startedAt: string, status = 'done' as const) =>
    ({ id, title: id, status, working: false, cliAlive: true, startedAt }) as unknown as ChildEntry
  const list = [row('c1', '2026-10-24T10:00:00.000Z'), row('c2', '2026-10-24T10:05:00.000Z')]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['c2', 'c1'],
  )
})
