import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOC_PLACE_INSIDE,
  DOC_PLACE_SIBLING,
  docRootText,
  exposesForVcs,
  isInside,
  paramsForVcs,
  resolveDocRoot,
} from './doc-root.ts'
import type { AgentParam } from './schema.ts'

test('文档根：P4 / SVN 默认是项目外层同级 ProjectDoc/docs，可选项目内 docs，以前手填的旧值按默认算，Git 不算', () => {
  const d = resolveDocRoot('D:\\Work\\Game\\Client', 'p4', {})!
  assert.equal(d.root, 'D:\\Work\\Game\\ProjectDoc\\docs')
  assert.equal(d.outside, true)
  const s = resolveDocRoot('/work/game/client/', 'svn', { docRoot: DOC_PLACE_SIBLING })!
  assert.equal(s.root, '/work/game/ProjectDoc/docs')
  assert.equal(s.outside, true)

  const inside = resolveDocRoot('D:\\Work\\Game', 'p4', { docRoot: DOC_PLACE_INSIDE })!
  assert.equal(inside.root, 'D:\\Work\\Game\\docs')
  assert.equal(inside.outside, false)
  // 以前手填的路径、旧版的 docPlace 参数：不在下拉里的按默认算，旧版选了项目内的仍是项目内
  assert.equal(resolveDocRoot('/w/game', 'p4', { docRoot: '../ProjectDoc/game' })!.root, '/w/ProjectDoc/docs')
  assert.equal(resolveDocRoot('/w/game', 'p4', { docPlace: DOC_PLACE_INSIDE })!.root, '/w/game/docs')

  assert.equal(resolveDocRoot('/w/game', 'git', {}), undefined)
  assert.equal(resolveDocRoot('/w/game', 'none', {}), undefined)
  assert.equal(docRootText(undefined), '')
})

test('isInside：Windows 路径不分大小写，前缀相同的兄弟目录不算', () => {
  assert.equal(isInside('d:/work/game/docs/a.md', 'D:\\Work\\Game'), true)
  assert.equal(isInside('/w/game-docs/a.md', '/w/game'), false)
  assert.equal(isInside('/w/game', '/w/game/'), true)
})

test('提示词写明项目外文档不做 P4 / SVN 操作；「文档根」下拉只在 P4 项目显示', () => {
  const out = docRootText(resolveDocRoot('/w/game', 'p4', {}))
  assert.match(out, /`\/w\/ProjectDoc\/docs`/)
  assert.match(out, /不 p4 add \/ edit/)
  assert.match(out, /不放进任何 changelist/)
  assert.match(docRootText(resolveDocRoot('/w/game', 'svn', {})), /不 svn add/)
  assert.match(docRootText(resolveDocRoot('/w/game', 'p4', { docRoot: DOC_PLACE_INSIDE })), /纳入版本管理/)

  // 「文档根」下拉只在 P4 项目的设置里显示，别的参数照常
  const ps = [{ key: 'docRoot' }, { key: 'lang' }] as AgentParam[]
  assert.deepEqual(
    paramsForVcs(ps, 'git').map((p) => p.key),
    ['lang'],
  )
  assert.deepEqual(
    paramsForVcs(ps, 'p4').map((p) => p.key),
    ['docRoot', 'lang'],
  )
  assert.deepEqual(
    paramsForVcs(ps, 'svn').map((p) => p.key),
    ['lang'],
  )
  // 工作流暴露项里指向文档根的那一项也一样
  const ex = [
    { key: 'docRoot', target: 'agent', targetId: 'docRoot' },
    { key: 'commitPolicy', target: 'agent', targetId: 'commitPolicy' },
  ]
  assert.deepEqual(
    exposesForVcs(ex, 'git').map((e) => e.key),
    ['commitPolicy'],
  )
  assert.deepEqual(
    exposesForVcs(ex, 'p4').map((e) => e.key),
    ['docRoot', 'commitPolicy'],
  )
})
