/**
 * 保存项目时的乐观锁：客户端带着读取时的 updatedAt，服务端值变了就拒绝整份覆盖。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staleProjectWrite } from './project-lock.ts'

test('没带 expectedUpdatedAt 的老请求不校验，保持原来的整份覆盖', () => {
  assert.equal(staleProjectWrite('2026-10-27T00:00:00Z', undefined), false)
})

test('版本一致时照常保存', () => {
  assert.equal(staleProjectWrite('2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z'), false)
})

test('期间被别处改过就判冲突，不拿旧快照覆盖', () => {
  assert.equal(staleProjectWrite('2026-10-27T00:02:00Z', '2026-10-27T00:00:00Z'), true)
})

test('读到的版本是空串、服务端已经有值，判冲突（旧数据不能退化成无锁）', () => {
  assert.equal(staleProjectWrite('2026-10-27T00:00:00Z', ''), true)
})

test('服务端也没有版本（旧数据文件）时无从比对，不拦', () => {
  assert.equal(staleProjectWrite(undefined, ''), false)
  assert.equal(staleProjectWrite('', ''), false)
})

test('项目已经被删掉时不算冲突，交给 update 返回 404', () => {
  assert.equal(staleProjectWrite(undefined, '2026-10-27T00:00:00Z'), false)
})
