import assert from 'node:assert/strict'
import test from 'node:test'
import { EVENT_PREFIX } from './test-reporter.mjs'
import { FAILURE_LINES, classifyAttempts, failedFiles, failureText, parseEvents, summarize } from './test-results.mjs'
import { retryShards } from './shard-retry.mjs'

const ev = (o) => `${EVENT_PREFIX}${JSON.stringify({ nesting: 0, ms: 1, skip: false, suite: false, ...o })}`

test('汇总：按文件数用例、失败和耗时；describe 和「子用例失败」的外层不重复算', () => {
  const text = [
    'console.log 打出来的杂行',
    ev({ ok: true, name: 'a1', file: '/r/server/a.test.ts', ms: 5 }),
    ev({ ok: false, name: 'b1', file: '/r/server/b.test.ts', nesting: 1, error: '期望 1 实际 2' }),
    ev({ ok: false, name: 'b组', file: '/r/server/b.test.ts', suite: true, wrapper: true, ms: 7 }),
    ev({ ok: true, name: '慢', file: '/r/server/a.test.ts', ms: 2500 }),
    `${EVENT_PREFIX}{坏的 JSON`,
  ].join('\n')
  const events = parseEvents(text)
  assert.equal(events.length, 4)
  const s = summarize(events, '/r')
  const a = s.find((f) => f.file === 'server/a.test.ts')
  const b = s.find((f) => f.file === 'server/b.test.ts')
  assert.deepEqual([a.tests, a.failed, a.ms, a.slow.length], [2, 0, 2505, 1])
  assert.deepEqual([b.tests, b.failed, b.failures.map((x) => x.name)], [1, 1, ['b1']])
  assert.deepEqual(failedFiles(s), ['server/b.test.ts'])
})

test('汇总：文件整个加载失败时按文件路径归到那个文件', () => {
  const s = summarize(
    [{ ok: false, name: '/r/web/x.test.ts', file: '', nesting: 0, ms: 0, error: 'SyntaxError' }],
    '/r',
  )
  assert.deepEqual(failedFiles(s), ['web/x.test.ts'])
})

test('重跑判定：最后一次还失败是真失败，之前失败后来通过是抖动', () => {
  assert.deepEqual(classifyAttempts([['a', 'b'], ['b'], ['b']]), { failed: ['b'], flaky: ['a'] })
  assert.deepEqual(classifyAttempts([['a'], []]), { failed: [], flaky: ['a'] })
  assert.deepEqual(classifyAttempts([[]]), { failed: [], flaky: [] })
})

test('失败详情截到固定行数，完整内容在日志里', () => {
  const long = Array.from({ length: FAILURE_LINES + 5 }, (_, i) => `第 ${i} 行`).join('\n')
  const out = failureText('server/b.test.ts', { name: 'b1', error: long })
  assert.match(out, /^✗ server\/b\.test\.ts › b1/)
  assert.match(out, /还有 5 行，见完整日志/)
  assert.equal(out.split('\n').length, FAILURE_LINES + 2)
})

test('分片重跑：只重跑失败的，重跑通过记成抖动，还失败的保留失败结果', async () => {
  const runs = []
  const results = [
    { file: '01-a.mjs', name: 'a', code: 0 },
    { file: '02-b.mjs', name: 'b', code: 1, out: ['启动', '超时：等不到回复'] },
    { file: '03-c.mjs', name: 'c', code: 1 },
  ]
  const r = await retryShards(
    results,
    async (file) => {
      runs.push(file)
      return { file, name: file.slice(3, 4), code: file === '02-b.mjs' ? 0 : 1 }
    },
    { log: () => {} },
  )
  assert.deepEqual(runs, ['02-b.mjs', '03-c.mjs'])
  assert.deepEqual(r.flaky, ['b'])
  // 抖动报告的明细：第几次通过、第一次失败的输出末尾
  assert.deepEqual(r.detail, [{ unit: 'b', attempts: 2, firstError: '启动\n超时：等不到回复' }])
  assert.deepEqual(
    r.results.map((x) => x.code),
    [0, 0, 1],
  )
})
