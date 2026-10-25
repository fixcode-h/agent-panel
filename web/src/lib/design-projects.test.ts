/**
 * UI 项目主页的纯逻辑：项目主页的路由约定、折叠集合、设计列表的排序和按类型分组。
 * 侧栏点项目名和箭头按钮都靠这里判定，界面怎么画不在这里。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '@shared/i18n'
import type { DesignMeta } from '@shared/design'
import {
  DESIGN_HOME,
  designHomeRoute,
  designKind,
  groupByKind,
  kindFoldKey,
  kindLabel,
  projectDesigns,
  projectSummary,
  toggleFoldKey,
} from '@/lib/design-projects'

// 断言里有中文文案，固定语言不会因为环境语言不同而失败
setLang('zh')

// DesignMeta 的 kind 是必填（服务端会补默认值），没有 kind 的老数据用这个模拟
const old = (id: string, projectId: string, updatedAt: string, title = id): DesignMeta =>
  ({ id, projectId, title, updatedAt, createdAt: updatedAt, kind: undefined }) as unknown as DesignMeta

const meta = (id: string, projectId: string, updatedAt: string, kind: 'game' | 'web', title = id): DesignMeta => ({
  id,
  projectId,
  title,
  updatedAt,
  createdAt: updatedAt,
  kind,
})

test('designHomeRoute：项目主页借用 design 页的 id=home，项目 id 放在 sub', () => {
  assert.deepEqual(designHomeRoute('p1'), { page: 'design', id: DESIGN_HOME, sub: 'p1' })
  // 和已有的「新建设计」约定（id='new'）不冲突
  assert.notEqual(DESIGN_HOME, 'new')
})

test('kindFoldKey：分类的折叠键带项目 id，两个项目的同一种分类互不影响', () => {
  assert.equal(kindFoldKey('p1', 'game'), 'p1:game')
  assert.notEqual(kindFoldKey('p1', 'game'), kindFoldKey('p2', 'game'))
})

test('toggleFoldKey：点一下加入、再点删除，不改传进来的集合', () => {
  const folded = new Set(['p1'])
  const once = toggleFoldKey(folded, 'p1:game')
  assert.deepEqual([...once].sort(), ['p1', 'p1:game'])
  assert.deepEqual([...folded], ['p1'], '原来的集合不动')
  assert.deepEqual([...toggleFoldKey(once, 'p1:game')], ['p1'], '再点一次收起回去')
})

test('designKind：老数据没有 kind 时按游戏 UI 算', () => {
  assert.equal(designKind({ kind: 'web' }), 'web')
  assert.equal(designKind({ kind: undefined as unknown as 'game' }), 'game')
})

test('kindLabel：分类名字走翻译，切语言后跟着变', () => {
  assert.equal(kindLabel('game'), '游戏 UI')
  assert.equal(kindLabel('web'), '网页 UI')
  setLang('en')
  assert.equal(kindLabel('game'), 'Game UI')
  setLang('zh')
})

test('projectDesigns：只取这个项目的设计，最近改过的在前，同一时间按标题排', () => {
  const list = [
    meta('a', 'p1', '2026-01-01T00:00:00.000Z', 'game', 'B'),
    meta('b', 'p1', '2026-01-02T00:00:00.000Z', 'web', 'A'),
    meta('c', 'p2', '2026-01-03T00:00:00.000Z', 'game'),
    meta('d', 'p1', '2026-01-02T00:00:00.000Z', 'game', 'A'),
  ]
  assert.deepEqual(
    projectDesigns(list, 'p1').map((d) => d.id),
    ['b', 'd', 'a'],
  )
  assert.deepEqual(projectDesigns(list, 'p3'), [])
})

test('groupByKind：按类型分组，只保留有设计的类型，顺序跟着 DESIGN_KINDS', () => {
  const list = [
    meta('a', 'p1', '2026-01-01T00:00:00.000Z', 'web'),
    meta('b', 'p1', '2026-01-02T00:00:00.000Z', 'game'),
    old('c', 'p1', '2026-01-03T00:00:00.000Z'), // 老数据：游戏 UI
  ]
  const groups = groupByKind(projectDesigns(list, 'p1'))
  assert.deepEqual(
    groups.map((g) => g.kind),
    ['game', 'web'],
  )
  assert.deepEqual(
    groups[0].items.map((d) => d.id),
    ['c', 'b'],
    '组内按最近改动排（排序由 projectDesigns 负责，这里不重排）',
  )
  assert.deepEqual(
    groups[1].items.map((d) => d.id),
    ['a'],
  )
  assert.deepEqual(groupByKind([]), [], '没有设计时没有分组')
})

test('projectSummary：游戏、网页各几个，最近改动时间原样带出', () => {
  const list = [
    meta('a', 'p1', '2026-01-01T00:00:00.000Z', 'web'),
    meta('b', 'p1', '2026-01-02T00:00:00.000Z', 'game'),
    meta('c', 'p1', '2026-01-03T00:00:00.000Z', 'web'),
  ]
  assert.deepEqual(projectSummary(list, '2026-01-03T00:00:00.000Z'), {
    total: 3,
    games: 1,
    webs: 2,
    lastEdit: '2026-01-03T00:00:00.000Z',
  })
  assert.deepEqual(projectSummary([], null), { total: 0, games: 0, webs: 0, lastEdit: null })
})
