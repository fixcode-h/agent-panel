import assert from 'node:assert/strict'
import test from 'node:test'
import { WEBHOOK_MAX_ATTEMPTS, whenLabel, type Schedule } from '../shared/schedule.ts'
import { deliverWebhook, webhookPayload } from './webhook.ts'

const at = (y: number, mo: number, d: number, h: number) => new Date(y, mo - 1, d, h).toISOString()

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: 'schedule-1',
  name: '每日构建',
  prompt: '跑一遍构建',
  projectId: 'proj-1',
  agentId: '',
  repeat: 'daily',
  weekdays: [],
  at: at(2026, 5, 1, 9),
  enabled: true,
  dependsOn: [],
  budget: { tokens: 0, minutes: 0 },
  endDate: '',
  status: 'pending',
  lastRunAt: '',
  lastTaskId: '',
  missedAt: '',
  lastError: '',
  blockedAt: '',
  blockedReason: '',
  lastDelivery: null,
  runs: [],
  createdAt: at(2026, 4, 30, 9),
  updatedAt: at(2026, 4, 30, 9),
  ...over,
})

/** 假 fetch：记下每次调用，按队列返回结果（用完就重复最后一个） */
function fakeFetch(results: (() => Promise<Response>)[]) {
  const calls: { url: string; body: unknown }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const next = results[Math.min(calls.length - 1, results.length - 1)]
    return next()
  }) as unknown as typeof fetch
  return { impl, calls }
}

const ok = () => Promise.resolve(new Response('ok', { status: 200 }))
const serverError = () => Promise.resolve(new Response('boom', { status: 500 }))

// 测试用占位地址：不写真实内网地址，免得仓库里留下内网信息
const config = { enabled: true, url: 'https://hooks.example.com/agent-panel' }

test('Webhook 没开或没填地址：不投递，也不记录结果', async () => {
  const { impl, calls } = fakeFetch([ok])
  assert.equal(
    await deliverWebhook(
      { enabled: false, url: config.url },
      'run',
      webhookPayload(schedule(), 'run', at(2026, 5, 1, 9)),
      { fetchImpl: impl },
    ),
    null,
  )
  assert.equal(
    await deliverWebhook({ enabled: true, url: '  ' }, 'run', webhookPayload(schedule(), 'run', at(2026, 5, 1, 9)), {
      fetchImpl: impl,
    }),
    null,
  )
  assert.equal(calls.length, 0)
})

test('Webhook 投递成功：记下状态码和尝试次数，载荷带计划、轮次、结果', async () => {
  const { impl, calls } = fakeFetch([ok])
  const s = schedule({ lastRunAt: at(2026, 5, 1, 9), lastTaskId: 'task-1', status: 'done' })
  const payload = webhookPayload(s, 'run', at(2026, 5, 1, 9), '构建项目')
  const res = await deliverWebhook(config, 'run', payload, { fetchImpl: impl })
  assert.equal(res?.ok, true)
  assert.equal(res?.status, 200)
  assert.equal(res?.attempts, 1)
  assert.equal(res?.error, '')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, config.url)
  assert.deepEqual(
    { ...(calls[0].body as Record<string, unknown>), sentAt: '' },
    {
      event: 'run',
      scheduleId: 'schedule-1',
      name: '每日构建',
      projectId: 'proj-1',
      projectName: '构建项目',
      repeat: 'daily',
      at: at(2026, 5, 1, 9),
      taskId: 'task-1',
      error: '',
      sentAt: '',
    },
  )
})

test('Webhook 非 2xx：重试到上限就停，记下最后一次的状态码', async () => {
  const { impl, calls } = fakeFetch([serverError])
  const res = await deliverWebhook(
    config,
    'fail',
    webhookPayload(schedule({ lastError: '项目不存在' }), 'fail', at(2026, 5, 1, 9)),
    {
      fetchImpl: impl,
      // 重试间隔在单测里改成 0：这里验的是次数，不是真的等
      retryDelayMs: 0,
    },
  )
  assert.equal(calls.length, WEBHOOK_MAX_ATTEMPTS)
  assert.equal(res?.ok, false)
  assert.equal(res?.attempts, WEBHOOK_MAX_ATTEMPTS)
  assert.equal(res?.status, 500)
  assert.match(res?.error ?? '', /500/)
})

test('Webhook 连不上（超时、DNS 错）：重试到上限，原文留在结果里，不抛出', async () => {
  const { impl, calls } = fakeFetch([() => Promise.reject(new Error('The operation was aborted due to timeout'))])
  const res = await deliverWebhook(config, 'miss', webhookPayload(schedule(), 'miss', at(2026, 5, 1, 9)), {
    fetchImpl: impl,
    retryDelayMs: 0,
  })
  assert.equal(calls.length, WEBHOOK_MAX_ATTEMPTS)
  assert.equal(res?.ok, false)
  assert.equal(res?.status, 0)
  assert.match(res?.error ?? '', /timeout/)
})

test('Webhook 地址不是 http / https：不投递，直接记一条无效地址', async () => {
  const { impl, calls } = fakeFetch([ok])
  const res = await deliverWebhook(
    { enabled: true, url: 'ftp://hooks.example.com/x' },
    'run',
    webhookPayload(schedule(), 'run', at(2026, 5, 1, 9)),
    { fetchImpl: impl },
  )
  assert.equal(calls.length, 0)
  assert.equal(res?.ok, false)
  assert.equal(res?.attempts, 0)
  assert.equal(res?.error, 'Webhook 地址无效')
})

test('载荷：失败 / 错过 / 没启动都带上原因，只有成功启动才带任务 id', () => {
  const failed = webhookPayload(schedule({ lastTaskId: 'old', lastError: '项目不存在' }), 'fail', at(2026, 5, 1, 9))
  assert.equal(failed.taskId, '')
  assert.equal(failed.error, '项目不存在')

  const blocked = webhookPayload(
    schedule({ blockedAt: at(2026, 5, 1, 9), blockedReason: '因为「构建」启动失败，没有启动' }),
    'blocked',
    at(2026, 5, 1, 9),
  )
  assert.equal(blocked.error, '因为「构建」启动失败，没有启动')

  // 成功启动之后 at 已经推到下一次：载荷里的 at 必须是这一轮（调用方传入的快照）
  const ran = webhookPayload(
    schedule({ lastRunAt: at(2026, 5, 1, 9), lastTaskId: 'task-1', at: at(2026, 5, 2, 9) }),
    'run',
    at(2026, 5, 1, 9),
  )
  assert.equal(ran.at, at(2026, 5, 1, 9))
  assert.equal(ran.taskId, 'task-1')
  assert.equal(ran.error, '')
})

test('载荷：错过和没启动各带自己的原因，不拿上一次的启动失败原因冒充', () => {
  const s = schedule({
    lastError: '项目不存在',
    missedAt: at(2026, 5, 1, 9),
    blockedAt: at(2026, 5, 2, 9),
    blockedReason: '因为「构建」启动失败，没有启动',
  })
  // 启动失败：用失败原文
  assert.equal(webhookPayload(s, 'fail', at(2026, 5, 1, 9)).error, '项目不存在')
  // 被上游拦住：用这次拦住的说明，而不是 lastError 里更早的那条
  assert.equal(webhookPayload(s, 'blocked', at(2026, 5, 2, 9)).error, '因为「构建」启动失败，没有启动')
  // 错过：说清是哪一次错过，不是启动失败
  const missed = webhookPayload(s, 'miss', at(2026, 5, 1, 9)).error
  assert.match(missed, /错过/)
  assert.ok(missed.includes(whenLabel(s.missedAt)))
  assert.ok(!missed.includes('项目不存在'))
})

test('载荷：用户同时改过排期、missedAt 被清掉时，错过原因用这一轮的到点时间', () => {
  // writeBack 发现排期被改过时会丢掉 missedAt，这时不能把时间位置空着
  const s = schedule({ missedAt: '' })
  const runAt = at(2026, 5, 1, 9)
  const error = webhookPayload(s, 'miss', runAt).error
  assert.match(error, /错过/)
  assert.ok(error.includes(whenLabel(runAt)), `错过原因里要有时间：${error}`)
  assert.ok(!/错过\s+（/.test(error), `时间位置不能空着：${error}`)
})
