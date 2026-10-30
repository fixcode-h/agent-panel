import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { judgeFlakyReport, readFlakyReport, writeFlakyReport } from './flaky-report.mjs'

test('抖动报告：各入口只替换自己这一类，干净的一次会清掉同类的旧条目', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'flaky-report-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(readFlakyReport(root).units, [], '没有报告按没有抖动算')
  writeFlakyReport(root, 'unit', [{ unit: 'a.test.ts', attempts: 2, firstError: 'timeout\nstack' }], 10)
  writeFlakyReport(root, 'e2e', [{ unit: '07-x', attempts: 2, firstError: '' }], 4)
  let r = readFlakyReport(root)
  assert.deepEqual(
    r.units.map((u) => [u.kind, u.unit, u.final]),
    [
      ['unit', 'a.test.ts', 'passed'],
      ['e2e', '07-x', 'passed'],
    ],
  )
  assert.deepEqual(r.rate, { unit: 0.1, e2e: 0.25 })
  const j = judgeFlakyReport(r)
  assert.equal(j.ok, false)
  assert.match(j.lines.join('\n'), /\[unit\] a\.test\.ts（尝试 2 次）\n    首次报错：timeout/)
  // 单测再跑一次没有抖动：只清 unit，e2e 的留着
  writeFlakyReport(root, 'unit', [], 10)
  r = readFlakyReport(root)
  assert.deepEqual(
    r.units.map((u) => u.kind),
    ['e2e'],
  )
  writeFlakyReport(root, 'e2e', [], 4)
  assert.equal(judgeFlakyReport(readFlakyReport(root)).ok, true)
})
