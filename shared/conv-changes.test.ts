import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convChanges } from './conv-changes.ts'

const turn = (id: string, files: { path: string; add: number; del: number }[], revertedAt?: string) => ({
  id,
  turnChanges: {
    spans: [{ from: `${id}-a`, to: `${id}-b` }],
    files: files.map((f) => ({ ...f, status: 'modified' as const })),
    ...(revertedAt ? { revertedAt } : {}),
  },
})

test('整个对话的改动：各轮按先后合起来，同一文件增删相加，撤销过的轮不算', () => {
  const ch = convChanges([
    { id: 'u1' },
    turn('m1', [
      { path: 'a.ts', add: 3, del: 1 },
      { path: 'b.ts', add: 2, del: 0 },
    ]),
    turn('m2', [{ path: 'c.ts', add: 9, del: 9 }], '2026-01-01T00:00:00Z'),
    turn('m3', [{ path: 'a.ts', add: 1, del: 4 }]),
  ] as never)
  assert.deepEqual(ch.turns, ['m1', 'm3'])
  assert.equal(ch.reverted, 1)
  assert.deepEqual(
    ch.spans.map((s) => s.from),
    ['m1-a', 'm3-a'],
  )
  assert.deepEqual(
    ch.files.map((f) => [f.path, f.add, f.del]),
    [
      ['a.ts', 4, 5],
      ['b.ts', 2, 0],
    ],
  )
})

test('整个对话的改动：都撤销过时没有文件、只记轮数', () => {
  const ch = convChanges([turn('m1', [{ path: 'a.ts', add: 1, del: 0 }], '2026-01-01T00:00:00Z')] as never)
  assert.deepEqual(ch.files, [])
  assert.equal(ch.reverted, 1)
})

test('整个对话的改动：剔除掉的别的对话的文件合起来说明，自己别的轮里改过的不算', () => {
  const m1 = { ...turn('m1', [{ path: 'a.ts', add: 1, del: 0 }]) }
  const m2 = { ...turn('m2', [{ path: 'b.ts', add: 1, del: 0 }]) }
  const m3 = { ...turn('m3', [{ path: 'c.ts', add: 1, del: 0 }], '2026-01-01T00:00:00Z') }
  Object.assign(m1.turnChanges, { others: ['x.ts', 'b.ts'] })
  Object.assign(m2.turnChanges, { others: ['x.ts', 'y.ts'] })
  // 撤销过的那一轮不算
  Object.assign(m3.turnChanges, { others: ['z.ts'] })
  assert.deepEqual(convChanges([m1, m2, m3] as never).others, ['x.ts', 'y.ts'])
  assert.deepEqual(convChanges([turn('m1', [{ path: 'a.ts', add: 1, del: 0 }])] as never).others, [])
})
