import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentRound, isViewableOutput, splitOutputs, turnOutputCandidates } from './pick.ts'

test('能直接看的：网页、图片、PDF、文档和插件查看器认得的；源代码不算', () => {
  for (const p of ['a/b.html', 'x.SVG', 'shot.png', 'r.pdf', 'docs/说明.md']) assert.ok(isViewableOutput(p), p)
  for (const p of ['src/a.ts', 'a.json', 'Makefile']) assert.ok(!isViewableOutput(p), p)
  assert.ok(isViewableOutput('Content/A.uasset', ['.uasset']))
})

test('这一轮：用户最后一次发话以后，自动接着做的几轮都算；撤销过的不算', () => {
  const ch = (path: string, revertedAt?: string) => ({ spans: [], files: [{ path, add: 1, del: 0 }], revertedAt })
  const msgs = [
    { id: 'u1', role: 'user' as const },
    { id: 'a1', role: 'agent' as const, turnChanges: ch('old.html') },
    { id: 'u2', role: 'user' as const },
    { id: 'a2', role: 'agent' as const, turnChanges: ch('new.html') },
    { id: 's1', role: 'system' as const },
    { id: 'a3', role: 'agent' as const, turnChanges: ch('shot.png') },
    { id: 'a4', role: 'agent' as const, turnChanges: ch('undone.md', 'x') },
  ]
  const c = turnOutputCandidates(currentRound(msgs))
  assert.deepEqual(c, { msgs: ['a2', 'a3'], paths: ['new.html', 'shot.png'] })
  assert.deepEqual(splitOutputs([{ path: 'shot.png' }, { path: 'new.html' }]), {
    html: [{ path: 'new.html' }],
    rest: [{ path: 'shot.png' }],
  })
})
