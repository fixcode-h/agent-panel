/**
 * 派单：哪几次调用是派单、分诊对到哪一次、对象办没办完（设计稿：回复折叠与派单行重设计 §4、§5）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskMessage, TaskRoute, TaskStep, ToolUse } from '@shared/schema'
import type { ChildEntry } from '@shared/task'
import {
  dispatchState,
  dispatchesOf,
  latestChildDispatch,
  routeDispatches,
  type DispatchWorld,
} from './fold-dispatch.ts'

const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 0, 0, s)).toISOString()
const ptool = (name: string, input: Record<string, unknown>, output = ''): ToolUse => ({
  kind: 'other',
  name: `mcp__panel-1__${name}`,
  label: `panel · ${name}`,
  detail: '',
  input: JSON.stringify(input),
  output,
})
const msg = (id: string, s: number, extra: Partial<TaskMessage> = {}): TaskMessage => ({
  id,
  role: 'agent',
  agentId: 'a1',
  step: '',
  text: '',
  tools: [],
  at: at(s),
  ...extra,
})
const route = (id: string, target: TaskRoute['target'], refs: string[], s: number, messageId = 'u1'): TaskRoute => ({
  id,
  target,
  refs,
  label: '',
  understanding: '理解',
  reason: '',
  assumptions: '',
  messageId,
  at: at(s),
})

const msgs: TaskMessage[] = [
  msg('u1', 0, { role: 'user', text: '查一下' }),
  msg('m1', 1, { tools: [ptool('create_conversation', { title: '核实' }, '已新建子对话「核实」（id: c1）')] }),
  msg('m2', 3, { role: 'system', spawned: ['h1', 'h2'] }),
  msg('m3', 5, { tools: [ptool('send_to_conversation', { id: 'c1', message: '再核实一下' }, '已交给「核实」')] }),
]

test('dispatchesOf：新开、交回子对话和派出子任务都认成派单，带着对象', () => {
  const ds = dispatchesOf(msgs)
  assert.deepEqual(
    ds.map((d) => [d.key, d.kind, d.targets]),
    [
      ['m1#0', 'child-new', ['c1']],
      ['m2#-1', 'subtask', ['h1', 'h2']],
      ['m3#0', 'child-resend', ['c1']],
    ],
  )
})

test('routeDispatches：分诊按对象对到具体那一次派单，对不上的才挂在消息上', () => {
  const ds = dispatchesOf(msgs)
  const { byKey, orphan } = routeDispatches(
    msgs,
    [route('r1', 'child', ['c1'], 2), route('r2', 'subtask', ['h1', 'h2'], 4), route('r3', 'resend', ['c1'], 6)],
    ds,
  )
  assert.deepEqual(
    byKey.get('m1#0')?.map((r) => r.id),
    ['r1'],
  )
  assert.deepEqual(
    byKey.get('m2#-1')?.map((r) => r.id),
    ['r2'],
  )
  // 交回同一个子对话：取分诊时刻之前最后那一次
  assert.deepEqual(
    byKey.get('m3#0')?.map((r) => r.id),
    ['r3'],
  )
  assert.equal(orphan.size, 0)
})

test('dispatchState：子对话只有最近那次派单跟着它的状态走，做完才算办完', () => {
  const ds = dispatchesOf(msgs)
  const child = (state: Partial<ChildEntry>): ChildEntry =>
    ({ id: 'c1', status: 'running', working: true, ...state }) as ChildEntry
  const world = (kids: ChildEntry[], steps: Partial<TaskStep>[] = []): DispatchWorld => ({
    task: { messages: msgs, steps: steps as TaskStep[], jobs: [] },
    children: kids,
    latestChild: latestChildDispatch(ds),
    rerouted: new Set(),
  })
  const [create, spawn, resend] = ds
  // 新开的那次已经被后来的交回接替：算办完
  assert.equal(dispatchState(create, [], world([child({})])).open, false)
  assert.deepEqual(dispatchState(resend, [], world([child({})])), { status: 'running', open: true })
  assert.equal(dispatchState(resend, [], world([child({ status: 'done', working: false })])).open, false)
  // 不在列表里（归档、删除了）算处理完
  assert.equal(dispatchState(resend, [], world([])).open, false)
  // 子任务：一个在跑就是在跑，全部做完才收进折叠
  const steps = (a: string, b: string) =>
    [
      { id: 'h1', status: a },
      { id: 'h2', status: b },
    ] as Partial<TaskStep>[]
  assert.deepEqual(dispatchState(spawn, [], world([], steps('done', 'running'))), { status: 'running', open: true })
  assert.deepEqual(dispatchState(spawn, [], world([], steps('done', 'failed'))), { status: 'failed', open: true })
  assert.equal(dispatchState(spawn, [], world([], steps('done', 'done'))).open, false)
  // 改派过的不再留在外面
  const w = world([child({})])
  w.rerouted.add('r9')
  assert.deepEqual(dispatchState(resend, [route('r9', 'resend', ['c1'], 6)], w), { status: 'rerouted', open: false })
})
