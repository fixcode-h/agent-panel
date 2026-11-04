/**
 * 启动迁移：崩溃留在盘上的「在用」标记（working / awaitingUser / prewarming）要清掉，
 * 不然清理和回收判定会一直把这些对话当成在用；只在内存里的东西（排着的消息、提问的回调、后台命令）丢了要落到盘上。
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

test('migrateOnStart：对话已经说完、派出的子任务还标着在跑：按被打断收口，计划里等它的那一步退回需要修复', async () => {
  const step = { id: 'h1', slot: 'sub', title: '补写 Bug 记录', agentId: 'doc', status: 'running', startedAt: at }
  const plan = {
    id: 'p1',
    title: '修 avg',
    createdAt: at,
    steps: [
      { id: '1', title: '写 Bug 记录', status: 'waiting', waits: [{ kind: 'helper', ref: 'h1', state: 'waiting' }] },
    ],
  }
  // 子任务挂着一张权限卡：对话算「等你处理」，不在恢复名单里（真实 API 实测里就是这样漏掉的）
  const ask = { id: 'r1', step: 'h1', agentId: 'doc', kind: 'tool', title: '使用工具：Read', at }
  const store = memStore([task('a', { steps: [step], plans: [plan], requests: [ask] })])
  await migrateOnStart(store)
  const a = store.map.get('a')!
  assert.equal(a.status, 'done', '对话本身的状态不动')
  assert.equal(a.steps[0].status, 'pending')
  assert.equal(a.steps[0].interrupted, true, '继续时 resume 原来的会话')
  assert.equal(activePlan(a)!.steps[0].status, 'running', '等它的那一步退回进行中')
  assert.match(a.messages.at(-1)!.text, /子任务「补写 Bug 记录」还在执行，已中断/)
  assert.equal(a.requests.length, 0, '回调跟着进程没了的卡片作废')
  assert.match(a.messages.at(-1)!.text, /「使用工具：Read」，已经作废/)
})

test('migrateOnStart：替子对话起的编译跑到一半面板重启：退回「申请了还没编」，父对话收件箱里留一句重新 request_build', async () => {
  const store = memStore([
    task('p'),
    task('kid', {
      parentTaskId: 'p',
      title: '改角色移动',
      buildAsk: { state: 'building', at, sig: 's', jobs: ['job-1'] },
    }),
  ])
  await migrateOnStart(store, createClaims())
  const kid = store.map.get('kid')!
  assert.equal(kid.buildAsk?.state, 'asked', '父对话再 request_build 时面板会自动补上它')
  assert.deepEqual(kid.buildAsk?.jobs, [])
  assert.match(
    store.map.get('p')!.inbox.at(-1)!.text,
    /替子对话「改角色移动」（id kid）起的编译没跑完.*重新调用 request_build/,
  )
})

test('migrateOnStart：诊断报告还在等用户确认的子对话（保活着 CLI 等下一句）重启后仍在等确认：不落成已中断、不进继续名单', async () => {
  const diag = { version: 1, at, status: 'pending', symptom: 's', rootCause: 'r', fix: 'f', files: ['a.ts'] }
  const plans = [
    {
      id: 'p1',
      createdAt: at,
      steps: [
        { id: 's1', title: '交诊断报告', status: 'running' },
        { id: 's2', title: '修' },
      ],
    },
  ]
  const store = memStore([
    task('kid', { parentTaskId: 'a', bug: true, status: 'running', awaitingUser: true, diagnoses: [diag], plans }),
    // 对照：同样计划没做完、没有等确认的报告，照常落成已中断并进名单
    task('other', { parentTaskId: 'a', status: 'running', awaitingUser: true, plans }),
  ])
  const crashed = await migrateOnStart(store)
  const kid = store.map.get('kid')!
  assert.equal(kid.status, 'done', '不是已中断：convState 按报告算在运行，弹窗和「查看报告」都在')
  assert.equal(kid.stopReason, undefined)
  assert.equal(kid.awaitingUser, false)
  assert.equal(kid.diagnoses?.[0].status, 'pending', '报告原样留着')
  assert.ok(!kid.messages.some((m) => /已中断|还没收尾/.test(m.text)), '不写「已中断」的说明')
  assert.deepEqual(crashed, ['other'], '不进重启后的继续名单：等的是用户，不该拉起 CLI')
  assert.equal(store.map.get('other')!.status, 'stopped')
})
