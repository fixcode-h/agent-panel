/**
 * 打开对话时的分页与版本对号：只取最近一段消息（`GET /tasks/:id?limit=`）、
 * 往前翻页（`before=`），以及手上那份对话的版本能不能对上前缀（SSE 增量推送用）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { messagePage, taskMessageRev, taskRevOffset } from './task.ts'
import { TaskMessage } from './schema.ts'

const at = '2026-10-01T02:00:00.000Z'

const msgs = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    TaskMessage.parse({ id: `m${i + 1}`, role: 'agent', agentId: '', step: '', text: `第 ${i + 1} 条`, tools: [], at }),
  )

test('不传 limit 时原样返回全部消息：老调用方（以及不带分页参数的页面）行为不变', () => {
  const all = msgs(120)
  const page = messagePage(all)
  assert.equal(page.messages.length, 120)
  assert.equal(page.total, 120)
  assert.equal(page.hasMore, false)
  assert.equal(page.messages[0].id, 'm1')
  assert.equal(page.messages.at(-1)?.id, 'm120')
})

test('limit 只回最近 N 条，并说明总条数、还有更早的', () => {
  const page = messagePage(msgs(120), 50)
  assert.equal(page.messages.length, 50)
  assert.equal(page.messages[0].id, 'm71', '取的是尾部，不是开头')
  assert.equal(page.messages.at(-1)?.id, 'm120')
  assert.equal(page.total, 120)
  assert.equal(page.hasMore, true)
})

test('before 往前翻一页：取锚点之前的 limit 条，翻到头时 hasMore 为 false', () => {
  const all = msgs(120)
  const first = messagePage(all, 50, 'm71')
  assert.deepEqual(
    first.messages.map((m) => m.id),
    all.slice(20, 70).map((m) => m.id),
  )
  assert.equal(first.hasMore, true, '前面还有 20 条')
  const second = messagePage(all, 50, 'm21')
  assert.equal(second.messages[0].id, 'm1')
  assert.equal(second.hasMore, false, '已经翻到头')
})

test('锚点找不到（那条消息被返工删了）时回一个标志，不猜着给一页', () => {
  const page = messagePage(msgs(30), 10, '不存在')
  assert.deepEqual(page.messages, [], '不给一页：接不上会拼出不连续的对话')
  assert.equal(page.anchorMissing, true)
  assert.equal(page.total, 30)
})

test('不翻页时不算锚点丢失', () => {
  assert.equal(messagePage(msgs(30), 10).anchorMissing, false)
})

test('这条对话比 limit 还短时全部返回，hasMore 为 false', () => {
  const page = messagePage(msgs(3), 50)
  assert.equal(page.messages.length, 3)
  assert.equal(page.hasMore, false)
})

test('版本能对上前缀时给出补发起点，对不上时返回 -1', () => {
  const all = msgs(10)
  // 手上是前 7 条：从第 7 条开始补发（它可能还在变）
  assert.equal(taskRevOffset(all, taskMessageRev(all.slice(0, 7))), 6)
  assert.equal(taskRevOffset(all, taskMessageRev(all)), 9)
  // 条数比现在还多（对话被撤回过）、最后一条不是同一个、格式不对：都发整份
  assert.equal(taskRevOffset(all, taskMessageRev(msgs(12))), -1)
  assert.equal(taskRevOffset(all, `7:m99`), -1)
  assert.equal(taskRevOffset(all, '0:'), -1)
  assert.equal(taskRevOffset(all, 'abc'), -1)
  assert.equal(taskRevOffset(all, ''), -1)
})
