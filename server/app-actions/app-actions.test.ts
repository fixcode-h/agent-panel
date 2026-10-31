import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { appActions, runAppAction, setActionHost } from './index.ts'
import { callApi, catalogText, createRegistry, defineAction, type ActionCaller } from './registry.ts'
import { mergePatch, VISIBLE_SETTINGS } from './settings.ts'
import { Settings } from '../../shared/schema.ts'
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
  const cur = { backgroundLimit: 5, apis: [], appearance: { theme: 'dark', fontSize: 14 } }
  const { calls, ui } = fakeHost({ 'GET /settings': cur, 'PUT /settings': { ...cur, backgroundLimit: 3 } })
  const denied = await runAppAction('settings.set', { patch: { apis: [] } }, child)
  assert.match((denied as { error: string }).error, /不能由 AI 改：apis/)
  const unknown = await runAppAction('settings.set', { patch: { nope: 1 } }, child)
  assert.match((unknown as { error: string }).error, /没有这些设置/)
  const r = await runAppAction('settings.set', { patch: { backgroundLimit: 3, appearance: { theme: 'light' } } }, child)
  assert.deepEqual(r.ok && r.result, { backgroundLimit: 3, appearance: { theme: 'dark', fontSize: 14 } })
  const put = calls.find((c) => c.method === 'PUT')!
  assert.deepEqual(put.body, { backgroundLimit: 3, apis: [], appearance: { theme: 'light', fontSize: 14 } })
  assert.deepEqual(ui, [{ action: 'reload_settings', args: {} }])
  assert.deepEqual(mergePatch({ a: [1, 2] }, { a: [3] }), { a: [3] })
})

test('读设置不带密钥类字段', async () => {
  fakeHost({ 'GET /settings': { backgroundLimit: 5, apis: [{ apiKey: 'sk-xxxx' }], clis: {}, requireToken: true } })
  const r = await runAppAction('settings.get', {}, child)
  assert.deepEqual(r.ok && r.result, { backgroundLimit: 5 })
})

test('设置是白名单：新加的字段、密钥、可执行路径、网络地址默认 AI 看不到也改不了', async () => {
  const cur = Settings.parse({})
  fakeHost({ 'GET /settings': cur, 'PUT /settings': cur })
  const seen = (await runAppAction('settings.get', {}, child)) as { ok: true; result: Record<string, unknown> }
  for (const k of ['webSearch', 'blender', 'shell', 'proxy', 'webhook', 'imageGen', 'apis', 'clis', 'remoteAccess'])
    assert.ok(!(k in seen.result), `${k} 不该给 AI 看`)
  for (const patch of [{ blender: { path: '/tmp/x' } }, { webSearch: { key: 'k' } }, { proxy: 'http://evil' }]) {
    const r = await runAppAction('settings.set', { patch }, child)
    assert.match((r as { error: string }).error, /不能由 AI 改/)
  }
  // 白名单里的每一项都是真实存在的设置字段（字段改名时这里会提醒同步）
  for (const k of VISIBLE_SETTINGS) assert.ok(k in cur, `${k} 不是设置字段`)
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
  // 服务端只带 Node 类型，Response.json() 是 unknown（DOM 里是 any）；测试按接口约定直接读字段，放宽成 any
  return res.json() as Promise<any>
}

test('MCP：对话的调用多两个工具（收在 more_tools 里，按名字也能直接调），app_do 以调用者身份执行；没给 app 时没有这两个工具', async () => {
  const { calls } = fakeHost()
  const s = openAskBridge({ app: child })
  const list = await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  // 两个都不常用：收进 more_tools，说明里点名；只写 name 是看用法，带 arguments 才执行
  assert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ['more_tools'],
  )
  assert.match(list.result.tools[0].description, /app_actions.*app_do/)
  const usage = await rpc(s.url, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'more_tools', arguments: { name: 'app_do' } },
  })
  assert.match(usage.result.content[0].text, /参数（JSON Schema）/)
  const cat = await rpc(s.url, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'more_tools', arguments: { name: 'app_actions', arguments: { group: 'task' } } },
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
