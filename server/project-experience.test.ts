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
