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
const { mergeOwedOf } = await import('../../shared/end-turn.ts')

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
  // 父对话已经合回：wrapRequest 清掉、收尾标完成、计划收起，改动清单还在——不能再按「没列计划但改过文件」要它重交
  const merged = [{ ...plan('done')[0], doneAt: at }]
  assert.equal(
    mergeOwedOf(kid({ plans: merged, changes: [{ path: 'a.ts', add: 1, del: 0 }] }), false),
    '',
    '已经合回过',
  )
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

test('没列计划：收尾自检问过以后又调工具接着做、没交代结束就要停，再问一次；问过只回了话的放行', async () => {
  // 用户 2026-11-05 报：问过「做完了吗」后它又读了两个文件，说「我派子对话核实并修」就停了，子对话没开出来
  const { createBeforeEnd } = await import('./before-end.ts')
  const msg = (role: string, tools: { kind: string }[] = [], panel = '') => ({
    id: `m${Math.random()}`,
    role,
    panel,
    tools,
    text: '',
    at,
  })
  const read = { kind: 'read' }
  const task = {
    id: 'c2',
    projectId: '',
    parentTaskId: '',
    mode: 'task',
    messages: [
      msg('user'),
      msg('agent', [read, read, read, read, read, read, read, read, read]),
      msg('system', [], 'hook'),
    ],
    requests: [],
    plans: [],
    steps: [],
    changes: [],
    turnEnds: [],
  }
  const sc = {
    live: new Map([['c2', { task }]]),
    store: { get: async () => task, list: async () => [] },
    startQueue: new Set(),
    background: { list: () => [] },
  } as never
  const decide = createBeforeEnd(sc, {
    budget: { take: () => 1 } as never,
    inputOf: () => 'in',
    haltedBy: () => '',
    activeChildren: async () => 0,
  })
  // 问过以后只回了话：不再问
  task.messages.push(msg('agent'))
  assert.deepEqual(await decide('c2', {}), { block: false, why: 'answered' })
  // 问过以后又读了文件接着做，没用 end_turn 交代：再问
  task.messages.push(msg('agent', [read]), msg('agent', [read]))
  const r = await decide('c2', {})
  assert.equal(r.block, true)
  assert.equal(r.why, 'check-resumed')
})

test('没列计划：问过以后跑的是没登记类别的命令工具也算接着做；只调面板自己的工具不算', async () => {
  // 用户 2026-11-05 报：Windows 上问过后跑了 3 条 PowerShell 命令（当时被记成 other），说「我再确认一下」就停了，钩子放行
  const { createBeforeEnd } = await import('./before-end.ts')
  const msg = (role: string, tools: { kind: string; name?: string; label?: string }[] = [], panel = '') => ({
    id: `m${Math.random()}`,
    role,
    panel,
    tools,
    text: '',
    at,
  })
  const read = { kind: 'read', label: 'a.ts' }
  const task = {
    id: 'c3',
    projectId: '',
    parentTaskId: '',
    mode: 'task',
    messages: [msg('user'), msg('agent', Array(9).fill(read)), msg('system', [], 'hook')],
    requests: [],
    plans: [],
    steps: [],
    changes: [],
    turnEnds: [],
  }
  const sc = {
    live: new Map([['c3', { task }]]),
    store: { get: async () => task, list: async () => [] },
    startQueue: new Set(),
    background: { list: () => [] },
  } as never
  const decide = createBeforeEnd(sc, {
    budget: { take: () => 1 } as never,
    inputOf: () => 'in',
    haltedBy: () => '',
    activeChildren: async () => 0,
  })
  // 问过以后只查了一下面板状态：不是接着做，不再问
  task.messages.push(msg('agent', [{ kind: 'other', name: 'MCP', label: 'panel · get_status' }]))
  assert.deepEqual(await decide('c3', {}), { block: false, why: 'answered' })
  // 问过以后跑了没登记类别的工具：算接着做，再问
  task.messages.push(msg('agent', [{ kind: 'other', name: 'SomeNewShell', label: '$p = 1' }]))
  const r = await decide('c3', {})
  assert.equal(r.block, true)
  assert.equal(r.why, 'check-resumed')
})

test('没列计划、还没问过：只调了一两个工具就要结束，也问一次收尾自检，不按动手次数放行', async () => {
  // 「我先跑一下测试」「我去派子对话」说完就停：面板不读回复文字，只调了一个工具也要问一次
  const { createBeforeEnd } = await import('./before-end.ts')
  const msg = (role: string, tools: { kind: string; label?: string }[] = [], panel = '') => ({
    id: `m${Math.random()}`,
    role,
    panel,
    tools,
    text: '',
    at,
  })
  const task = {
    id: 'c4',
    projectId: '',
    parentTaskId: '',
    mode: 'task',
    messages: [msg('user'), msg('agent', [{ kind: 'read', label: 'a.ts' }])],
    requests: [],
    plans: [],
    steps: [],
    changes: [],
    turnEnds: [],
  }
  const sc = {
    live: new Map([['c4', { task }]]),
    store: { get: async () => task, list: async () => [] },
    startQueue: new Set(),
    background: { list: () => [] },
  } as never
  const decide = createBeforeEnd(sc, {
    budget: { take: () => 1 } as never,
    inputOf: () => 'in',
    haltedBy: () => '',
    activeChildren: async () => 0,
  })
  const r = await decide('c4', {})
  assert.equal(r.block, true)
  assert.equal(r.why, 'check-worked')
  // 问过以后只回了话：放行
  task.messages.push(msg('system', [], 'hook'), msg('agent'))
  assert.deepEqual(await decide('c4', {}), { block: false, why: 'answered' })
})
