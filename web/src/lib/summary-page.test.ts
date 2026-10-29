/**
 * 工作总结页的状态存档：切页面 / 刷新后要能恢复来源、粒度、日期、进行中的提炼和已采纳的分项。
 * 这里测的是纯逻辑——存进去的脏数据怎么读回来、隔天怎么处理、项目被删了怎么剪掉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_SUMMARY_PAGE,
  loadSummaryPage,
  parseSummaryPage,
  pruneProjects,
  saveSummaryPage,
  SUMMARY_PAGE_KEY,
  type SummaryPageState,
} from './summary-page.ts'

const now = new Date(2026, 9, 23, 18)
const sample = (): SummaryPageState => ({
  source: 'reports',
  grain: 'week',
  day: '2026-10-20',
  savedOn: '2026-10-23',
  jobId: 'j1',
  adopted: ['a', 'b'],
  mode: 'edit',
})

test('存档键换成 v2：改版前的存档字段对不上，不读它', () => {
  assert.equal(SUMMARY_PAGE_KEY, 'summary-page:v2')
})

test('当天读回来原样恢复', () => {
  assert.deepEqual(parseSummaryPage(JSON.stringify(sample()), now), sample())
})

test('隔天打开：日期回到今天，上次的提炼不再接着看，来源和粒度保留', () => {
  const next = parseSummaryPage(JSON.stringify(sample()), new Date(2026, 9, 24, 9))
  assert.equal(next.day, '')
  assert.equal(next.jobId, '')
  assert.equal(next.source, 'reports')
  assert.equal(next.grain, 'week')
})

test('坏数据按默认值处理，页面照常打开', () => {
  assert.deepEqual(parseSummaryPage(null, now), DEFAULT_SUMMARY_PAGE)
  assert.deepEqual(parseSummaryPage('{坏的', now), DEFAULT_SUMMARY_PAGE)
  const odd = parseSummaryPage(
    JSON.stringify({
      source: 'x',
      grain: 'month',
      day: '昨天',
      savedOn: '2026-10-23',
      adopted: ['a', 'a', 3, ''],
      mode: 'x',
    }),
    now,
  )
  assert.equal(odd.source, 'tasks')
  assert.equal(odd.grain, 'day')
  assert.equal(odd.day, '')
  assert.deepEqual(odd.adopted, ['a'])
  assert.equal(odd.mode, 'preview')
})

test('写不进 localStorage 时退回内存：同一次打开里还能读回来', () => {
  saveSummaryPage(sample())
  const back = loadSummaryPage()
  assert.equal(back.source, 'reports')
  assert.deepEqual(back.adopted, ['a', 'b'])
})

test('pruneProjects：别处删掉的项目剪掉，顺序不变，返回剪掉几个', () => {
  assert.deepEqual(pruneProjects(['p2', 'gone', 'p1'], [{ id: 'p1' }, { id: 'p2' }]), { ids: ['p2', 'p1'], removed: 1 })
  assert.deepEqual(pruneProjects([], [{ id: 'p1' }]), { ids: [], removed: 0 })
})
