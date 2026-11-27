import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolUse } from '../../shared/schema.ts'
import { createToolRows } from './tool-rows.ts'

test('工具真正开始跑时（工具前钩子）重新计时：排在前一个调用后面等的时间不算进耗时', () => {
  const toolStart = new Map<ToolUse, number>()
  const rows = createToolRows(() => {}, '', toolStart)
  const read = { kind: 'read', label: 'a.lua' } as ToolUse
  rows.added('toolu_1', read)
  toolStart.set(read, 1000)
  read.startedAt = 1000
  assert.equal(rows.started('toolu_1'), true)
  assert.ok(read.startedAt > 1000)
  assert.equal(toolStart.get(read), read.startedAt)
  // 不认识的 id、已经跑完的调用不动
  assert.equal(rows.started('nope'), false)
  toolStart.delete(read)
  assert.equal(rows.started('toolu_1'), false)
})
