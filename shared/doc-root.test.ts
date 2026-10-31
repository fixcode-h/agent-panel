import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOC_PLACE_INSIDE, DOC_PLACE_SIBLING, docRootText, isInside, paramsForVcs, resolveDocRoot } from './doc-root.ts'
import type { AgentParam } from './schema.ts'

test('文档根：P4 / SVN 默认和项目同级（项目外），可选项目内，填了文档根按填的，Git 不算', () => {
  const d = resolveDocRoot('D:\\Work\\Game\\Client', 'p4', {})!
  assert.equal(d.root, 'D:\\Work\\Game\\docs')
  assert.equal(d.outside, true)
  const s = resolveDocRoot('/work/game/client/', 'svn', { docPlace: DOC_PLACE_SIBLING })!
  assert.equal(s.root, '/work/game/docs')
  assert.equal(s.outside, true)

  const inside = resolveDocRoot('D:\\Work\\Game', 'p4', { docPlace: DOC_PLACE_INSIDE })!
  assert.equal(inside.root, 'D:\\Work\\Game\\docs')
  assert.equal(inside.outside, false)

  assert.equal(
    resolveDocRoot('/w/game', 'p4', { docRoot: '../ProjectDoc/game', docPlace: DOC_PLACE_INSIDE })!.root,
    '/w/ProjectDoc/game',
  )
  const custom = resolveDocRoot('/w/game', 'p4', { docRoot: 'doc' })!
  assert.equal(custom.root, '/w/game/doc')
  assert.equal(custom.custom, true)
  assert.equal(custom.outside, false)

  assert.equal(resolveDocRoot('/w/game', 'git', {}), undefined)
  assert.equal(resolveDocRoot('/w/game', 'none', {}), undefined)
  assert.equal(docRootText(undefined), '')
})

test('isInside：Windows 路径不分大小写，前缀相同的兄弟目录不算', () => {
  assert.equal(isInside('d:/work/game/docs/a.md', 'D:\\Work\\Game'), true)
  assert.equal(isInside('/w/game-docs/a.md', '/w/game'), false)
  assert.equal(isInside('/w/game', '/w/game/'), true)
})

test('提示词写明项目外文档不做 P4 / SVN 操作；「文档位置」只在 P4 / SVN 项目显示', () => {
  const out = docRootText(resolveDocRoot('/w/game', 'p4', {}))
  assert.match(out, /`\/w\/docs`/)
  assert.match(out, /不 p4 add \/ edit/)
  assert.match(out, /不放进任何 changelist/)
  assert.match(docRootText(resolveDocRoot('/w/game', 'svn', {})), /不 svn add/)
  assert.match(docRootText(resolveDocRoot('/w/game', 'p4', { docPlace: DOC_PLACE_INSIDE })), /纳入版本管理/)

  // 「文档位置」只在 P4 / SVN 项目的设置里显示
  const ps = [{ key: 'docRoot' }, { key: 'docPlace' }] as AgentParam[]
  assert.deepEqual(
    paramsForVcs(ps, 'git').map((p) => p.key),
    ['docRoot'],
  )
  assert.deepEqual(
    paramsForVcs(ps, 'p4').map((p) => p.key),
    ['docRoot', 'docPlace'],
  )
  assert.deepEqual(
    paramsForVcs(ps, 'svn').map((p) => p.key),
    ['docRoot', 'docPlace'],
  )
})
