/**
 * 回收站判定：删除只做标记（Task.deletedAt），进回收站的对话从列表、计数、执行统计里排掉，
 * 靠的仍是「已收起」的唯一判定 taskGone；保留期按 7 天算，剩余天数给设置页显示。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TRASH_RETENTION_DAYS, taskDeleted, taskGone, trashLeftDays } from './task.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString()

test('没有任何标记的对话不算收起、也不在回收站', () => {
  assert.equal(taskDeleted({}), false)
  assert.equal(taskGone({}), false)
  assert.equal(taskGone({ archived: false, worktree: { state: 'active' } }), false)
})

test('归档、独立分支被删掉照旧算收起', () => {
  assert.equal(taskGone({ archived: true }), true)
  assert.equal(taskGone({ worktree: { state: 'discarded' } }), true)
  assert.equal(taskGone({ worktree: { state: 'merged' } }), false)
})

test('进回收站就算收起：列表、计数、执行统计都读 taskGone', () => {
  const deletedAt = daysAgo(1)
  assert.equal(taskDeleted({ deletedAt }), true)
  assert.equal(taskGone({ deletedAt }), true)
})

test('保留期 7 天：剩余天数向上取整，到期为 0', () => {
  assert.equal(TRASH_RETENTION_DAYS, 7)
  assert.equal(trashLeftDays(daysAgo(0), NOW), 7, '刚删的还有 7 天')
  assert.equal(trashLeftDays(daysAgo(6.5), NOW), 1, '不满一天按一天算')
  assert.equal(trashLeftDays(daysAgo(7), NOW), 0, '满 7 天就该清理')
  assert.equal(trashLeftDays(daysAgo(30), NOW), 0, '早就过期的也是 0，不会出负数')
})

test('删除时间读不懂时按已到期算，不会永远留在回收站', () => {
  assert.equal(trashLeftDays('', NOW), 0)
  assert.equal(trashLeftDays('not-a-date', NOW), 0)
})
