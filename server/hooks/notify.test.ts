/**
 * 只通知的面板事件（ADR 0049 第三期）：对话状态的变化比出事件、跑对得上的钩子；
 * 计划任务跑完走 HTTP 钩子，按原来「计划 Webhook」的规矩重试、记结果；设置里的老 Webhook 迁成钩子。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-notify-'))
process.env.AGENT_PANEL_DATA = dir

const { setLang } = await import('../../shared/i18n.ts')
const { Task } = await import('../../shared/schema.ts')
const { WEBHOOK_MAX_ATTEMPTS } = await import('../../shared/schedule.ts')
const { notifySchedule, taskTransitions, notifyHooks } = await import('./notify.ts')
const { putHook, readHooks, deleteHook, migrateWebhook, resetHooksCache } = await import('./store.ts')

setLang('zh')

const at = '2026-11-04T00:00:00.000Z'
const task = (over: Record<string, unknown> = {}) =>
  Task.parse({
    id: 't1',
    projectId: 'p1',
    title: 't',
    mode: 'chat',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    ...over,
  })

/** 假 fetch：记下每次调用，按队列返回结果（用完就重复最后一个） */
function fakeFetch(results: (() => Promise<Response>)[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return results[Math.min(calls.length - 1, results.length - 1)]()
  }) as unknown as typeof fetch
  return { impl, calls }
}
const ok = () => Promise.resolve(new Response('ok', { status: 200 }))
const serverError = () => Promise.resolve(new Response('boom', { status: 500 }))
// 测试用占位地址：不写真实内网地址
const URL_ = 'https://hooks.example.com/agent-panel'

const clear = async () => {
  for (const h of (await readHooks()).hooks) await deleteHook(h.id)
}

test('对话状态的变化比出事件：完成一轮、失败、等你、请求收尾、计划做完一步；没变的不发', () => {
  const plan = (status: string) => ({
    id: 'p',
    createdAt: at,
    steps: [
      { id: 'a', title: '改代码', status: 'done' },
      { id: 'b', title: '跑测试', status },
    ],
  })
  const old = task({ plans: [plan('running')] })
  const next = task({
    status: 'failed',
    turnDoneAt: at,
    awaitingUser: true,
    wrapRequest: { state: 'requested', at, note: '可以合回了' },
    plans: [plan('done')],
  })
  const evs = taskTransitions(old, next)
  assert.deepEqual(
    evs.map((e) => e.event),
    ['task.done', 'task.failed', 'task.waitingUser', 'task.wrapRequested', 'plan.stepDone'],
  )
  assert.equal(evs.find((e) => e.event === 'task.failed')?.notice.status, 'failed')
  assert.equal(evs.find((e) => e.event === 'plan.stepDone')?.notice.step, '跑测试', '只报新做完的那一步')
  assert.deepEqual(taskTransitions(next, next), [])
  assert.deepEqual(taskTransitions(null, next), [], '新建的不算变化')
})

test('计划任务跑完：没有 HTTP 钩子时不记投递；有就 POST 钩子输入，结果带在 schedule 下', async () => {
  await clear()
  assert.equal(await notifySchedule('run', { result: 'run', name: '每日构建', taskId: 'task-1' }), null)
  await putHook({ name: 'W', event: 'schedule.finished', action: { type: 'http', url: URL_ }, enabled: true })
  const { impl, calls } = fakeFetch([ok])
  const res = await notifySchedule(
    'run',
    { result: 'run', scheduleId: 's1', name: '每日构建', projectId: 'p1', taskId: 'task-1' },
    { fetchImpl: impl },
  )
  assert.deepEqual([res?.ok, res?.status, res?.attempts, res?.event], [true, 200, 1, 'run'])
  assert.equal(calls[0].url, URL_)
  assert.equal(calls[0].body.event, 'schedule.finished')
  assert.deepEqual((calls[0].body.schedule as Record<string, string>).result, 'run')
  assert.equal((calls[0].body.task as { id: string }).id, 'task-1')
})

test('HTTP 钩子非 2xx、连不上：重试到上限就停，原因记在结果里，不抛出', async () => {
  await clear()
  await putHook({ name: 'W', event: 'schedule.finished', action: { type: 'http', url: URL_ }, enabled: true })
  const bad = fakeFetch([serverError])
  const r1 = await notifySchedule('fail', { result: 'fail' }, { fetchImpl: bad.impl, retryDelayMs: 0 })
  assert.deepEqual([r1?.ok, r1?.status, r1?.attempts], [false, 500, WEBHOOK_MAX_ATTEMPTS])
  assert.equal(bad.calls.length, WEBHOOK_MAX_ATTEMPTS)
  assert.match(r1?.error ?? '', /500/)
  const down = fakeFetch([() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))])
  const r2 = await notifySchedule('miss', { result: 'miss' }, { fetchImpl: down.impl, retryDelayMs: 0 })
  assert.equal(r2?.ok, false)
  assert.match(r2?.error ?? '', /ENOTFOUND/)
})

test('对话事件上的脚本钩子：真的跑，输入里有对话和状态，范围不对的不跑', async () => {
  await clear()
  const out = path.join(dir, 'done.json')
  await putHook({
    name: '完成通知',
    event: 'task.done',
    action: {
      type: 'command',
      script: `import { writeFileSync } from 'node:fs'\nlet raw = ''\nprocess.stdin.on('data', (c) => (raw += c)).on('end', () => writeFileSync(${JSON.stringify(out)}, raw))`,
    },
    enabled: true,
  })
  const input = {
    event: 'task.done' as const,
    task: { id: 't1', title: '修登录', parent: true },
    project: { id: 'p1', path: dir },
    agent: { id: 'a1', name: '执行' },
    cli: 'claude',
    notice: { status: 'running', step: '' },
  }
  await notifyHooks(input, dir)
  const got = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(got.event, 'task.done')
  assert.equal(got.task.title, '修登录')
  await putHook({ ...(await readHooks()).hooks[0], scope: { projects: ['p2'], agents: [], clis: [] } })
  const { rmSync, existsSync } = await import('node:fs')
  rmSync(out)
  await notifyHooks(input, dir)
  assert.ok(!existsSync(out), '范围外的项目不跑')
})

test('设置里原来的「计划 Webhook」迁成钩子：只迁一次，开关照原样，没填地址的不建', async () => {
  await clear()
  const raw = JSON.parse(readFileSync(path.join(dir, 'config', 'hooks.json'), 'utf8'))
  assert.equal(raw.migrated?.webhook ?? false, false)
  await migrateWebhook({ enabled: true, url: URL_ })
  let hooks = (await readHooks()).hooks
  assert.equal(hooks.length, 1)
  assert.deepEqual([hooks[0].event, hooks[0].enabled, hooks[0].action.type], ['schedule.finished', true, 'http'])
  await deleteHook(hooks[0].id)
  await migrateWebhook({ enabled: true, url: URL_ })
  assert.equal((await readHooks()).hooks.length, 0, '迁过一次就不再迁（用户删掉的不会回来）')
  resetHooksCache()
  hooks = (await readHooks()).hooks
  assert.equal(hooks.length, 0)
})
