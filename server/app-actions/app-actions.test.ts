import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { appActions, runAppAction, setActionHost } from './index.ts'
import { callApi, catalogText, createRegistry, defineAction, type ActionCaller } from './registry.ts'
import { mergePatch } from './settings.ts'
import { askMcpApi, openAskBridge } from '../ask-mcp.ts'

/** 假宿主：记下调了哪些接口、推了哪些界面操作；pages 是开着几个页面 */
function fakeHost(answers: Record<string, unknown> = {}, pages = 1) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const ui: { action: string; args: Record<string, unknown> }[] = []
  setActionHost({
    api: async (method, path, body) => {
      calls.push({ method, path, body })
      const key = Object.keys(answers).find((k) => `${method} ${path}`.startsWith(k))
      return key ? answers[key] : { ok: true }
    },
    ui: (action, args) => {
      ui.push({ action, args })
      return pages
    },
  })
  return { calls, ui }
}

const child: ActionCaller = { taskId: 'kid', projectId: 'p1', parentTaskId: 'dad' }

test('动作名要写成 <组>.<动词>，重名直接报错', () => {
  const a = defineAction({
    name: 'x.do',
    title: '',
    description: '',
    level: 'read',
    input: z.object({}),
    run: async () => 1,
  })
  assert.throws(() => createRegistry([a, a]), /重名/)
  assert.throws(() => createRegistry([{ ...a, name: 'nogroup' }]), /<组>\.<动词>/)
})

test('目录从 zod 生成参数说明：可选的带问号，带上说明', () => {
  const text = catalogText(appActions.list('task').filter((a) => a.name === 'task.stop_children'))
  assert.match(text, /task\.stop_children \[danger\]/)
  assert.match(text, /id\?: string — 对话 id/)
})

test('参数不对、没有这个动作时返回原因，不抛出', async () => {
  fakeHost()
  const r = await runAppAction('task.send', { id: 'a' }, child)
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /参数不对/)
  const r2 = await runAppAction('task.nope', {}, child)
  assert.match((r2 as { error: string }).error, /没有这个动作.*task\.stop_children/)
})

test('用户命令：停子对话、子任务、后台命令不写 id 时就是调用者自己的', async () => {
  const { calls } = fakeHost()
  for (const name of ['task.stop_children', 'task.stop_subtasks', 'task.stop_background'])
    assert.equal((await runAppAction(name, {}, child)).ok, true)
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['POST /tasks/kid/children/stop', 'POST /tasks/kid/subtasks/stop', 'POST /tasks/kid/background/stop'],
  )
  assert.deepEqual(calls[1].body, { all: true })
})

test('没有对话上下文（HTTP 入口）时要写 id', async () => {
  fakeHost()
  const r = await runAppAction('task.stop_children', {})
  assert.match((r as { error: string }).error, /要写 id/)
})

test('不能停、不能删自己和父对话，别的对话照常执行', async () => {
  const { calls } = fakeHost()
  for (const [name, id] of [
    ['task.delete', 'kid'],
    ['task.delete', 'dad'],
    ['task.stop', 'kid'],
  ]) {
    const r = await runAppAction(name, { id }, child)
    assert.equal(r.ok, false, `${name} ${id}`)
  }
  assert.equal(calls.length, 0)
  assert.equal((await runAppAction('task.delete', { id: 'other' }, child)).ok, true)
  assert.deepEqual(calls[0], { method: 'DELETE', path: '/tasks/other', body: undefined })
})

test('不能给自己发消息', async () => {
  fakeHost()
  const r = await runAppAction('task.send', { id: 'kid', text: 'hi' }, child)
  assert.equal(r.ok, false)
})

test('改设置：密钥和访问控制不能改；对象逐层合并；改完让页面刷新', async () => {
  const cur = { childConcurrency: 5, apis: [], appearance: { theme: 'dark', fontSize: 14 } }
  const { calls, ui } = fakeHost({ 'GET /settings': cur, 'PUT /settings': { ...cur, childConcurrency: 3 } })
  const denied = await runAppAction('settings.set', { patch: { apis: [] } }, child)
  assert.match((denied as { error: string }).error, /不能由 AI 改：apis/)
  const unknown = await runAppAction('settings.set', { patch: { nope: 1 } }, child)
  assert.match((unknown as { error: string }).error, /没有这些设置/)
  const r = await runAppAction(
    'settings.set',
    { patch: { childConcurrency: 3, appearance: { theme: 'light' } } },
    child,
  )
  assert.deepEqual(r.ok && r.result, { childConcurrency: 3, appearance: { theme: 'dark', fontSize: 14 } })
  const put = calls.find((c) => c.method === 'PUT')!
  assert.deepEqual(put.body, { childConcurrency: 3, apis: [], appearance: { theme: 'light', fontSize: 14 } })
  assert.deepEqual(ui, [{ action: 'reload_settings', args: {} }])
  assert.deepEqual(mergePatch({ a: [1, 2] }, { a: [3] }), { a: [3] })
})

test('读设置不带密钥类字段', async () => {
  fakeHost({ 'GET /settings': { childConcurrency: 5, apis: [{ apiKey: 'sk-xxxx' }], clis: {}, requireToken: true } })
  const r = await runAppAction('settings.get', {}, child)
  assert.deepEqual(r.ok && r.result, { childConcurrency: 5 })
})

test('界面操作：推给页面；没有页面开着时说清楚', async () => {
  const { ui } = fakeHost()
  assert.equal((await runAppAction('ui.open_settings', { section: 'models' }, child)).ok, true)
  assert.deepEqual(ui[0], { action: 'open_settings', args: { section: 'models' } })
  fakeHost({}, 0)
  const r = await runAppAction('ui.navigate', { page: 'design' }, child)
  assert.match((r as { error: string }).error, /面板页面没有打开/)
})

test('建 UI 设计并让 AI 生成背包页面：新建、打开设计页、发要求', async () => {
  const { calls, ui } = fakeHost({ 'POST /designs': { id: 'd1', title: '背包' } })
  const made = await runAppAction('design.create', { projectId: 'dp', title: '背包' }, child)
  assert.deepEqual(made.ok && made.result, { id: 'd1', title: '背包', opened: true })
  assert.deepEqual(ui[0], { action: 'navigate', args: { page: 'design', id: 'd1' } })
  assert.equal((await runAppAction('design.chat', { id: 'd1', text: '生成一个背包页面' }, child)).ok, true)
  assert.deepEqual(calls.at(-1), {
    method: 'POST',
    path: '/designs/d1/chat',
    body: { text: '生成一个背包页面', source: { kind: 'cli' } },
  })
})

test('初始化项目：找到项目后打开项目设置并开始 AI 初始化', async () => {
  const { ui } = fakeHost({ 'GET /projects': [{ id: 'p1', name: '游戏' }] })
  const r = await runAppAction('project.init', {}, child)
  assert.equal(r.ok, true)
  assert.deepEqual(ui[0], { action: 'open_project', args: { id: 'p1', section: 'init', item: 'start' } })
  const missing = await runAppAction('project.init', { id: 'p9' }, child)
  assert.match((missing as { error: string }).error, /项目不存在/)
})

test('进程内调接口：非 2xx 把接口给的原因交出来', async () => {
  const app = new Hono()
    .basePath('/api')
    .get('/ok', (c) => c.json({ x: c.req.header('host') }))
    .post('/bad', (c) => c.json({ error: '任务不存在' }, 404))
  const fetcher = (req: Request) => app.fetch(req)
  assert.deepEqual(await callApi(fetcher, 'GET', '/ok'), { x: `127.0.0.1:${process.env.PORT ?? 8787}` })
  await assert.rejects(callApi(fetcher, 'POST', '/bad', {}), /任务不存在/)
})

/** 直接调面板的 MCP 接口 */
async function rpc(url: string, msg: unknown) {
  const token = new URL(url).pathname.split('/').pop()!
  const res = await askMcpApi().request(`/ask/${token}`, {
    method: 'POST',
    body: JSON.stringify(msg),
    headers: { 'content-type': 'application/json' },
  })
  return res.json()
}

test('MCP：对话的调用多两个工具，app_do 以调用者身份执行；没给 app 时没有这两个工具', async () => {
  const { calls } = fakeHost()
  const s = openAskBridge({ app: child })
  const list = await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ['app_actions', 'app_do'],
  )
  const cat = await rpc(s.url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'app_actions', arguments: { group: 'task' } },
  })
  assert.match(cat.result.content[0].text, /task\.stop_background/)
  const done = await rpc(s.url, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'app_do', arguments: { action: 'task.stop_children' } },
  })
  assert.equal(done.result.isError, undefined)
  assert.equal(calls[0].path, '/tasks/kid/children/stop')
  const bad = await rpc(s.url, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'app_do', arguments: { action: 'task.delete', args: { id: 'kid' } } },
  })
  assert.equal(bad.result.isError, true)
  s.close()
  const plain = openAskBridge({ notes: () => [] })
  const l2 = await rpc(plain.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.ok(!l2.result.tools.some((t: { name: string }) => t.name.startsWith('app_')))
  plain.close()
})
