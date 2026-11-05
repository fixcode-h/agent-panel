/**
 * 结束前判断里「子对话做完了却没请收尾」那一档（ADR 0049 第四期）：以前等一轮结束后由 nudgeMerge 另发提醒，
 * 现在在同一轮里拦住。只看计划和改动清单。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-before-end-'))
const { mergeOwedOf } = await import('./before-end.ts')

const at = '2026-11-04T00:00:00.000Z'
const step = (title: string, status: string, wrapUp?: string) => ({
  id: title,
  title,
  status,
  note: '',
  waits: [],
  children: [],
  ...(wrapUp ? { wrapUp } : {}),
})
const kid = (over: Record<string, unknown> = {}) =>
  ({
    parentTaskId: 'par',
    resolved: false,
    wrapRequest: undefined,
    plans: [],
    steps: [],
    changes: [],
    ...over,
  }) as never

test('计划只剩合回那一步、没列计划但改过文件：该请收尾；其余不拦', () => {
  const plan = (last: string) => [
    {
      id: 'p',
      title: '',
      createdAt: at,
      doneAt: '',
      steps: [step('改代码', 'done'), step('合回父对话所在的分支', last, 'merge')],
    },
  ]
  assert.equal(mergeOwedOf(kid({ plans: plan('pending') }), false), 'plan-wrap-left')
  assert.equal(mergeOwedOf(kid({ changes: [{ path: 'a.ts', add: 1, del: 0 }] }), false), 'changed-no-plan')
  assert.equal(mergeOwedOf(kid({ plans: plan('done') }), false), '', '收尾那步做完了')
  assert.equal(mergeOwedOf(kid({ plans: plan('pending') }), true), '', '提醒过一次就不再拦')
  assert.equal(
    mergeOwedOf(kid({ plans: plan('pending'), wrapRequest: { state: 'requested', at } }), false),
    '',
    '已经请过',
  )
  assert.equal(mergeOwedOf(kid({ parentTaskId: '', changes: [{ path: 'a.ts' }] }), false), '', '顶层对话不管')
  const notYet = [
    {
      id: 'p',
      title: '',
      createdAt: at,
      doneAt: '',
      steps: [step('改代码', 'running'), step('合回', 'pending', 'merge')],
    },
  ]
  assert.equal(mergeOwedOf(kid({ plans: notYet }), false), '', '别的步骤还没做完，归计划那一档管')
})

test('预热的进程也装结束前钩子：还没收到用户消息时放行，收到后照常判断', async () => {
  const { createBeforeEnd } = await import('./before-end.ts')
  const task = { id: 'c1', prewarming: true, messages: [], requests: [], plans: [], steps: [] } as never as {
    prewarming: boolean
  }
  const sc = { live: new Map([['c1', { task }]]), store: { get: async () => task } } as never
  const decide = createBeforeEnd(sc, {
    budget: {} as never,
    inputOf: () => '',
    haltedBy: () => 'user',
    activeChildren: async () => 0,
  })
  assert.deepEqual(await decide('c1', {}), { block: false, why: 'prewarm' })
  // 收到消息后 runner 清掉 prewarming：不再按预热放行（这里被「用户叫停」挡下，说明走到了正常判断）
  task.prewarming = false
  assert.equal((await decide('c1', {})).why, 'halted:user')
})
