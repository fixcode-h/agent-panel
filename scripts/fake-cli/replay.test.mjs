import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { replayDelays, replayTurn, replayTurns } from './replay.mjs'

test('回放：按 result 切轮，按 _t 倍速等，_t 不吐出去；录像用完报错结果', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'r.jsonl')
  writeFileSync(
    file,
    [
      { type: 'system', _t: 0 },
      { type: 'assistant', _t: 1000 },
      { type: 'result', _t: 3000 },
      { type: 'system' },
      { type: 'result' },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n'),
  )
  assert.equal(replayTurns(readFileSync(file, 'utf8')).length, 2)
  assert.deepEqual(replayDelays([{ _t: 0 }, { _t: 1000 }, { _t: 3000 }], 10), [0, 100, 200])
  assert.deepEqual(replayDelays([{}, {}], 10), [5, 5])
  const state = path.join(dir, 'state')
  const waits = []
  const got = []
  const run = () =>
    replayTurn({ file, state, write: (l) => got.push(JSON.parse(l)), sleep: async (ms) => void waits.push(ms) })
  assert.equal(await run(), 0)
  assert.deepEqual(
    got.map((x) => x.type),
    ['system', 'assistant', 'result'],
  )
  assert.ok(got.every((x) => !('_t' in x)))
  assert.deepEqual(waits, [0, 100, 200])
  assert.equal(await run(), 1)
  got.length = 0
  assert.equal(await run(), -1)
  assert.equal(got[0].is_error, true)
  assert.match(got[0].result, /只有 2 轮/)
})
