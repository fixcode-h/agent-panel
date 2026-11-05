/**
 * 状态面板日志的行：每行带它在完整日志里的下标。筛选状态下双击某行要回到完整日志并定位到同一条，
 * 合并后的一对、筛选留下的单行都得能按下标在完整列表里找回来。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLogLine } from '@shared/lifecycle'
import { buildRows, localStamp, type Row } from './life-log-rows'

const raw = [
  '2026-11-05 22:20:00.000 [模型请求开始] n=1',
  '2026-11-05 22:20:01.000 [模型开始输出] n=1 waitedMs=1000',
  '2026-11-05 22:24:12.628 [结束前钩子：拦住] why=check-worked',
]
const lines = raw.map((r) => ({ raw: r, l: parseLogLine(r) }))
const ats = (rows: Row[]) => rows.flatMap((r) => (r.kind === 'day' ? [] : [r.at]))

test('日志行带原始下标：合并的一对记两条，筛选后仍能在完整日志里找回', () => {
  assert.deepEqual(ats(buildRows(lines, '', true)), [[0, 1], [2]])
  assert.deepEqual(ats(buildRows(lines, '', false)), [[0], [1], [2]])
  assert.deepEqual(ats(buildRows(lines, 'nudges', true)), [[2]])
})

test('面板提醒按时间插进日志：对得上「面板提醒」行的顶替那行，end_turn 单独插一行', () => {
  const at = (s: string) => new Date(Date.parse(s)).toISOString()
  const trail = [
    { at: at('2026-11-05T22:24:13.000'), kind: 'hook' as const, tools: 3 },
    { at: at('2026-11-05T22:21:00.000'), kind: 'end' as const, outcome: 'done' as const },
  ].sort((a, b) => (a.at < b.at ? -1 : 1))
  const rows = buildRows(lines, '', true, trail).filter((r) => r.kind !== 'day')
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['pair', 'trail', 'trail'],
  )
  assert.deepEqual(ats(rows), [[0, 1], [-1], [2]])
  // 顶替的那行沿用日志的时间和原文；筛「面板提醒」两条都留下
  const hook = rows[2]
  assert.ok(hook.kind === 'trail' && hook.raw === raw[2] && localStamp(hook.ms) === raw[2].slice(0, 23))
  assert.deepEqual(ats(buildRows(lines, 'nudges', true, trail)), [[-1], [2]])
  assert.deepEqual(ats(buildRows(lines, 'retries', true, trail)), [])
})
