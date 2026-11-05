/**
 * 计划没跟上提醒（内置钩子 plan-pace）：动手到次数才提醒、同一项只提醒一次、更新过计划重新数。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPlan } from './plan.ts'
import { newPace, planPaceHint } from './plan-pace.ts'
import type { Task } from './schema.ts'

const fresh = () => ({ plans: [], steps: [] }) as unknown as Pick<Task, 'plans' | 'steps'>
const at = '2026-11-04T00:00:00.000Z'
const now = Date.parse(at) + 30_000

/** 连着动手 n 次，返回每次的提醒（空串表示没提醒） */
const work = (task: Pick<Task, 'plans' | 'steps'>, st: ReturnType<typeof newPace>, n: number, kind = 'edit') =>
  Array.from({ length: n }, () => planPaceHint(task, kind, st, 5, 1, now))

test('进行中的一步动手到次数提醒一次，之后不再提醒', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面', status: 'running' }, { title: '跑测试' }] }, at)
  const st = newPace()
  const hints = work(task, st, 8)
  assert.deepEqual(
    hints.map((h) => !!h),
    [false, false, false, false, true, false, false, false],
  )
  assert.match(hints[4], /「改界面」/)
})

test('读文件、面板工具不算动手；没有计划不提醒', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面', status: 'running' }] }, at)
  const st = newPace()
  assert.ok(work(task, st, 10, 'read').every((h) => !h))
  assert.ok(work(task, st, 10, 'panel').every((h) => !h))
  assert.ok(work(fresh(), newPace(), 10).every((h) => !h))
})

test('更新过计划（换了一步）重新数，新的一步还能提醒一次', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面', status: 'running' }, { title: '跑测试' }] }, at)
  const st = newPace()
  work(task, st, 3)
  applyPlan(
    task,
    {
      partial: true,
      steps: [
        { id: '1', status: 'done' },
        { id: '2', status: 'running' },
      ],
    },
    at,
  )
  const hints = work(task, st, 5)
  assert.ok(
    hints.slice(0, 4).every((h) => !h),
    '换了一步从头数',
  )
  assert.match(hints[4], /「跑测试」/)
})

test('有没开始的步骤却没有进行中的：动手 3 次提醒先标进行中；都在等结果时不催', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面' }, { title: '跑测试' }] }, at)
  const hints = work(task, newPace(), 4)
  assert.deepEqual(
    hints.map((h) => !!h),
    [false, false, true, false],
  )
  assert.match(hints[2], /没有进行中的步骤/)
  const done = fresh()
  applyPlan(
    done,
    {
      steps: [
        { title: '改界面', status: 'done' },
        { title: '跑测试', status: 'running' },
      ],
    },
    at,
  )
  applyPlan(
    done,
    {
      partial: true,
      steps: [
        { id: '2', status: 'skipped' },
        { title: '收尾', status: 'done' },
      ],
    },
    at,
  )
  assert.ok(
    work(done, newPace(), 6).every((h) => !h),
    '计划做完了不催',
  )
})

test('超过滞后阈值时，动手到次数的三分之一就提醒', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面', status: 'running' }] }, at)
  const st = newPace()
  const late = Date.parse(at) + 10 * 60_000
  const hints = Array.from({ length: 4 }, () => planPaceHint(task, 'shell', st, 9, 1, late))
  assert.deepEqual(
    hints.map((h) => !!h),
    [false, false, true, false],
  )
  assert.match(hints[2], /超过 3 分钟/)
})

test('同一步最多提醒几次可以设：提醒过后再动手到次数才提醒下一次', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面', status: 'running' }] }, at)
  const st = newPace()
  const hints = Array.from({ length: 10 }, () => planPaceHint(task, 'edit', st, 3, 2, now))
  assert.deepEqual(
    hints.map((h) => !!h),
    [false, false, true, false, false, true, false, false, false, false],
  )
})
