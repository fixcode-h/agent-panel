import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'doc-roots-'))
const { cachedDocRoot, forgetDocRoots } = await import('./root-cache.ts')

test('文档根算一次就记住：项目改了、文档根换了才重算', async () => {
  let asked = 0
  const ask = async () => {
    asked++
    return '/ws/ProjectDoc/docs'
  }
  const p = { id: 'p1', path: '/ws/Game', updatedAt: '1' } as never
  assert.equal(await cachedDocRoot(p, ask), '/ws/ProjectDoc/docs')
  await Promise.all([cachedDocRoot(p, ask), cachedDocRoot(p, ask)])
  assert.equal(asked, 1, '记住了，不再算')
  await cachedDocRoot({ id: 'p1', path: '/ws/Game', updatedAt: '2' } as never, ask)
  assert.equal(asked, 2, '项目设置改过就重算')
  forgetDocRoots()
  await cachedDocRoot({ id: 'p1', path: '/ws/Game', updatedAt: '2' } as never, ask)
  assert.equal(asked, 3, '文档根换了位置就重算')
})
