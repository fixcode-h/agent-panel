/**
 * 对话状态的收口与定时核对：记录说在做、面板里却没人在做的，连着两次看到才收，收成「已中断」并说明原因。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { Task } from '../../shared/schema.ts'
import { dropAsked, settleStopped, stateBreaks } from '../../shared/tasks/settle.ts'
import { createStateSweep } from './state-sweep.ts'

setLang('zh')
const at = '2026-10-01T00:00:00.000Z'
const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({ id, projectId: '', title: id, mode: 'chat', status: 'done', createdAt: at, updatedAt: at, ...extra })

/** 内存里的任务表：只有核对用到的三个方法 */
function memStore(list: Task[]) {
  const map = new Map(list.map((x) => [x.id, structuredClone(x)]))
  return {
    map,
    list: async () => [...map.values()].map((x) => structuredClone(x)),
    get: async (id: string) => structuredClone(map.get(id) ?? null),
    update: async (id: string, tk: Task) => {
      map.set(id, structuredClone(tk))
      return tk
    },
  }
}

const idle = { live: false, queued: false, jobs: 0, merging: false }

test('stateBreaks：只有记录说在做、面板里又没有执行位 / 启动队列 / 后台命令时才算矛盾', () => {
  const running = task('r', { status: 'running' })
  assert.deepEqual(stateBreaks(running, idle), ['orphan'])
  assert.deepEqual(stateBreaks(running, { ...idle, live: true }), [])
  assert.deepEqual(stateBreaks(running, { ...idle, queued: true }), [])
  assert.deepEqual(stateBreaks(running, { ...idle, jobs: 1 }), [], '后台命令会把结果推回来，不算没人管')
  assert.deepEqual(stateBreaks(task('d'), idle), [], '做完的不算')
  assert.deepEqual(stateBreaks(task('w', { working: true }), idle), ['orphan'])
  assert.deepEqual(stateBreaks({ ...running, deletedAt: at }, idle), [], '回收站里的不管')
  const merging = task('m', { wrapRequest: { state: 'merging', note: '', tests: '', at } })
  assert.deepEqual(stateBreaks(merging, idle), ['merging'])
  assert.deepEqual(stateBreaks(merging, { ...idle, merging: true }), [])
})

test('settleStopped：结掉轮次、步骤和计时，记下原因，不动消息和列表时间；CLI 进程结束时作废的提问写一句说明', () => {
  const tk = task('s', {
    status: 'running',
    working: true,
    runStartedAt: '2026-09-30T23:59:00.000Z',
    turns: [
      {
        id: 't1',
        title: '',
        startedAt: at,
        status: 'running',
        from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
      },
    ],
    steps: [{ id: 'n1', agentId: '', title: '节点', status: 'running', startedAt: at }],
  })
  const next = settleStopped(tk, 'lost')
  assert.equal(next.status, 'stopped')
  assert.equal(next.stopReason, 'lost')
  assert.equal(next.working, false)
  assert.equal(next.runStartedAt, '')
  assert.equal(next.runMs, 60_000, '用时算到最后一次落盘')
  assert.equal(next.turns[0].status, 'stopped')
  assert.equal(next.steps[0].status, 'pending')
  assert.equal(next.steps[0].interrupted, true)
  assert.equal(next.updatedAt, tk.updatedAt)
  assert.equal(next.messages.length, tk.messages.length)
  assert.equal(tk.status, 'running', '不改传进来的那份')
  // 进程结束（优雅重启、超时、崩溃）时它问的还没回答：去掉并写一句，最多点名 3 个；别的进程问的不动
  const q = (id: string) => ({ id, kind: 'question' as const, title: `问题${id}`, at })
  const ended = task('e', { requests: [q('1'), q('2'), q('3'), q('4'), q('other')] })
  const msg = { id: 'm', agentId: '', step: '' }
  assert.equal(dropAsked(ended, ['1', '2', '3', '4'], msg), true)
  assert.deepEqual(
    ended.requests.map((x) => x.id),
    ['other'],
  )
  assert.match(ended.messages.at(-1)!.text, /「问题1」、「问题2」、「问题3」 等 4 项，已经作废/)
  assert.equal(ended.messages.at(-1)!.transient, true)
  assert.equal(dropAsked(ended, ['1'], msg), false, '已经清掉的（用户自己关了提问）不再写')
  assert.equal(ended.messages.length, 1)
})

test('定时核对：连着两次看到同一个矛盾才收口，中间被写过就重新计；作废的提问写进说明', async () => {
  const ask = (id: string, kind: string, title: string) => ({ id, kind, title, at })
  const store = memStore([
    task('a', {
      status: 'running',
      requests: [ask('q', 'question', '用 A 还是 B？'), ask('c', 'confirm', '节点结果')],
    }),
    task('b', { status: 'running', requests: [ask('c2', 'confirm', '节点结果')] }),
  ])
  const sweep = createStateSweep({ store, live: () => idle, reportChild: () => {}, remindParent: async () => false })
  assert.deepEqual(await sweep.sweep(), [], '第一次只记下')
  // b 在两次之间被写过（比如这一轮刚收尾）：重新计
  store.map.get('b')!.updatedAt = '2026-10-01T00:00:01.000Z'
  assert.deepEqual(await sweep.sweep(), [{ id: 'a', kind: 'orphan' }])
  const a = store.map.get('a')!
  assert.equal(a.status, 'stopped')
  assert.equal(a.stopReason, 'lost')
  assert.match(a.messages.at(-1)!.text, /已经没有在执行/)
  // 提问被清掉了（回调跟着进程没了）：说明里点名；工作流节点的确认继续执行时会重新确认，不算
  assert.deepEqual(a.requests, [])
  assert.match(a.messages.at(-1)!.text, /\n中断时还有没处理的提问 \/ 确认：「用 A 还是 B？」，已经作废/)
  assert.doesNotMatch(a.messages.at(-1)!.text, /节点结果/)
  assert.deepEqual(await sweep.sweep(), [{ id: 'b', kind: 'orphan' }])
  assert.doesNotMatch(store.map.get('b')!.messages.at(-1)!.text, /作废/, '只有确认时不加这句')
})

test('定时核对：第二次之前被拉起来的不收；合并中没人在合的退回待处理并告诉父对话', async () => {
  const store = memStore([
    task('p', { status: 'done' }),
    task('k', { parentTaskId: 'p', wrapRequest: { state: 'merging', note: '', tests: '', at } }),
    task('r', { status: 'running' }),
  ])
  let liveR = false
  const sweep = createStateSweep({
    store,
    live: (id) => ({ ...idle, live: id === 'r' && liveR }),
    reportChild: () => {},
    remindParent: async () => false,
  })
  await sweep.sweep()
  liveR = true
  assert.deepEqual(await sweep.sweep(), [{ id: 'k', kind: 'merging' }])
  assert.equal(store.map.get('r')!.status, 'running', '已经有执行位的不动')
  assert.equal(store.map.get('k')!.wrapRequest?.state, 'requested')
  assert.match(store.map.get('p')!.inbox.at(-1)!.text, /重新调用 finish_child/)
})

test('定时核对：子对话落成已中断后交给父对话上报（只报一次）；顶层对话、合并中的不报；上报出错不影响收口', async () => {
  const store = memStore([
    task('p', { status: 'done' }),
    task('k', { status: 'running', parentTaskId: 'p' }),
    task('top', { status: 'running' }),
    task('m', { parentTaskId: 'p', wrapRequest: { state: 'merging', note: '', tests: '', at } }),
  ])
  const reported: Task[] = []
  const sweep = createStateSweep({
    store,
    live: () => idle,
    reportChild: (tk) => void reported.push(tk),
    remindParent: async () => false,
  })
  await sweep.sweep()
  await sweep.sweep()
  assert.deepEqual(
    reported.map((x) => [x.id, x.status, x.stopReason]),
    [['k', 'stopped', 'lost']],
  )
  await sweep.sweep()
  assert.equal(reported.length, 1, '再扫不重复报')

  const store2 = memStore([task('p'), task('k', { status: 'running', parentTaskId: 'p' })])
  const failing = createStateSweep({
    store: store2,
    live: () => idle,
    reportChild: () => {
      throw new Error('boom')
    },
    remindParent: async () => false,
  })
  await failing.sweep()
  assert.deepEqual(await failing.sweep(), [{ id: 'k', kind: 'orphan' }])
  assert.equal(store2.map.get('k')!.stopReason, 'lost')
})

test('定时核对：子对话挂着「等父对话安排修复」、父对话连着两次空闲才提醒，同一条等待只提醒一次；父对话在跑、被挡住时不算', async () => {
  const plan = (state: 'waiting' | 'ok') => [
    {
      id: 'pl',
      status: 'active',
      createdAt: at,
      updatedAt: at,
      steps: [{ id: '1', title: '跑测试', status: 'waiting', waits: [{ kind: 'parent', ref: 'fix', state, at }] }],
    },
  ]
  const store = memStore([
    task('p'),
    task('k', { parentTaskId: 'p', plans: plan('waiting') }),
    task('k2', { parentTaskId: 'p', plans: plan('ok') }),
  ])
  let parentLive = true
  let allow = false
  const asked: string[] = []
  const sweep = createStateSweep({
    store,
    live: (id) => ({ ...idle, live: id === 'p' && parentLive }),
    reportChild: () => {},
    remindParent: async (kid) => {
      asked.push(kid.id)
      return allow
    },
  })
  await sweep.sweep()
  await sweep.sweep()
  assert.deepEqual(asked, [], '父对话在执行位上：它这一轮还能回')
  parentLive = false
  await sweep.sweep()
  assert.deepEqual(asked, [], '第一次只记下')
  await sweep.sweep()
  assert.deepEqual(asked, ['k'], '已经回过的（等待不是 waiting）不提醒')
  // 被 holdWake 挡住（用户停下父对话、超限）：没提醒，之后再连看两次再试
  allow = true
  await sweep.sweep()
  await sweep.sweep()
  assert.deepEqual(asked, ['k', 'k'])
  await sweep.sweep()
  await sweep.sweep()
  assert.deepEqual(asked, ['k', 'k'], '提醒过一次就不再提醒')
})
