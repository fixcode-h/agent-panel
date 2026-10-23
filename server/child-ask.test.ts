/**
 * 子对话的提问 / 收尾建议由谁回答：父对话「提问」开关关着（默认）时自动按「交给父对话决定」处理，
 * 不产生要用户回答的卡片和计数；开着时仍然交给用户选。两条路走同一个 ask.delegated。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-child-ask-'))
process.env.AGENT_PANEL_DATA = dir

const { tasksApi } = await import('./tasks.ts')
const { createTaskStore } = await import('./task-store.ts')
const { newTask } = await import('../shared/task.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()
/** 读落盘后的最新状态：tasksApi 那边写盘，测试这边的 store 有自己的缓存 */
const read = async (id: string) => (await createTaskStore().get(id))!

const make = async (id: string, over: Record<string, unknown> = {}) =>
  store.create({ ...newTask({ projectId: '', mode: 'chat', prompt: id } as never, undefined, '', id), id, ...over })

test('「提问」关着：子对话提问自动交给父对话决定，不产生要用户回答的卡片', async () => {
  await make('p1', { askUser: false })
  await make('c1', { parentTaskId: 'p1', rootTaskId: 'p1' })
  // tasksApi 启动时一次性加载任务列表，测试里先建任务再起服务
  const t = api()

  const r = await t.askParent('c1', '接口要不要改成 B 方案？', ['保持 A', '改成 B'])
  assert.equal(r.ok, true)
  // 子对话：没有挂着等用户选的弹窗（界面上就是卡片和「需要你处理」的计数）
  assert.equal((await read('c1')).parentAsks?.length ?? 0, 0, '子对话上没有等用户选的弹窗')
  // 父对话：卡片记成已交出（和用户点「交给父对话决定」同一个字段），问题也进了收件箱
  const parent = await read('p1')
  const ask = parent.messages.find((m) => m.panel === 'ask')!
  assert.equal(ask.ask?.delegated, true)
  assert.equal(ask.ask?.question, '接口要不要改成 B 方案？')
  assert.equal(ask.ask?.kind, 'question')
  assert.ok(
    parent.messages.some((m) => m.panel === 'ask' && m.ask?.question === '接口要不要改成 B 方案？'),
    '问题记在父对话里，等它作答',
  )
  // 提示词交代了谁答：父对话自己选最合理的做法，写清依据
  assert.match(r.info, /自动交给父对话/)
})

test('「提问」开着：仍然交给用户选，不自动交出', async () => {
  await make('p2', { askUser: true })
  await make('c2', { parentTaskId: 'p2', rootTaskId: 'p2' })
  const t = api()

  await t.askParent('c2', '先做前端还是后端？', ['前端', '后端'])
  const kid = await read('c2')
  assert.equal(kid.parentAsks?.length, 1, '子对话挂着等用户选的卡片')
  const ask = (await read('p2')).messages.find((m) => m.panel === 'ask')!
  assert.equal(ask.ask?.delegated, undefined, '没有自动交出')
})

test('用户点「交给父对话决定」和自动交出，落到同样的状态', async () => {
  await make('p3', { askUser: true })
  await make('c3', { parentTaskId: 'p3', rootTaskId: 'p3' })
  const t = api()
  await t.askParent('c3', '要不要顺手重构？', ['重构', '不动'])
  const pending = (await read('p3')).messages.find((m) => m.panel === 'ask')!

  const res = await t.routes.request(`/p3/child-asks/${pending.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delegate: true }),
  })
  assert.equal(res.status, 200)
  const after = (await read('p3')).messages.find((m) => m.id === pending.id)!
  assert.equal(after.ask?.delegated, true, '点按钮交出也记同一个字段')
  assert.equal((await read('c3')).parentAsks?.length ?? 0, 0, '子对话的弹窗收起')
})

test('收尾建议：「提问」关着时同样自动交给父对话，不弹给用户', async () => {
  await make('p4', { askUser: false })
  await make('c4', { parentTaskId: 'p4', rootTaskId: 'p4' })
  const t = api()

  const r = await t.askParent('c4', '接着补两个模块的回归测试', ['继续补测试（推荐）', '先停在这'], 'suggestion')
  assert.equal(r.ok, true)
  assert.equal((await read('c4')).parentAsks?.length ?? 0, 0, '建议不弹给用户')
  const ask = (await read('p4')).messages.find((m) => m.panel === 'ask')!
  assert.equal(ask.ask?.delegated, true)
  assert.equal(ask.ask?.kind, 'suggestion')
})
