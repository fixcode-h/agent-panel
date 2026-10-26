/**
 * readLog：假 CLI 用 appendFileSync 一行行追加写，读的一方可能撞上「这一行只写了一半」。
 * 这里钉住三种情况：末尾半行丢掉（不算记录）、中间行坏了仍要报错、正常文件照旧读全。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { readLog } from './read-log.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'read-log-test-'))
let n = 0
const write = (content) => {
  const file = path.join(dir, `log-${++n}.jsonl`)
  writeFileSync(file, content)
  return file
}

test('正常文件：每条都读出来', () => {
  const file = write('{"a":1}\n{"a":2}\n')
  assert.deepEqual(
    readLog(file).map((x) => x.a),
    [1, 2],
  )
})

test('末尾正在写的那半行丢掉，前面的照读', () => {
  // 一行完整 + 一行只写了一半（appendFileSync 正在写一个很大的提示词）
  const file = write(`{"a":1,"big":"${'x'.repeat(3000)}"}\n{"a":2,"big":"${'y'.repeat(1000)}`)
  const rows = readLog(file)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].a, 1)
})

test('末尾是半行、前面没有任何完整行：读成空，不抛错', () => {
  const file = write('{"a":')
  assert.deepEqual(readLog(file), [])
})

test('中间行坏了要报错，不能当成「还没写完」吞掉', () => {
  const file = write('{"a":1}\n{不是JSON}\n{"a":3}\n')
  assert.throws(
    () => readLog(file),
    /第 2 行不是完整的 JSON（文件坏了，不是还没写完）/,
    '中间行损坏是真损坏，必须报出来',
  )
})

test('文件不存在：空数组', () => {
  assert.deepEqual(readLog(path.join(dir, 'not-exists.jsonl')), [])
})
