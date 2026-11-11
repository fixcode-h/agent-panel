/**
 * 子对话先后依赖（create_conversation 的 after）的判定：前置都合回才开始，失败、没了的交给父对话，其余接着等。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { afterDecision, checkAfter, predState, waitingAfter, type AfterPred } from './child-after.ts'

const pred = (id: string, x: Partial<AfterPred> = {}): AfterPred => ({
  id,
  title: id,
  status: 'running',
  stopReason: undefined,
  resolved: undefined,
  mergedAt: undefined,
  ...x,
})

test('前置合回或完成算 done；失败、删除、归档、换人接手算 bad；暂停、重启只算还在做', () => {
  assert.equal(predState(pred('A', { mergedAt: '2026-11-11T00:00:00Z' })), 'done')
  assert.equal(predState(pred('A', { resolved: true, status: 'done' })), 'done')
  assert.equal(predState(pred('A', { status: 'failed' })), 'bad')
  assert.equal(predState(pred('A', { deletedAt: '2026-11-11T00:00:00Z', mergedAt: 'x' })), 'bad')
  assert.equal(predState(pred('A', { archived: true })), 'bad')
  assert.equal(predState(pred('A', { status: 'stopped', stopReason: 'replaced' })), 'bad')
  assert.equal(predState(pred('A', { status: 'stopped', stopReason: 'user' })), 'pending')
  assert.equal(predState(pred('A', { status: 'stopped', stopReason: 'restart' })), 'pending')
  // 前置自己也在排队：还没开始，接着等
  assert.equal(predState(pred('A', { status: 'stopped', stopReason: 'after' })), 'pending')
  assert.equal(predState(undefined), 'bad')
})

test('前置全部合回才开始；有没做完的接着等，有失败的列出来', () => {
  const all = new Map([
    ['A', pred('A', { mergedAt: 'x' })],
    ['B', pred('B')],
    ['C', pred('C', { status: 'failed' })],
  ])
  const find = (id: string) => all.get(id)
  assert.deepEqual(afterDecision(['A'], find), { start: true })
  assert.deepEqual(afterDecision(['A', 'B'], find), { start: false, bad: [], pending: ['B'] })
  const d = afterDecision(['A', 'C', 'X'], find)
  assert.equal(d.start, false)
  if (!d.start) {
    assert.deepEqual(
      d.bad.map((b) => [b.id, b.why]),
      [
        ['C', '执行失败了'],
        ['X', '已经删除'],
      ],
    )
    assert.deepEqual(d.pending, [])
  }
})

test('after 只能写同一个父对话名下的子对话，去重去空', () => {
  const kids = [
    { ...pred('A'), parentTaskId: 'P' },
    { ...pred('B'), parentTaskId: 'Q' },
    { ...pred('D', { deletedAt: 'x' }), parentTaskId: 'P' },
  ]
  assert.deepEqual(checkAfter(['A', ' A ', ''], kids, 'P'), { ok: true, ids: ['A'] })
  const r = checkAfter(['A', 'B', 'D', 'Z'], kids, 'P')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.info, /B、D、Z/)
})

test('只有停在 after、名单不空的才算在等前置：手动继续过的（stopReason 清掉了）不再由面板启动', () => {
  assert.equal(waitingAfter({ status: 'stopped', stopReason: 'after', waitAfter: ['A'] }), true)
  assert.equal(waitingAfter({ status: 'running', stopReason: undefined, waitAfter: ['A'] }), false)
  assert.equal(waitingAfter({ status: 'stopped', stopReason: 'after', waitAfter: [] }), false)
})
