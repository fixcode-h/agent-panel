/**
 * 面板外的通知渠道（服务端）：什么状态变化发什么通知（复用钩子事件和 taskState）、投递只试一次、超时 / 拒收 / 连不上
 * 都把原因打码后记下、事件去重。投递用本地起的 http 服务或假 fetch，不往任何外部地址发。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-notify-ch-'))
process.env.AGENT_PANEL_DATA = dir
// 日志写进临时目录，下面要检查日志里没有地址明文
process.env.AGENT_PANEL_APP_DIR = dir

const { setLang } = await import('../shared/i18n.ts')
const { Task, Settings } = await import('../shared/schema.ts')
const { NotifyChannel } = await import('../shared/notify-channels.ts')
const { channelEvents, deliver, notifyDeliveries, sendToChannel, watchNotifyChannels } =
  await import('./notify-channels.ts')
const { saveSettings } = await import('./settings.ts')
const { logDir } = await import('./log.ts')

setLang('zh')

const at = '2026-11-10T00:00:00.000Z'
const task = (over: Record<string, unknown> = {}) =>
  Task.parse({
    id: 't1',
    projectId: 'p1',
    title: '修购物车',
    mode: 'chat',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    ...over,
  })
const request = { id: 'r1', title: '要执行 rm', kind: 'command', at }
// 占位地址：带一段像 key 的路径，检查它不会出现在报错和日志里
const SECRET_PATH = '/hook/placeholder-secret-path'

function fakeFetch(res: () => Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return res()
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('事件：等你处理按 taskState 变成 needs 才发（已经在等时又多一条请求不再发）', () => {
  const idle = task({ status: 'done', working: false })
  const asking = task({ status: 'running', working: false, requests: [request] })
  assert.deepEqual(channelEvents(idle, asking), [{ event: 'needs' }])
  assert.deepEqual(channelEvents(asking, task({ ...asking, requests: [request, { ...request, id: 'r2' }] })), [])
  assert.deepEqual(channelEvents(null, asking), [], '新建的不算变化')
})

test('事件：失败、做完取钩子的 task.failed / task.done；子对话做完一轮不发；做完但停在等你处理的只发等你处理', () => {
  const run = task({ working: true })
  assert.deepEqual(channelEvents(run, task({ status: 'failed', working: false })), [{ event: 'failed' }])
  assert.deepEqual(channelEvents(run, task({ status: 'done', working: false, turnDoneAt: at })), [{ event: 'done' }])
  assert.deepEqual(
    channelEvents(
      task({ working: true, parentTaskId: 'root' }),
      task({ status: 'done', turnDoneAt: at, parentTaskId: 'root' }),
    ),
    [],
  )
  assert.deepEqual(
    channelEvents(run, task({ status: 'running', working: false, turnDoneAt: at, requests: [request] })),
    [{ event: 'needs' }],
  )
})

test('事件：用量提醒升级才发（快到、到了各一次），回落不发', () => {
  assert.deepEqual(channelEvents(task(), task({ budgetNotice: 'warn' })), [{ event: 'budget', over: false }])
  assert.deepEqual(channelEvents(task({ budgetNotice: 'warn' }), task({ budgetNotice: 'over' })), [
    { event: 'budget', over: true },
  ])
  assert.deepEqual(channelEvents(task({ budgetNotice: 'over' }), task({ budgetNotice: 'warn' })), [])
})

test('投递：真的 POST 到本地服务，飞书模板的请求体对得上；机器人回 200 但业务拒收算失败', async () => {
  const got: unknown[] = []
  let reply = '{"code":0,"msg":"success"}'
  const srv = createServer((req, res) => {
    let raw = ''
    req
      .on('data', (c) => (raw += c))
      .on('end', () => {
        got.push(JSON.parse(raw))
        res.setHeader('content-type', 'application/json')
        res.end(reply)
      })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}${SECRET_PATH}`
  const msg = {
    event: 'failed' as const,
    project: '商城',
    title: '修购物车',
    taskId: 't1',
    link: 'http://127.0.0.1:8787/#/projects/p1/t1',
  }
  try {
    assert.deepEqual(await sendToChannel({ url, template: 'feishu' }, msg), { ok: true, error: '' })
    const body = got[0] as { msg_type: string; content: { text: string } }
    assert.equal(body.msg_type, 'text')
    assert.match(body.content.text, /对话这一轮失败了[\s\S]*项目：商城[\s\S]*#\/projects\/p1\/t1$/)
    reply = '{"code":19024,"msg":"Key Words Not Found"}'
    const bad = await sendToChannel({ url, template: 'feishu' }, msg)
    assert.equal(bad.ok, false)
    assert.match(bad.error, /19024/)
    assert.equal(got.length, 2, '失败也只试一次，不重试')
  } finally {
    srv.close()
  }
})

test('投递：超时、非 2xx、连不上都记成失败，原因里没有地址明文，日志里也打了码', async () => {
  const url = `https://example.invalid${SECRET_PATH}?key=placeholder`
  const msg = { event: 'needs' as const, project: '', title: 't', taskId: 't1', link: '' }
  // 超时：一直不回的服务
  const hang = createServer(() => {})
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r))
  const hangUrl = `http://127.0.0.1:${(hang.address() as AddressInfo).port}${SECRET_PATH}`
  try {
    const slow = await sendToChannel({ url: hangUrl, template: 'json' }, msg, { timeoutMs: 200 })
    assert.deepEqual(slow, { ok: false, error: '1 秒内没有回应' })
  } finally {
    hang.closeAllConnections()
    hang.close()
  }
  const s500 = fakeFetch(() => Promise.resolve(new Response('x', { status: 502 })))
  assert.deepEqual(await sendToChannel({ url, template: 'json' }, msg, { fetchImpl: s500.impl }), {
    ok: false,
    error: '地址返回 502',
  })
  const down = fakeFetch(() => Promise.reject(new Error(`request to ${url} failed, reason: ENOTFOUND`)))
  const ch = NotifyChannel.parse({ id: 'c-down', name: '群', url })
  const r = await deliver(ch, msg, { fetchImpl: down.impl })
  assert.equal(r.ok, false)
  assert.ok(!r.error.includes('placeholder'), r.error)
  assert.match(r.error, /ENOTFOUND/)
  assert.equal(notifyDeliveries()['c-down'].ok, false)
  assert.equal(notifyDeliveries()['c-down'].error, r.error)
  const logs = readdirSync(logDir())
    .map((f) => readFileSync(path.join(logDir(), f), 'utf8'))
    .join('\n')
  assert.match(logs, /通知渠道投递失败/)
  assert.ok(!logs.includes('placeholder'), '日志里不能有地址的路径和查询串')
})

test('接到任务存储上：按渠道勾的事件发，同一个对话同一事件 60 秒内只发一次，没勾的事件不发', async () => {
  const url = `https://example.invalid${SECRET_PATH}`
  await saveSettings(
    Settings.parse({
      // 保存设置会按设置里的语言切换服务端语言：固定成中文，下面按中文断言
      language: 'zh',
      notifyChannels: [
        { id: 'a', name: 'A', url, template: 'wecom', events: ['failed'] },
        { id: 'off', name: 'B', url, events: ['failed'], enabled: false },
      ],
    }),
  )
  const { impl, calls } = fakeFetch(() => Promise.resolve(new Response('{"errcode":0}', { status: 200 })))
  const watch = watchNotifyChannels({ projectName: async () => '商城' }, { fetchImpl: impl })
  const run = task({ working: true })
  const failed = task({ status: 'failed', working: false })
  watch(run, failed)
  watch(run, failed)
  watch(task({ working: true }), task({ status: 'done', working: false, turnDoneAt: at }))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(calls.length, 1, '停用的渠道不发；第二次失败在 60 秒内被去重；做完没勾不发')
  const content = (calls[0].body.text as { content: string }).content
  assert.match(content, /项目：商城/)
  assert.match(content, /对话：修购物车/)
  assert.match(content, /http:\/\/127\.0\.0\.1:\d+\/#\/projects\/p1\/t1$/)
})
