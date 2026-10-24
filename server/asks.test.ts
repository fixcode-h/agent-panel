import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askSession, asksOf, closeAsk } from './asks.ts'
import type { AskReply } from './exec/parsers.ts'

const ask = (reply: (r: AskReply) => void) =>
  ({
    type: 'ask',
    kind: 'question',
    title: '用哪个数据库？',
    detail: '',
    options: ['SQLite', 'MySQL'],
    reply,
  }) as Parameters<ReturnType<typeof askSession>['onAsk']>[0]

test('提问窗口的关闭：问题不回答，这次会话终止', () => {
  const got: AskReply[] = []
  let stopped = 0
  const s = askSession('assist:close-1', () => stopped++)
  s.onAsk(ask((r) => got.push(r)))
  const [req] = asksOf('assist:close-1')
  assert.ok(closeAsk(req.id))
  assert.equal(got.length, 1)
  assert.equal(got[0].allow, false, '交回 CLI 的是不回答')
  assert.match(got[0].message ?? '', /不回答/)
  assert.equal(stopped, 1, '会话跟着停掉，和点停止一样')
  assert.deepEqual(asksOf('assist:close-1'), [], '窗口马上收起')
  assert.equal(closeAsk(req.id), false, '再关一次：已经结束了')
})

test('没给停止方法的会话：关闭时停掉自己的 signal，调用方把它并进 CLI 的 signal', () => {
  const s = askSession('style:close-2')
  s.onAsk(ask(() => {}))
  assert.equal(s.signal.aborted, false)
  assert.ok(closeAsk(asksOf('style:close-2')[0].id))
  assert.equal(s.signal.aborted, true)
  s.done()
})
