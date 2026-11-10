/**
 * 自驱的进度指纹（shared/drive.ts）：推进次数按它计，指纹变了就从头数。
 * 运行：npx tsx --test shared/drive.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DriveBudget, planProgressKey, shortKey } from './drive.ts'
import { TaskPlan } from './schema.ts'

const plan = (steps: { id: string; title: string; status: string; note?: string }[]) =>
  TaskPlan.parse({ id: 'p1', createdAt: '2026-11-02T00:00:00.000Z', steps })

test('进度指纹：步骤状态变了、加了步骤就算有进展；只改备注、标题不算（免得改一个字刷新推进次数）', () => {
  const a = plan([
    { id: '1', title: '改代码', status: 'done' },
    { id: '2', title: '跑测试', status: 'pending' },
  ])
  const key = planProgressKey(a)
  // 已完成步数没变、但某步从待做变成进行中：原来的「计划 id:已完成几步」认不出，推满 3 次后就再也不推
  assert.notEqual(planProgressKey(plan([a.steps[0], { ...a.steps[1], status: 'running' }])), key)
  assert.notEqual(planProgressKey(plan([...a.steps, { id: '3', title: '提交', status: 'pending' }])), key)
  assert.equal(planProgressKey(plan([a.steps[0], { ...a.steps[1], title: '跑单测', note: '先跑受影响的' }])), key)
  assert.match(shortKey(key), /^[0-9a-f]{8}$/)
  assert.equal(shortKey(key), shortKey(planProgressKey(a)))
})

test('推进账本：只在真推出去时记；同一进度推满就停，进度变了重新数；同一条输入总数有上限，用户发消息清零', () => {
  const b = new DriveBudget(4)
  // 只看不记：刚结束那一下复查没过（后台结果这时交进来）不能把次数用掉
  for (let i = 0; i < 5; i++) assert.equal(b.can('c', 'k1', 3, 'u1'), 'ok')
  assert.deepEqual([b.take('c', 'k1', 3, 'u1'), b.take('c', 'k1', 3, 'u1'), b.take('c', 'k1', 3, 'u1')], [1, 2, 3])
  assert.equal(b.can('c', 'k1', 3, 'u1'), 'exhausted')
  assert.equal(b.take('c', 'k1', 3, 'u1'), 0)
  // 进度变了从 1 数；但这条输入之后一共只能推 4 次（来回改步骤状态刷新指纹也推不下去）
  assert.equal(b.take('c', 'k2', 3, 'u1'), 1)
  assert.equal(b.can('c', 'k3', 3, 'u1'), 'total-cap')
  // 新的一条输入（父对话来信、用户消息）重新数总数；用户亲自发消息整个清零
  assert.equal(b.can('c', 'k3', 3, 'u2'), 'ok')
  b.reset('c')
  assert.equal(b.can('c', 'k1', 3, 'u1'), 'ok')
  assert.equal(b.state('c'), undefined)
})

test('推进次数存进对话（A10）：面板重启后（新的账本）接着存着的次数数，用户发消息清零也写回', () => {
  const saved = new Map<string, import('./task-runtime-schema.ts').DriveCount | undefined>()
  const store = { load: (id: string) => saved.get(id), save: (id: string, c: never) => saved.set(id, c) }
  const before = new DriveBudget(2, store)
  assert.equal(before.take('c', 'k1', 2, 'u1'), 1)
  assert.deepEqual(saved.get('c'), { key: 'k1', n: 1, input: 'u1', total: 1 })
  // 重启：新账本从对话上存着的接着数，同一进度第 2 次推完就满了
  const after = new DriveBudget(2, store)
  assert.deepEqual(after.state('c'), { key: 'k1', n: 1 })
  assert.equal(after.take('c', 'k1', 2, 'u1'), 2)
  assert.deepEqual(after.state('c'), { key: 'k1', n: 2 })
  assert.equal(after.can('c', 'k2', 2, 'u1'), 'total-cap', '同一条输入之后的总次数也接着数')
  after.reset('c')
  assert.equal(saved.get('c'), undefined)
  assert.equal(new DriveBudget(2, store).can('c', 'k1', 2, 'u1'), 'ok')
})
