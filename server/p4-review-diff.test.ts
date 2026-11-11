import { test } from 'node:test'
import assert from 'node:assert/strict'
import { p4ReviewDiff } from './p4-review-diff.ts'
import type { P4Run } from './p4-split.ts'

const DIFF = `--- //depot/game/src/a.lua\t2026-11-11 10:00:00
+++ D:\\ws\\game\\src\\a.lua\t2026-11-11 10:05:00
@@ -1,3 +1,4 @@
 local a = 1
+
 local b = 2
`

test('P4 评审差异：p4 diff -du 的结果交给评审，差异里没有的文件另列', async () => {
  const calls: string[][] = []
  const run: P4Run = async (args) => {
    calls.push(args)
    return { ok: true, out: DIFF, err: '' }
  }
  const d = await p4ReviewDiff('/ws', ['src/a.lua', 'src/new.lua'], run)
  assert.deepEqual(calls[0], ['diff', '-du10', 'src/a.lua', 'src/new.lua'])
  assert.equal(d.snapshot, '')
  assert.match(d.diff, /^\+$/m)
  assert.match(d.stat, /^\/\/depot\/game\/src\/a\.lua$/m)
  assert.match(d.stat, /不在差异里[\s\S]*src\/new\.lua/)
  assert.doesNotMatch(d.stat.split('不在差异里')[1], /src\/a\.lua/)
})

test('P4 评审差异：没有文件时不跑 p4，也没有改动', async () => {
  const d = await p4ReviewDiff('/ws', [], async () => assert.fail('不该跑 p4'))
  assert.equal(d.stat, '')
})

test('P4 评审差异：p4 跑不起来时只列文件，不报错', async () => {
  const d = await p4ReviewDiff('/ws', ['src/a.lua'], async () => ({ ok: false, out: '', err: 'p4 启动失败' }))
  assert.equal(d.diff, '')
  assert.match(d.stat, /src\/a\.lua/)
})
