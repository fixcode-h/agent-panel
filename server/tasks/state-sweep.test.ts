/**
 * 对话状态的收口与定时核对：记录说在做、面板里却没人在做的，连着两次看到才收，收成「已中断」并说明原因。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { Task } from '../../shared/schema.ts'
import { settleStopped, stateBreaks } from '../../shared/task-settle.ts'
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

test('settleStopped：结掉轮次、步骤和计时，记下原因，不动消息和列表时间', () => {
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
})

test('定时核对：连着两次看到同一个矛盾才收口，中间被写过就重新计', async () => {
  const store = memStore([task('a', { status: 'running' }), task('b', { status: 'running' })])
  const sweep = createStateSweep({ store, live: () => idle })
  assert.deepEqual(await sweep.sweep(), [], '第一次只记下')
  // b 在两次之间被写过（比如这一轮刚收尾）：重新计
  store.map.get('b')!.updatedAt = '2026-10-01T00:00:01.000Z'
  assert.deepEqual(await sweep.sweep(), [{ id: 'a', kind: 'orphan' }])
  const a = store.map.get('a')!
  assert.equal(a.status, 'stopped')
  assert.equal(a.stopReason, 'lost')
  assert.match(a.messages.at(-1)!.text, /已经没有在执行/)
  assert.deepEqual(await sweep.sweep(), [{ id: 'b', kind: 'orphan' }])
})

test('定时核对：第二次之前被拉起来的不收；合并中没人在合的退回待处理并告诉父对话', async () => {
  const store = memStore([
    task('p', { status: 'done' }),
    task('k', { parentTaskId: 'p', wrapRequest: { state: 'merging', note: '', tests: '', at } }),
    task('r', { status: 'running' }),
  ])
  let liveR = false
  const sweep = createStateSweep({ store, live: (id) => ({ ...idle, live: id === 'r' && liveR }) })
  await sweep.sweep()
  liveR = true
  assert.deepEqual(await sweep.sweep(), [{ id: 'k', kind: 'merging' }])
  assert.equal(store.map.get('r')!.status, 'running', '已经有执行位的不动')
  assert.equal(store.map.get('k')!.wrapRequest?.state, 'requested')
  assert.match(store.map.get('p')!.inbox.at(-1)!.text, /重新调用 finish_child/)
})
