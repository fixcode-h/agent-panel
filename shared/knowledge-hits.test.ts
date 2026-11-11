/**
 * 经验、教训的命中记录：记一次、排序、清掉已删的条目，以及查询时哪些算命中。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectExperience, findExperience } from './experience.ts'
import { addHits, hitLabel, pruneHits, sortByIdle, HIT_TASKS_MAX } from './knowledge-hits.ts'
import { findLessons } from './lessons.ts'
import { GlobalLesson, type ProjectLesson } from './schema.ts'

test('记命中：次数累加、同一批重复只算一次、对话去重且新的在前', () => {
  let h = addHits({}, ['a', 'a', 'b'], 't1', '2026-11-01T00:00:00Z')
  assert.equal(h.a.count, 1)
  h = addHits(h, ['a'], 't2', '2026-11-02T00:00:00Z')
  h = addHits(h, ['a'], 't1', '2026-11-03T00:00:00Z')
  assert.deepEqual(h.a, { count: 3, lastAt: '2026-11-03T00:00:00Z', taskIds: ['t1', 't2'] })
  for (let i = 0; i < 10; i++) h = addHits(h, ['b'], `x${i}`, '2026-11-04T00:00:00Z')
  assert.equal(h.b.taskIds.length, HIT_TASKS_MAX)
  assert.equal(h.b.taskIds[0], 'x9')
})

test('很久没用上的在前：没命中过按建好的时间算，刚记下的不排最前', () => {
  const hits = {
    used: { count: 5, lastAt: '2026-11-10T00:00:00Z', taskIds: [] },
    old: { count: 1, lastAt: '2026-09-01T00:00:00Z', taskIds: [] },
  }
  const list = [
    { id: 'used', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'fresh', createdAt: '2026-11-09T00:00:00Z' },
    { id: 'never', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'old', createdAt: '2026-01-01T00:00:00Z' },
  ]
  assert.deepEqual(
    sortByIdle(list, hits).map((x) => x.id),
    ['never', 'old', 'fresh', 'used'],
  )
})

test('删掉的条目不再占记录；没用过时显示「还没用上」', () => {
  const h = addHits({}, ['a', 'b'], 't', '2026-11-01T00:00:00Z')
  assert.deepEqual(Object.keys(pruneHits(h, ['b'])), ['b'])
  assert.equal(hitLabel(undefined), '还没用上')
  assert.match(hitLabel(h.a, Date.parse('2026-11-03T00:00:00Z')), /用上 1 次 · 2 天前/)
})

test('查经验：交出全文的算命中，只列标题、什么都没查到的不算', () => {
  const exp = (o: Partial<ProjectExperience>) =>
    ProjectExperience.parse({ id: 'e1', kind: 'locate', title: '表格', keywords: ['表格'], createdAt: '', ...o })
  const list = [
    exp({ id: 'a', title: '表格在哪', keywords: ['配表'] }),
    exp({ id: 'b', title: '网络', keywords: ['网络'] }),
  ]
  const got: string[][] = []
  findExperience(list, '配表', [], (ids) => got.push(ids))
  findExperience(list, '', [], (ids) => got.push(ids))
  findExperience(list, '没有的词', [], (ids) => got.push(ids))
  assert.deepEqual(got, [['a']])
})

test('查教训：交出全文的项目教训算命中，全局教训不算', () => {
  const lesson = (id: string, paths: string[]): ProjectLesson => ({
    id,
    title: `规则 ${id}`,
    rule: '照做',
    cause: '',
    paths,
    tags: [],
    enabled: true,
    source: 'user',
    taskId: '',
    createdAt: '',
    updatedAt: '',
    history: [],
  })
  const got: string[][] = []
  const globals = [GlobalLesson.parse({ id: 'g1', title: '全局', rule: '照做' })]
  findLessons([lesson('a', ['src/**']), lesson('b', ['docs/**'])], ['src/x.ts'], globals, {}, (ids) => got.push(ids))
  findLessons([lesson('a', ['src/**'])], [], [], {}, (ids) => got.push(ids))
  assert.deepEqual(got, [['a']])
})
