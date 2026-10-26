import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterFail,
  alignScheduleAt,
  afterMiss,
  afterRun,
  fromLocalInput,
  groupLabel,
  groupOf,
  groupSchedules,
  isoWeekday,
  nextDailyAt,
  nextRunAt,
  nextRunLabel,
  outcomeLabel,
  outcomeOf,
  pickDue,
  relativeFuture,
  repeatLabel,
  sameMinute,
  SCHEDULE_MISS_MS,
  toLocalInput,
  whenLabel,
  willRunAgain,
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
  weekdays: [],
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

test('最近一次结果：成功 / 错过 / 启动失败 / 没跑过', () => {
  const base = schedule()
  assert.equal(outcomeOf(base), 'none')
  const ok = { ...base, lastRunAt: at(2026, 5, 1, 10), lastTaskId: 'task-1' }
  assert.equal(outcomeOf(ok), 'success')
  // 每天的计划成功启动后 missedAt 还留着前一次错过：比启动早，不算最近一次结果
  assert.equal(outcomeOf({ ...ok, missedAt: at(2026, 4, 30, 10) }), 'success')
  // 错过的那次比上次启动晚：最近一次是错过
  assert.equal(outcomeOf({ ...ok, missedAt: at(2026, 5, 2, 10) }), 'missed')
  // 先启动失败、之后又错过：错过更晚，最近一次是错过；lastError 仍非空，由卡片单独一段显示
  assert.equal(outcomeOf({ ...ok, missedAt: at(2026, 5, 2, 10), lastError: '项目不存在' }), 'missed')
  // 错过比上次启动早：最近一次不再是错过，旧的 lastError 说明最近一次已知结果是失败
  assert.equal(outcomeOf({ ...ok, missedAt: at(2026, 4, 30, 10), lastError: '项目不存在' }), 'error')
  // 只有错误、没有错过
  assert.equal(outcomeOf({ ...base, lastError: '角色不存在' }), 'error')
})

test('分组：即将执行 / 出过问题 / 已停用 / 不会再执行', () => {
  const pending = schedule()
  assert.equal(groupOf(pending), 'upcoming')
  assert.equal(groupOf({ ...pending, lastError: '角色不存在' }), 'problem')
  assert.equal(groupOf({ ...pending, missedAt: at(2026, 4, 30, 10) }), 'problem')
  // 停用优先：停用的计划即使错过过也归「已停用」，原因仍显示在卡片上
  assert.equal(groupOf({ ...pending, enabled: false, missedAt: at(2026, 4, 30, 10) }), 'disabled')
  // 单次执行完、单次失败都是「不会再执行」
  assert.equal(groupOf({ ...pending, status: 'done' }), 'finished')
  assert.equal(groupOf({ ...pending, status: 'skipped' }), 'finished')
  assert.equal(willRunAgain({ ...pending, status: 'done' }), false)
  assert.equal(willRunAgain(pending), true)
})

test('下次执行时间：「今晚 19:00（3 小时后）」，不会再执行时为空', () => {
  const now = Date.parse(at(2026, 5, 1, 16))
  const daily = schedule({ repeat: 'daily', at: at(2026, 5, 1, 19) })
  assert.equal(nextRunLabel(daily, now), '今晚 19:00（3 小时后）')
  // 停用、单次已执行完都没有下一次
  assert.equal(nextRunLabel({ ...daily, enabled: false }, now), '')
  assert.equal(nextRunLabel({ ...daily, status: 'done' }, now), '')
  // 已经到了但还没被轮询处理：写成已到点，不显示「0 分钟后」
  assert.equal(nextRunLabel(daily, Date.parse(at(2026, 5, 1, 19, 1))), '今晚 19:00（已到点）')
  assert.equal(relativeFuture(at(2026, 5, 1, 16, 12), now), '12 分钟后')
  assert.equal(relativeFuture(at(2026, 5, 3, 16), now), '2 天后')
})

test('绝对时间：今天 / 今晚 / 明天 / 后天 / 更远写日期 / 过去写昨天', () => {
  const now = Date.parse(at(2026, 5, 1, 16))
  assert.equal(whenLabel(at(2026, 5, 1, 14), now), '今天 14:00')
  assert.equal(whenLabel(at(2026, 5, 1, 19), now), '今晚 19:00')
  assert.equal(whenLabel(at(2026, 5, 2, 9), now), '明天 09:00')
  assert.equal(whenLabel(at(2026, 5, 3, 9), now), '后天 09:00')
  assert.equal(whenLabel(at(2026, 5, 4, 9), now), '5月4日 09:00')
  assert.equal(whenLabel(at(2026, 4, 30, 9), now), '昨天 09:00')
})

test('列表分组：组顺序固定、空组不出现，组内按时间排', () => {
  const soon = schedule({ id: 'soon', at: at(2026, 5, 1, 9) })
  const later = schedule({ id: 'later', at: at(2026, 5, 1, 12) })
  // 真实数据里 store.update 每次都会刷新 updatedAt：刚错过的 updatedAt 也最新
  const missed = schedule({ id: 'missed', missedAt: at(2026, 4, 30, 9), updatedAt: at(2026, 4, 30, 9) })
  const oldMissed = schedule({ id: 'old-missed', missedAt: at(2026, 4, 20, 9), updatedAt: at(2026, 4, 20, 9) })
  const off = schedule({ id: 'off', enabled: false, updatedAt: at(2026, 5, 1, 6) })
  // 排期在明年的停用计划：at 再远也不该压到「刚停用」的计划上面（活动时间不看 at）
  const farOff = schedule({ id: 'far-off', enabled: false, at: at(2027, 1, 1, 9), updatedAt: at(2026, 4, 1, 9) })
  const done = schedule({ id: 'done', status: 'done', lastRunAt: at(2026, 4, 29, 9) })
  const buckets = groupSchedules([later, off, farOff, soon, missed, done, oldMissed])
  assert.deepEqual(
    buckets.map((b) => b.group),
    ['upcoming', 'problem', 'disabled', 'finished'],
  )
  // 即将执行：先跑的在上
  assert.deepEqual(
    buckets[0].items.map((s) => s.id),
    ['soon', 'later'],
  )
  // 出过问题：刚错过的在上
  assert.deepEqual(
    buckets[1].items.map((s) => s.id),
    ['missed', 'old-missed'],
  )
  // 已停用：刚停用的在上，排期在明年的那条不会因为 at 大就排到前面
  assert.deepEqual(
    buckets[2].items.map((s) => s.id),
    ['off', 'far-off'],
  )
  // 单条也不丢
  assert.equal(groupSchedules([off])[0].items.length, 1)
  assert.deepEqual(groupSchedules([]), [])
})

test('分组标题和最近一次结果的文案', () => {
  assert.equal(groupLabel('upcoming'), '即将执行')
  assert.equal(groupLabel('problem'), '出过问题')
  assert.equal(groupLabel('disabled'), '已停用')
  assert.equal(groupLabel('finished'), '不会再执行')
  const now = Date.parse(at(2026, 5, 1, 16))
  const s = schedule({ lastRunAt: at(2026, 5, 1, 15) })
  assert.equal(outcomeLabel({ ...s, lastRunAt: '' }, now), '还没有执行过')
  assert.equal(outcomeLabel(s, now), '成功启动于 今天 15:00')
  assert.equal(
    outcomeLabel({ ...s, lastRunAt: '', missedAt: at(2026, 4, 30, 19) }, now),
    '错过 昨天 19:00（面板当时没在跑，不补跑）',
  )
  assert.equal(outcomeLabel({ ...s, lastError: '项目不存在' }, now), '启动失败')
})

test('同一分钟算没改时间：带秒的老数据在弹窗里编辑不会被当成重新排期', () => {
  const base = at(2026, 5, 1, 19, 30)
  assert.equal(sameMinute(base, new Date(Date.parse(base) + 20_000).toISOString()), true)
  assert.equal(sameMinute(base, at(2026, 5, 1, 19, 31)), false)
  assert.equal(sameMinute(base, at(2026, 5, 2, 19, 30)), false)
  assert.equal(sameMinute('不是时间', base), false)
})

test('每周：按选中的星期跨周推，多选时找下一个符合的星期', () => {
  // 2026-05-03 是周日，只选周日：下一次是下周日同一时刻
  const sunday = at(2026, 5, 3, 19)
  assert.equal(
    nextRunAt({ repeat: 'weekly', at: sunday, weekdays: [7] }, Date.parse(sunday) + 1000),
    at(2026, 5, 10, 19),
  )
  // 选周一、三、五：周五 19:00 执行完，下一次是下周一
  const friday = at(2026, 5, 1, 19)
  assert.equal(
    nextRunAt({ repeat: 'weekly', at: friday, weekdays: [1, 3, 5] }, Date.parse(friday) + 1000),
    at(2026, 5, 4, 19),
  )
  // 还没到第一次执行时间：直接返回 at（首次时间由用户指定）
  assert.equal(nextRunAt({ repeat: 'weekly', at: friday, weekdays: [1, 3, 5] }, Date.parse(friday) - 1000), friday)
  // 没选星期：按 at 那天的星期（周三 → 下周三）
  const wednesday = at(2026, 5, 6, 19)
  assert.equal(
    nextRunAt({ repeat: 'weekly', at: wednesday, weekdays: [] }, Date.parse(wednesday) + 1000),
    at(2026, 5, 13, 19),
  )
})

test('工作日：周五晚上跳过周末到下周一，跨月也对，周末不执行', () => {
  const friday = at(2026, 5, 29, 19)
  assert.equal(
    nextRunAt({ repeat: 'workdays', at: friday, weekdays: [] }, Date.parse(friday) + 1000),
    at(2026, 6, 1, 19),
  )
  const monday = at(2026, 5, 4, 19)
  assert.equal(
    nextRunAt({ repeat: 'workdays', at: monday, weekdays: [] }, Date.parse(monday) + 1000),
    at(2026, 5, 5, 19),
  )
  // 用户把时间改到周六：下一次是下周一
  const saturday = at(2026, 5, 2, 9)
  assert.equal(
    nextRunAt({ repeat: 'workdays', at: saturday, weekdays: [] }, Date.parse(saturday) + 1000),
    at(2026, 5, 4, 9),
  )
})

test('本地时间边界：23:59 执行完推到次日 23:59，不偏一小时', () => {
  const late = at(2026, 5, 1, 23, 59)
  const next = nextRunAt({ repeat: 'daily', at: late, weekdays: [] }, Date.parse(late) + 30_000)
  assert.equal(next, at(2026, 5, 2, 23, 59))
  const d = new Date(next)
  assert.equal(d.getDate(), 2)
  assert.equal(d.getHours(), 23)
  assert.equal(d.getMinutes(), 59)
})

test('每周 / 工作日：执行、错过、启动失败后都推到下一次，状态保持待执行', () => {
  const weekly = schedule({ repeat: 'weekly', weekdays: [1], at: at(2026, 5, 4, 19) })
  const now = Date.parse(weekly.at) + 1000
  const ran = { ...weekly, ...afterRun(weekly, now, 'task-1') }
  assert.equal(ran.status, 'pending')
  assert.equal(ran.at, at(2026, 5, 11, 19))
  const missed = { ...weekly, ...afterMiss(weekly, now) }
  assert.equal(missed.status, 'pending')
  assert.equal(missed.missedAt, weekly.at)
  assert.equal(missed.at, at(2026, 5, 11, 19))
  const failed = { ...weekly, ...afterFail(weekly, now, '项目不存在') }
  assert.equal(failed.status, 'pending')
  assert.equal(failed.at, at(2026, 5, 11, 19))

  // 工作日：周五启动失败 → 下周一，不会每轮询一次就重试
  const work = schedule({ repeat: 'workdays', at: at(2026, 5, 1, 19) })
  const wnow = Date.parse(work.at) + 1000
  assert.equal({ ...work, ...afterRun(work, wnow, 't') }.at, at(2026, 5, 4, 19))
  assert.equal({ ...work, ...afterMiss(work, wnow) }.at, at(2026, 5, 4, 19))
})

test('重复规则的徽标和 ISO 星期', () => {
  assert.equal(repeatLabel('once'), '单次')
  assert.equal(repeatLabel('daily'), '每天')
  assert.equal(repeatLabel('weekly'), '每周')
  assert.equal(repeatLabel('workdays'), '工作日')
  assert.equal(isoWeekday(new Date(2026, 4, 4)), 1)
  assert.equal(isoWeekday(new Date(2026, 4, 3)), 7)
})

test('每周 / 工作日：at 是很多年以前时也快进到未来最近的一次，不返回过去', () => {
  // 2026-10-20 是周二；2023-05-01 是周一。三年前的 weekly 现在才打开面板
  const now = Date.parse(at(2026, 10, 20, 10))
  const weekly = nextRunAt({ repeat: 'weekly', at: at(2023, 5, 1, 19), weekdays: [1] }, now)
  assert.equal(weekly, at(2026, 10, 26, 19))
  assert.ok(Date.parse(weekly) > now)
  const work = nextRunAt({ repeat: 'workdays', at: at(2023, 5, 1, 19), weekdays: [] }, now)
  assert.equal(work, at(2026, 10, 20, 19), '今天周二 19:00 还没到')
  assert.ok(Date.parse(work) > now)
})

test('对齐执行时间：weekly / workdays 的首次执行也落在规则允许的星期', () => {
  // 2026-05-02 是周六：工作日的计划对齐到下周一同一时刻
  assert.equal(alignScheduleAt({ repeat: 'workdays', at: at(2026, 5, 2, 9), weekdays: [] }), at(2026, 5, 4, 9))
  // 只选周一、时间填周三：对齐到下周一
  assert.equal(alignScheduleAt({ repeat: 'weekly', at: at(2026, 5, 6, 9), weekdays: [1] }), at(2026, 5, 11, 9))
  // 已经符合规则：原样返回（同一时刻）
  const monday = at(2026, 5, 4, 9)
  assert.equal(alignScheduleAt({ repeat: 'weekly', at: monday, weekdays: [1] }), monday)
  // 单次和每天哪天都行，不动
  assert.equal(alignScheduleAt({ repeat: 'daily', at: at(2026, 5, 2, 9), weekdays: [] }), at(2026, 5, 2, 9))
})

test('每周 / 工作日：首次执行时间没到也只返回符合星期的日子', () => {
  const now = Date.parse(at(2026, 5, 1, 10)) // 周五
  // 未来的周六（工作日的计划不允许）：下一次是下周一同一时刻，而不是周六
  assert.equal(nextRunAt({ repeat: 'workdays', at: at(2026, 5, 2, 9), weekdays: [] }, now), at(2026, 5, 4, 9))
  // 未来且符合规则：原样返回
  const monday = at(2026, 5, 4, 9)
  assert.equal(nextRunAt({ repeat: 'weekly', at: monday, weekdays: [1] }, now), monday)
  // 未来的周三、只选周一：下周一
  assert.equal(nextRunAt({ repeat: 'weekly', at: at(2026, 5, 6, 9), weekdays: [1] }, now), at(2026, 5, 11, 9))
})
