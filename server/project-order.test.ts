/**
 * 项目的显示顺序：只和添加时间、拖拽后的顺序有关，和任务时间、执行状态无关。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../shared/i18n.ts'
import { Project } from '../shared/schema.ts'
import { orderProjects, projectOrderError, sortProjects } from '../shared/project-order.ts'

setLang('zh')

const p = (id: string, createdAt: string, sortOrder?: number) => ({ id, createdAt, updatedAt: createdAt, sortOrder })
const ids = (list: { id: string }[]) => list.map((x) => x.id)

test('默认按添加时间升序，先添加的在前', () => {
  const list = [p('c', '2026-10-03T00:00:00Z'), p('a', '2026-10-01T00:00:00Z'), p('b', '2026-10-02T00:00:00Z')]
  assert.deepEqual(ids(sortProjects(list)), ['a', 'b', 'c'])
  // 不改传入的数组
  assert.deepEqual(ids(list), ['c', 'a', 'b'])
})

test('只看添加时间：任务时间、updatedAt 变了也不会往前排', () => {
  const older = { ...p('older', '2026-10-01T00:00:00Z'), updatedAt: '2026-10-09T00:00:00Z' }
  const newer = { ...p('newer', '2026-10-02T00:00:00Z'), updatedAt: '2026-10-02T00:00:00Z' }
  assert.deepEqual(ids(sortProjects([newer, older])), ['older', 'newer'])
})

test('添加时间相同时用 id 兜底，顺序稳定', () => {
  const at = '2026-10-01T00:00:00Z'
  const list = [p('b', at), p('c', at), p('a', at)]
  assert.deepEqual(ids(sortProjects(list)), ['a', 'b', 'c'])
  assert.deepEqual(ids(sortProjects([...list].reverse())), ['a', 'b', 'c'])
})

test('拖拽过（sortOrder > 0）的按编号排，没排过的按添加时间排在后面', () => {
  const list = [p('x', '2026-10-05T00:00:00Z'), p('b', '2026-10-02T00:00:00Z', 2), p('a', '2026-10-03T00:00:00Z', 1)]
  assert.deepEqual(ids(sortProjects(list)), ['a', 'b', 'x'])
})

test('旧数据没有 sortOrder 时按添加时间推断，和新项目混排不报错', () => {
  const old = Project.parse({ id: 'old', name: '旧项目', createdAt: '2026-01-01T00:00:00Z', updatedAt: '' })
  const fresh = Project.parse({ id: 'fresh', name: '新项目', createdAt: '2026-02-01T00:00:00Z', updatedAt: '' })
  assert.equal(old.sortOrder, undefined)
  assert.deepEqual(ids(sortProjects([fresh, old])), ['old', 'fresh'])
})

test('重排校验：重复、不存在、漏掉项目都会被拒绝', () => {
  const list = [p('a', '2026-10-01T00:00:00Z'), p('b', '2026-10-02T00:00:00Z'), p('c', '2026-10-03T00:00:00Z')]
  assert.equal(projectOrderError(list, ['c', 'b', 'a']), null)
  assert.match(projectOrderError(list, ['a', 'a', 'b', 'c'])!, /重复/)
  assert.match(projectOrderError(list, ['a', 'b', 'c', 'nope'])!, /不存在/)
  assert.match(projectOrderError(list, ['a', 'b'])!, /缺/)
  assert.match(projectOrderError(list, [])!, /缺/)
})

test('重排后编号 1、2、3…，旧编号不影响新顺序', () => {
  const list = [p('a', '2026-10-01T00:00:00Z', 1), p('b', '2026-10-02T00:00:00Z', 2), p('c', '2026-10-03T00:00:00Z', 3)]
  const next = orderProjects(list, ['c', 'a', 'b'])
  assert.deepEqual(ids(sortProjects(next)), ['c', 'a', 'b'])
  assert.deepEqual(
    next.map((x) => [x.id, x.sortOrder]),
    [
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ],
  )
  // 重排结果再排一次不会变
  assert.deepEqual(ids(sortProjects(sortProjects(next))), ['c', 'a', 'b'])
})

test('新建的项目没有 sortOrder，落在拖拽过的项目之后', () => {
  const list = [p('a', '2026-10-01T00:00:00Z', 1), p('b', '2026-10-02T00:00:00Z', 2), p('new', '2026-10-04T00:00:00Z')]
  assert.deepEqual(ids(sortProjects(list)), ['a', 'b', 'new'])
})
