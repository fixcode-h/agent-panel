// 文档根变化事件（server/docs/root-cache.ts 的 onDocRootChange）：重算出来不一样才发；共用文档根换位置时让订阅方重新问
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'docroot-ev-'))
const { cachedDocRoot, forgetDocRoots, onDocRootChange } = await import('./root-cache.ts')

test('项目改了且文档根真的变了才发事件，没变不发；forgetDocRoots 给每个项目发一次「重新问」', async () => {
  const got: [string, string | undefined][] = []
  const off = onDocRootChange((id, root) => got.push([id, root]))
  let root = '/a/docs'
  const p = (updatedAt: string) => ({ id: 'p1', path: '/a', updatedAt }) as never
  await cachedDocRoot(p('1'), async () => root)
  await cachedDocRoot(p('2'), async () => root)
  assert.deepEqual(got, [], '第一次算、项目改了但文档根没变：不发')
  root = '/b/docs'
  await cachedDocRoot(p('3'), async () => root)
  assert.deepEqual(got, [['p1', '/b/docs']])
  forgetDocRoots()
  assert.deepEqual(got.at(-1), ['p1', undefined])
  off()
})
