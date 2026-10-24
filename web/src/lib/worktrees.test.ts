import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorktreeItem } from './api'
import { orderWorktrees } from './worktrees'

const item = (taskId: string, child: boolean, createdAt: string): WorktreeItem => ({
  taskId,
  title: taskId,
  createdAt,
  child,
  working: false,
  branch: `agent-panel/${taskId}`,
  baseBranch: 'main',
  path: `/worktrees/${taskId}`,
  state: 'active',
  note: '',
  home: '',
  exists: true,
  ahead: 0,
  dirty: 0,
  merged: false,
})

test('父对话恒在最前：即使它的创建时间最新', () => {
  const list = [item('parent', false, '2026-03-03T10:00:00.000Z'), item('a', true, '2026-01-01T10:00:00.000Z')]
  assert.deepEqual(
    orderWorktrees(list).map((x) => x.taskId),
    ['parent', 'a'],
  )
})

test('子对话按创建时间升序，不按接口返回的顺序', () => {
  const list = [
    item('late', true, '2026-03-03T10:00:00.000Z'),
    item('parent', false, '2026-01-01T10:00:00.000Z'),
    item('early', true, '2026-01-01T10:00:00.000Z'),
    item('middle', true, '2026-02-02T10:00:00.000Z'),
  ]
  assert.deepEqual(
    orderWorktrees(list).map((x) => x.taskId),
    ['parent', 'early', 'middle', 'late'],
  )
})

test('创建时间相同时按 taskId 兜底，顺序稳定且不改动入参', () => {
  const list = [item('b', true, '2026-02-02T10:00:00.000Z'), item('a', true, '2026-02-02T10:00:00.000Z')]
  assert.deepEqual(
    orderWorktrees(list).map((x) => x.taskId),
    ['a', 'b'],
  )
  assert.deepEqual(
    list.map((x) => x.taskId),
    ['b', 'a'],
  )
})
