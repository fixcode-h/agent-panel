/**
 * 模型请求轨迹（cli-trace.ts）：状态诊断靠它说清「等待模型」卡在哪一步。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliTrace, traceCli, tracedEvents } from './cli-trace.ts'
import type { CliEvent } from './parsers.ts'

test('模型请求轨迹：请求开始、第一段输出、重试、接上、这一轮结束；子任务和对话本身各记各的', () => {
  const seen: CliEvent[] = []
  const on = tracedEvents('t1', '', (ev) => seen.push(ev))
  on({ type: 'session', id: 's' })
  on({ type: 'request_start' })
  assert.equal(seen.length, 2, '事件照常交给调用方')
  let tr = cliTrace('t1')!
  assert.equal(tr.requests, 1)
  assert.ok(tr.requestAt)
  assert.equal(tr.firstOutputAt, undefined, '还没有输出：正在等模型')
  on({ type: 'notice', text: '重试', kind: 'retry', attempt: 2, error: '529 overloaded' })
  tr = cliTrace('t1')!
  assert.deepEqual({ attempt: tr.retry?.attempt, error: tr.retry?.error }, { attempt: 2, error: '529 overloaded' })
  on({ type: 'text_delta', text: '好' })
  tr = cliTrace('t1')!
  assert.ok(tr.firstOutputAt && tr.lastOutputAt, '有了输出')
  assert.equal(tr.retry, undefined, '模型又出内容了：重试接上了')
  assert.equal(tr.lastEvent, 'text_delta')
  // 用量、待办这些是元数据，不算模型在输出
  const before = tr.lastOutputAt
  traceCli('t1', '', { type: 'usage', model: 'x' } as CliEvent, (before ?? 0) + 5000)
  assert.equal(cliTrace('t1')!.lastOutputAt, before)
  on({ type: 'result', ok: true })
  assert.equal(cliTrace('t1')!.resultOk, true)
  // 子任务（同一个对话 id、不同步骤）另起一份，不覆盖对话本身的
  const sub = tracedEvents('t1', 't1/sub/h1', () => {})
  sub({ type: 'request_start' })
  assert.equal(cliTrace('t1', 't1/sub/h1')!.requests, 1)
  assert.equal(cliTrace('t1')!.requests, 1)
  assert.equal(cliTrace('t1')!.resultOk, true, '对话本身那份还在')
  // 新的一次调用：清掉这一步上一次的轨迹
  tracedEvents('t1', '', () => {})
  assert.equal(cliTrace('t1')!.requests, 0)
})

test('不报「请求开始」的 CLI：按调用开始时间算等了多久；常驻进程新一轮的 turn 当成一次请求开始', () => {
  const on = tracedEvents('t2', '', () => {})
  assert.ok(cliTrace('t2')!.startedAt, '记下了这次调用开始的时间')
  on({ type: 'text_delta', text: '一' })
  assert.ok(cliTrace('t2')!.firstOutputAt)
  // Claude Code 结束时报的 turn（带 end）不算
  on({ type: 'turn', end: 'u1' })
  assert.equal(cliTrace('t2')!.requests, 0)
  // Codex 第二轮开始：清掉上一轮的「第一段输出」，这一轮重新算在等模型
  on({ type: 'turn', id: 'turn_2' })
  assert.equal(cliTrace('t2')!.requests, 1)
  assert.equal(cliTrace('t2')!.firstOutputAt, undefined)
})
