/**
 * 夏令时：每天 02:30 的计划遇到跳过 02:00–03:00 的那一天，当天顺延到 03:30，之后要回到 02:30，
 * 不能从此每天都变成 03:30。时区在导入前固定成有夏令时的纽约，结果和本机时区无关。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// 静态 import 会先于这行执行：schedule.ts 动态导入，保证在时区设好之后才加载
process.env.TZ = 'America/New_York'
const { nextRunAt, scheduleClock } = await import('./schedule.ts')

// 2026-03-08 是美国开始夏令时的那天：02:00 直接跳到 03:00
const local = (d: number, h: number, m: number) => new Date(2026, 2, d, h, m).getTime()
const hm = (iso: string) => {
  const d = new Date(iso)
  return `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('每天 02:30：跳过的那天顺延到 03:30，第二天回到 02:30（按记下的时分重设）', () => {
  const start = new Date(local(7, 2, 30)).toISOString()
  const clock = scheduleClock(start)
  assert.equal(clock, '02:30')
  const s = { repeat: 'daily' as const, weekdays: [], at: start, clock }
  const gap = nextRunAt(s, local(7, 2, 31))
  assert.equal(hm(gap), '8 3:30', '跳过的那一小时不存在，当天顺延')
  // 跑完那一次后 at 存的就是 03:30，下一次要回到 02:30
  assert.equal(hm(nextRunAt({ ...s, at: gap }, Date.parse(gap) + 60_000)), '9 2:30')
  // 一次跳很多天（面板很久没开）也一样
  assert.equal(hm(nextRunAt({ ...s, at: gap }, local(20, 12, 0))), '21 2:30')
})

test('每周计划跨过夏令时那天同样回到原来的时分', () => {
  const start = new Date(local(1, 2, 30)).toISOString()
  const s = { repeat: 'weekly' as const, weekdays: [7], at: start, clock: scheduleClock(start) }
  const gap = nextRunAt(s, local(1, 2, 31))
  assert.equal(hm(gap), '8 3:30')
  assert.equal(hm(nextRunAt({ ...s, at: gap }, Date.parse(gap) + 60_000)), '15 2:30')
})
