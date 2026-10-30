/**
 * 父对话的用量上限：一轮结束时按整棵对话树核一次，80% 提醒一次，用满停下树上在跑的对话。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { Task, type StopReason } from '../../shared/schema.ts'
import { createBudget } from './budget.ts'
import type { TasksScope } from './scope.ts'

setLang('zh')
const at = '2026-10-01T00:00:00.000Z'
const task = (id: string, parentTaskId: string, tokens: number) =>
  Task.parse({
    id,
    projectId: 'p',
    parentTaskId,
    title: id,
    mode: 'chat',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    usage: { inputTokens: tokens, outputTokens: 0 },
  })

function rig(tasks: Task[], budget: { tokens: number; costUsd: number }, live: string[]) {
  const map = new Map(tasks.map((x) => [x.id, structuredClone(x)]))
  const stopped: [string, StopReason][] = []
  const s = {
    live: new Map(live.map((id) => [id, { task: map.get(id)!, rev: 0 }])),
    store: {
      list: async () => [...map.values()],
      get: async (id: string) => map.get(id) ?? null,
      update: async (id: string, tk: Task) => void map.set(id, tk),
    },
    deps: { projects: { get: async () => ({ id: 'p', budget }) } },
    stopTask: (id: string, reason: StopReason) => void stopped.push([id, reason]),
  } as unknown as TasksScope
  return { ...createBudget(s), map, stopped }
}

test('过了 80% 在顶层对话里提醒一次，再核一次不重复说', async () => {
  const r = rig([task('root', '', 500), task('kid', 'root', 350)], { tokens: 1000, costUsd: 0 }, ['kid'])
  assert.equal(await r.checkBudget(r.map.get('kid')!), false)
  assert.equal(await r.checkBudget(r.map.get('kid')!), false)
  const root = r.map.get('root')!
  assert.equal(root.budgetNotice, 'warn')
  assert.equal(root.messages.filter((m) => /用量提醒/.test(m.text)).length, 1)
  assert.deepEqual(r.stopped, [])
})

test('用满：停下树上所有在跑的对话（别的对话不动），在顶层对话里说明原因', async () => {
  const r = rig(
    [task('root', '', 600), task('kid', 'root', 300), task('grand', 'kid', 200), task('other', '', 0)],
    { tokens: 1000, costUsd: 0 },
    ['root', 'grand', 'other'],
  )
  assert.equal(await r.checkBudget(r.map.get('grand')!), true)
  assert.deepEqual(r.stopped.sort(), [
    ['grand', 'budget'],
    ['root', 'budget'],
  ])
  assert.equal(r.map.get('root')!.budgetNotice, 'over')
  assert.match(r.map.get('root')!.messages.at(-1)!.text, /用量上限.*停下了整个对话/)
})
