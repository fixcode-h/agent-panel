/**
 * 项目经验的文件格式和合并：写出去再读回来一样，同一件事合进旧条目。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectExperience } from '../shared/experience.ts'
import { mergeLearned, parseExperience, renderExperience } from './project-experience.ts'

const sample = ProjectExperience.parse({
  id: 'e1',
  kind: 'locate',
  title: '表格相关的代码在哪',
  body: '配表在 Content/Data，读表代码在 Source/Game/Table。\n第二行',
  keywords: ['表格', '配表'],
  paths: ['Source/Game/Table/**', 'Content/Data'],
  source: 'auto',
  taskIds: ['t1'],
  branch: 'dev',
  createdAt: '2026-11-01T00:00:00.000Z',
})

test('写出去再读回来一样', () => {
  const r = parseExperience(renderExperience(sample))
  assert.equal(r.error, undefined)
  assert.deepEqual(r.item, sample)
})

test('格式不对时报原因，不抛异常', () => {
  assert.ok(parseExperience('随便写的').error)
})

test('同一件事合进旧条目：关键词、路径取并集', () => {
  const add = {
    ...sample,
    id: 'e2',
    title: '表格在哪',
    keywords: ['配表', 'DataTable'],
    paths: ['Source/Game/Table/Drop'],
  }
  const r = mergeLearned([sample], add, 't2')
  assert.equal(r.added, false)
  assert.equal(r.items.length, 1)
  assert.deepEqual(r.items[0].keywords, ['表格', '配表', 'DataTable'])
  assert.deepEqual(r.items[0].taskIds, ['t1', 't2'])
  const other = { ...sample, id: 'e3', title: '网络', keywords: ['协议'], paths: ['Source/Net'] }
  assert.equal(mergeLearned([sample], other, 't3').added, true)
})

test('合并时关键词满了：这次新学的优先留下，旧的按原顺序排在前面', () => {
  const full = { ...sample, keywords: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'] }
  const add = { ...sample, id: 'e2', keywords: ['A1', 'b1', 'b2'] }
  const r = mergeLearned([full], add, 't2')
  assert.deepEqual(r.items[0].keywords, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'b2'])
})

test('按「同一件事」合并时种类不变，点名更新时才换；并入前的样子交回去', () => {
  const add = { ...sample, id: 'e2', kind: 'flow' as const, title: '表格相关的代码和配置在哪' }
  const r = mergeLearned([sample], add, 't2')
  assert.equal(r.items[0].kind, 'locate')
  assert.deepEqual(r.before, sample)
  assert.equal(r.item.title, '表格相关的代码和配置在哪')
  assert.equal(mergeLearned([sample], add, 't2', 'e1').items[0].kind, 'flow')
})
