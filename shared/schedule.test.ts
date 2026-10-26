import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterFail,
  afterMiss,
  afterRun,
  fromLocalInput,
  nextDailyAt,
  pickDue,
  sameMinute,
  SCHEDULE_MISS_MS,
  toLocalInput,
  workdayTemplate,
  type Schedule,
} from './schedule.ts'

/** 本机时区的某个时刻，测试里不直接写 ISO，避免跟着机器时区变 */
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).toISOString()

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  name: '今日工作',
  prompt: '总结今天的工作',
  projectId: '',
  agentId: '',
  repeat: 'once',
  at: at(2026, 5, 1, 10),
  enabled: true,
  status: 'pending',
  lastRunAt: '',
  lastTaskId: '',
  missedAt: '',
  lastError: '',
  createdAt: at(2026, 5, 1, 9),
  updatedAt: at(2026, 5, 1, 9),
  ...over,
})

test('到点触发一次，执行完不再重复触发', () => {
  const s = schedule()
  const now = Date.parse(s.at) + 1000
  const due = pickDue([s], now)
  assert.deepEqual(
    due.run.map((x) => x.id),
    ['s1'],
  )
  assert.equal(due.missed.length, 0)

  const done = { ...s, ...afterRun(s, now, 'task-1') }
  assert.equal(done.status, 'done')
  assert.equal(done.lastTaskId, 'task-1')
  assert.equal(done.lastRunAt, new Date(now).toISOString())
  assert.equal(pickDue([done], now + 60_000).run.length, 0)
})

test('没到点、已停用、已执行过的都不触发', () => {
  const s = schedule()
  assert.equal(pickDue([s], Date.parse(s.at) - 1000).run.length, 0)
  assert.equal(pickDue([{ ...s, enabled: false }], Date.parse(s.at) + 1000).run.length, 0)
  assert.equal(pickDue([{ ...s, status: 'done' }], Date.parse(s.at) + 1000).run.length, 0)
})

test('每天：执行后时间推到明天同一时刻，当天不再触发', () => {
  const s = schedule({ repeat: 'daily' })
  const now = Date.parse(s.at) + 1000
  const next = { ...s, ...afterRun(s, now, 'task-1') }
  assert.equal(next.status, 'pending')
  assert.equal(next.at, at(2026, 5, 2, 10))
  assert.equal(pickDue([next], now + 3_600_000).run.length, 0)
  // 到第二天的同一时刻再触发
  assert.equal(pickDue([next], Date.parse(next.at) + 1000).run.length, 1)
})

test('错过的计划不补跑：超过宽限时间的只记成错过', () => {
  const s = schedule()
  const late = Date.parse(s.at) + SCHEDULE_MISS_MS + 1
  const due = pickDue([s], late)
  assert.equal(due.run.length, 0)
  assert.deepEqual(
    due.missed.map((x) => x.id),
    ['s1'],
  )
  // 宽限时间以内（轮询间隔内正常到点）照常执行
  assert.equal(pickDue([s], Date.parse(s.at) + SCHEDULE_MISS_MS - 1000).run.length, 1)
})

test('错过之后：单次标成已跳过并记下错过的那一次，每天推到下一次', () => {
  const once = schedule()
  const now = Date.parse(once.at) + 5 * 60_000
  const skipped = { ...once, ...afterMiss(once, now) }
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.missedAt, once.at)
  assert.equal(pickDue([skipped], now + 60_000).run.length, 0)

  const daily = schedule({ repeat: 'daily' })
  const moved = { ...daily, ...afterMiss(daily, now) }
  assert.equal(moved.status, 'pending')
  assert.equal(moved.missedAt, daily.at)
  assert.equal(moved.at, at(2026, 5, 2, 10))
})

test('面板关了很久才打开：每天的计划推到未来最近的一次，不会连着补跑几次', () => {
  const s = schedule({ repeat: 'daily' })
  // 最后一次执行是三天前，中间的三次都错过了；现在过了今天的 10:00，下一次是明天
  const now = Date.parse(s.at) + 3 * 24 * 3_600_000 + 60_000
  const moved = { ...s, ...afterMiss(s, now) }
  assert.ok(Date.parse(moved.at) > now)
  assert.equal(moved.at, at(2026, 5, 5, 10))
  assert.equal(pickDue([moved], now).run.length, 0)
})

test('下次执行时间：还没到就原样返回，到了之后按本地日历往后推', () => {
  const now = Date.parse(at(2026, 5, 1, 10))
  assert.equal(nextDailyAt(at(2026, 5, 1, 19), now), at(2026, 5, 1, 19))
  assert.equal(nextDailyAt(at(2026, 5, 1, 9), now), at(2026, 5, 2, 9))
  // 时间已经被推着走了很久：一次就跳到未来最近的一次
  assert.equal(nextDailyAt(at(2025, 1, 1, 9), now), at(2026, 5, 2, 9))
})

test('启动失败：记下原因，时间往后推，不每轮询一次就重试', () => {
  const once = schedule()
  const now = Date.parse(once.at) + 1000
  const failed = { ...once, ...afterFail(once, now, '项目不存在') }
  assert.equal(failed.status, 'skipped')
  assert.equal(failed.lastError, '项目不存在')
  assert.equal(pickDue([failed], now + 60_000).run.length, 0)

  const daily = schedule({ repeat: 'daily' })
  const retry = { ...daily, ...afterFail(daily, now, '角色不存在') }
  assert.equal(retry.status, 'pending')
  assert.equal(retry.at, at(2026, 5, 2, 10))
  assert.equal(retry.lastError, '角色不存在')
})

test('「今日工作」模板：每天 19:00，过了今天的 19:00 就是明天', () => {
  const before = workdayTemplate(Date.parse(at(2026, 5, 1, 8)))
  assert.equal(before.name, '今日工作')
  assert.equal(before.repeat, 'daily')
  assert.equal(before.at, at(2026, 5, 1, 19))
  assert.ok(before.prompt.trim().length > 0)

  const after = workdayTemplate(Date.parse(at(2026, 5, 1, 20)))
  assert.equal(after.at, at(2026, 5, 2, 19))
})

test('时间和 datetime-local 输入框的值互转（本机时区）', () => {
  const iso = at(2026, 5, 1, 19, 30)
  assert.equal(toLocalInput(iso), '2026-05-01T19:30')
  assert.equal(fromLocalInput('2026-05-01T19:30'), iso)
  assert.equal(fromLocalInput(''), '')
  assert.equal(fromLocalInput('不是时间'), '')
})

test('同一分钟算没改时间：带秒的老数据在弹窗里编辑不会被当成重新排期', () => {
  const base = at(2026, 5, 1, 19, 30)
  assert.equal(sameMinute(base, new Date(Date.parse(base) + 20_000).toISOString()), true)
  assert.equal(sameMinute(base, at(2026, 5, 1, 19, 31)), false)
  assert.equal(sameMinute(base, at(2026, 5, 2, 19, 30)), false)
  assert.equal(sameMinute('不是时间', base), false)
})
