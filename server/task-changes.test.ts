import assert from 'node:assert/strict'
import test from 'node:test'
import { changesSince, ownedChanges } from '../shared/task.ts'

const change = (path: string, add: number, del = 0) => ({ path, add, del })

test('节点自己的改动只认 CLI 报告的文件', () => {
  const since = [change('server/a.ts', 3), change('shared/b.ts', 2, 1)]
  assert.deepEqual(ownedChanges(since, new Set(['server/a.ts'])), [change('server/a.ts', 3)])
})

test('CLI 没报告过文件（只读节点）：工作区差值不算给它', () => {
  // 没报告文件的节点不产生 file 事件，差值里是同一工作区并行子对话改的文件
  const since = [change('server/a.ts', 32), change('shared/b.ts', 28)]
  assert.deepEqual(ownedChanges(since, new Set()), [])
})

test('差值里已经没有报告过的文件时返回空', () => {
  assert.deepEqual(ownedChanges([change('server/c.ts', 1)], new Set(['server/a.ts'])), [])
})

test('changesSince 仍按节点前后的差值算，供 ownedChanges 过滤', () => {
  const before = [change('server/a.ts', 10, 2)]
  const after = [change('server/a.ts', 12, 3), change('shared/b.ts', 1)]
  assert.deepEqual(changesSince(before, after), [change('server/a.ts', 2, 1), change('shared/b.ts', 1)])
})
