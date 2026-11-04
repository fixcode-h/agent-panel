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

test('「请求开始」报得晚的 CLI（Claude Code）：首包从交出去、工具结果回来的那一刻算，并交一个 wait 事件', () => {
  const t0 = 1_000_000
  tracedEvents('t3', '', () => {})
  // 交出任务 → 10 秒后 message_start → 马上有思考：首包是 10 秒，不是零点几秒
  traceCli('t3', '', { type: 'sent' }, t0)
  traceCli('t3', '', { type: 'request_start' }, t0 + 10_000)
  assert.equal(traceCli('t3', '', { type: 'thinking', text: '想', delta: true }, t0 + 10_200), 10_200)
  assert.equal(traceCli('t3', '', { type: 'thinking', text: '再', delta: true }, t0 + 10_300), undefined, '只在第一段')
  // 两个工具并行，以最后一个结果为准
  traceCli('t3', '', { type: 'tool_result', id: 'a', output: '' } as CliEvent, t0 + 20_000)
  traceCli('t3', '', { type: 'tool_result', id: 'b', output: '' } as CliEvent, t0 + 21_000)
  traceCli('t3', '', { type: 'request_start' }, t0 + 30_000)
  assert.equal(traceCli('t3', '', { type: 'text_delta', text: '好' }, t0 + 30_100), 9_100)
  // 一轮结束后等用户的时间不算：没交出去就开始的请求按请求开始算
  traceCli('t3', '', { type: 'result', ok: true }, t0 + 31_000)
  traceCli('t3', '', { type: 'request_start' }, t0 + 90_000)
  assert.equal(traceCli('t3', '', { type: 'text_delta', text: '嗯' }, t0 + 90_500), 500)

  // tracedEvents 在第一段输出前插一个 wait 事件，runner 记进用量
  const seen: CliEvent[] = []
  const on = tracedEvents('t4', '', (ev) => seen.push(ev))
  on({ type: 'sent' })
  on({ type: 'request_start' })
  on({ type: 'text_delta', text: '一' })
  assert.deepEqual(
    seen.map((e) => e.type),
    ['sent', 'request_start', 'wait', 'text_delta'],
  )
})

test('不报「请求开始」的 CLI：工具结果之后的输出清掉记号，下一轮不把等用户的时间算进首包', () => {
  const t0 = 2_000_000
  tracedEvents('t5', '', () => {})
  traceCli('t5', '', { type: 'turn', id: 'a' }, t0)
  traceCli('t5', '', { type: 'text_delta', text: '一' }, t0 + 100)
  traceCli('t5', '', { type: 'tool_result', id: 'x', output: '' } as CliEvent, t0 + 200)
  traceCli('t5', '', { type: 'text_delta', text: '二' }, t0 + 1_000)
  traceCli('t5', '', { type: 'turn', id: 'b' }, t0 + 600_000)
  assert.equal(traceCli('t5', '', { type: 'text_delta', text: '三' }, t0 + 601_000), 1_000)
})
