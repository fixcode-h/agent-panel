/**
 * 启动迁移：崩溃留在盘上的「在用」标记（working / awaitingUser / prewarming）要清掉，
 * 不然清理和保活上限会一直把这些对话当成在用；只在内存里的东西（排着的消息、提问的回调、后台命令）丢了要落到盘上。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { activePlan } from '../../shared/plan.ts'
import { Task } from '../../shared/schema.ts'
import { planStalled } from '../../shared/task.ts'
import { migrateOnStart } from './startup.ts'
import { createClaims } from '../claims.ts'

setLang('zh')
const at = '2026-10-01T00:00:00.000Z'
const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({ id, projectId: '', title: id, mode: 'chat', status: 'done', createdAt: at, updatedAt: at, ...extra })

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

test('migrateOnStart：没在跑的对话上残留的 working / awaitingUser / prewarming 全部清掉，不动状态；共用目录子对话的认领按改过的文件补回', async () => {
  const store = memStore([
    task('a', { awaitingUser: true }),
    task('kid', {
      parentTaskId: 'a',
      status: 'stopped',
      stopReason: 'user',
      changes: [{ path: 'x.ts', add: 1, del: 0 }],
    }),
    task('w', { working: true }),
    task('p', { prewarming: true, status: 'stopped' }),
    task('clean'),
  ])
  const claims = createClaims()
  await migrateOnStart(store, claims)
  assert.deepEqual(
    claims.list('a').map((c) => `${c.path}:${c.taskId}`),
    ['x.ts:kid'],
  )
  for (const id of ['a', 'w', 'p']) {
    const tk = store.map.get(id)!
    assert.equal(tk.working, false, id)
    assert.equal(tk.awaitingUser, false, id)
    assert.equal(tk.prewarming, false, id)
  }
  assert.equal(store.map.get('a')!.status, 'done', '只清标记，不把做完的改成别的状态')
  assert.equal(store.map.get('p')!.status, 'stopped')
})

test('migrateOnStart：崩溃前排着的消息改成没送出去，作废的提问写进说明，计划里等后台命令的步骤收口', async () => {
  const held = (id: string, how = 'held') => ({ id, role: 'user', text: id, at, delivery: { how, at } })
  const waitBg = (ref: string) => [{ kind: 'background', ref, label: '测试', state: 'waiting', at }]
  const plans = [
    {
      id: 'p1',
      createdAt: at,
      steps: [
        { id: 's1', title: '跑测试', status: 'waiting', waits: waitBg('abcd1234') },
        {
          id: 's2',
          title: '改代码',
          status: 'waiting',
          children: [{ id: 's2.1', title: '构建', status: 'waiting', waits: waitBg('ef01') }],
        },
      ],
    },
  ]
  const store = memStore([
    task('c', {
      status: 'running',
      working: true,
      requests: [{ id: 'q1', kind: 'question', title: '用 A 还是 B？', at }],
      messages: [{ id: 'u1', role: 'user', text: '做三件事', at }, held('u2'), held('u3'), held('n1', 'notes')],
      plans,
    }),
    // 没在跑的旧数据里残留的「这一轮结束后处理」和计划等待也收，列表时间不动
    task('old', { status: 'stopped', messages: [held('o1')], plans }),
    task('gone', { status: 'stopped', deletedAt: at, messages: [held('d1')] }),
  ])
  await migrateOnStart(store)
  const c = store.map.get('c')!
  assert.equal(c.status, 'stopped')
  assert.deepEqual(c.requests, [])
  assert.match(c.messages.at(-1)!.text, /已中断[\s\S]*\n中断时还有没处理的提问 \/ 确认：「用 A 还是 B？」，已经作废/)
  const how = (tk: Task) => Object.fromEntries(tk.messages.flatMap((m) => (m.delivery ? [[m.id, m.delivery.how]] : [])))
  assert.deepEqual(how(c), { u2: 'lost', u3: 'lost', n1: 'notes' }, 'notes 可能已经被取走，不动')
  for (const tk of [c, store.map.get('old')!]) {
    const [s1, s2] = activePlan(tk)!.steps
    assert.equal(s1.status, 'running', tk.id)
    assert.match(s1.note, /^需要修复/)
    assert.equal(s2.children[0].status, 'running', '子步骤的等待也收')
    assert.equal(planStalled(tk), true, '面板继续后会推它接着做')
  }
  assert.deepEqual(how(store.map.get('old')!), { o1: 'lost' })
  assert.equal(store.map.get('old')!.updatedAt, at)
  assert.deepEqual(how(store.map.get('gone')!), { d1: 'held' }, '回收站里的不动')
})

test('migrateOnStart：返回上次没正常退出时还在执行的对话（首页「全部继续」用），停在等下一句的不算', async () => {
  const store = memStore([
    task('run', { status: 'running' }),
    task('idle', { status: 'running', awaitingUser: true }),
    task('done'),
  ])
  assert.deepEqual(await migrateOnStart(store), ['run'])
  assert.equal(store.map.get('run')!.stopReason, 'restart')
})
