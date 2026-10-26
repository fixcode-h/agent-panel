/** 时间拼串的口径：补零和本地时区只在这一处实现，跨时区（CI 跑在 TZ=UTC）也要跟本机 getter 一致 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { hhmm, pad2, ymd } from './datetime.ts'

test('pad2：一位数补成两位，两位数原样', () => {
  assert.equal(pad2(0), '00')
  assert.equal(pad2(7), '07')
  assert.equal(pad2(9), '09')
  assert.equal(pad2(10), '10')
  assert.equal(pad2(59), '59')
})

test('ymd / hhmm：按本机时区的年月日和时分，月、日、时、分都补零', () => {
  assert.equal(ymd(new Date(2026, 0, 5)), '2026-01-05')
  assert.equal(ymd(new Date(2026, 11, 31, 23, 59)), '2026-12-31')
  assert.equal(hhmm(new Date(2026, 0, 5, 9, 7)), '09:07')
  assert.equal(hhmm(new Date(2026, 0, 5, 0, 0)), '00:00')
  assert.equal(hhmm(new Date(2026, 0, 5, 23, 59)), '23:59')
})

test('ymd / hhmm：跨时区时不会被换成 UTC 的日期和时间', () => {
  // 同一个时刻在 UTC 还是 1 月 5 日 23:00，东八区已经是 1 月 6 日 07:00；
  // 断言跟本机时区的 getter 一致，所以本机在哪个时区都能过
  const d = new Date('2026-01-05T23:00:00Z')
  assert.equal(ymd(d), `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)
  assert.equal(hhmm(d), `${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
})
