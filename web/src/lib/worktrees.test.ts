import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorktreeItem } from './api'
import { groupWorktrees, orderWorktrees } from './worktrees'

const item = (
  taskId: string,
  child: boolean,
  createdAt: string,
  state: WorktreeItem['state'] = 'active',
): WorktreeItem => ({
  taskId,
  title: taskId,
  createdAt,
  child,
  working: false,
  branch: `agent-panel/${taskId}`,
  baseBranch: 'main',
  path: `/worktrees/${taskId}`,
  state,
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

test('按删除与否分两组：active 归未删除，merged / discarded 归已删除', () => {
  const list = [
    item('live', true, '2026-02-02T10:00:00.000Z'),
    item('merged', true, '2026-01-01T10:00:00.000Z', 'merged'),
    item('parent', false, '2026-03-03T10:00:00.000Z'),
    item('discarded', true, '2026-01-03T10:00:00.000Z', 'discarded'),
  ]
  const groups = groupWorktrees(list)
  assert.deepEqual(
    groups.live.map((x) => x.taskId),
    ['parent', 'live'],
  )
  assert.deepEqual(
    groups.removed.map((x) => x.taskId),
    ['merged', 'discarded'],
  )
})

test('分组后组内仍走创建时间升序，父对话在它那组的第一位', () => {
  const list = [
    item('late', true, '2026-03-03T10:00:00.000Z'),
    item('removed-parent', false, '2026-03-03T10:00:00.000Z', 'merged'),
    item('early', true, '2026-01-01T10:00:00.000Z'),
    item('removed-kid', true, '2026-01-01T10:00:00.000Z', 'discarded'),
  ]
  const groups = groupWorktrees(list)
  assert.deepEqual(
    groups.live.map((x) => x.taskId),
    ['early', 'late'],
  )
  // 已删除那组里父对话同样排在最前，即使创建时间和子对话一样
  assert.deepEqual(
    groups.removed.map((x) => x.taskId),
    ['removed-parent', 'removed-kid'],
  )
})

test('没有已删除项时那一组是空数组，不改动入参', () => {
  const list = [item('a', true, '2026-01-01T10:00:00.000Z')]
  const groups = groupWorktrees(list)
  assert.deepEqual(
    groups.live.map((x) => x.taskId),
    ['a'],
  )
  assert.deepEqual(groups.removed, [])
  assert.equal(list.length, 1)
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
