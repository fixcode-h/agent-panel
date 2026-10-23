/**
 * 子对话的提问 / 收尾建议由谁回答：父对话「提问」开关关着（默认）时自动交给父对话的 AI 决定，
 * 不产生要用户回答的卡片（展开的卡片和「交给父对话决定」的折叠行都是 ask 卡片渲染的）；
 * 开着时仍然交给用户选。关掉开关时，已经挂在父对话里、还没人回答的提问也一起交给 AI。
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
/** 通过 tasksApi 自己的读接口看状态：写盘是排队的，另开一个 store 可能读到旧快照 */
const askState = async (t: ReturnType<typeof api>, id: string) =>
  (await (await t.routes.request(`/${id}`)).json()) as Awaited<ReturnType<typeof read>>
const askStateUntil = async (
  t: ReturnType<typeof api>,
  id: string,
  ok: (x: Awaited<ReturnType<typeof read>>) => boolean,
  ms = 4000,
) => {
  for (let i = 0; i < ms / 50; i++) {
    const x = await askState(t, id)
    if (ok(x)) return x
    await new Promise((r) => setTimeout(r, 50))
  }
  return askState(t, id)
}

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
  // 父对话：不产生 ask 卡片（卡片和「交给父对话决定」的折叠行都是它渲染的），只有一条给 AI 看的汇报
  const parent = await askStateUntil(t, 'p1', (x) => x.messages.some((m) => m.panel === 'child'))
  assert.equal(parent.messages.filter((m) => m.panel === 'ask').length, 0, '父对话里没有要用户回答的卡片')
  const note = parent.messages.find((m) => m.panel === 'child')!
  assert.match(note.text, /接口要不要改成 B 方案？/)
  assert.match(note.text, /用户不会回答/)
  // 问题也进了收件箱：父对话空闲时按它作答
  assert.ok(
    parent.inbox.some((x) => x.text.includes('接口要不要改成 B 方案？')),
    '问题记在父对话的收件箱里，等它作答',
  )
  // 子对话拿到的工具结果写清「按默认处理了什么、依据是什么」，它照这个继续往外跑
  assert.match(r.info, /提问已按默认处理/)
  assert.match(r.info, /保持 A/)
})

test('「提问」开着：仍然交给用户选，不自动交出', async () => {
  await make('p2', { askUser: true })
  await make('c2', { parentTaskId: 'p2', rootTaskId: 'p2' })
  const t = api()

  await t.askParent('c2', '先做前端还是后端？', ['前端', '后端'])
  const kid = await read('c2')
  assert.equal(kid.parentAsks?.length, 1, '子对话挂着等用户选的卡片')
  const ask = (await askStateUntil(t, 'p2', (x) => x.messages.some((m) => m.panel === 'ask'))).messages.find(
    (m) => m.panel === 'ask',
  )!
  assert.equal(ask.ask?.delegated, undefined, '没有自动交出')
})

test('用户点「交给父对话决定」：记成已交出，并收起子对话的弹窗', async () => {
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
  const after = await askStateUntil(
    t,
    'p3',
    (x) => x.messages.find((m) => m.id === pending.id)?.ask?.delegated === true,
  )
  assert.equal(after.messages.find((m) => m.id === pending.id)?.ask?.delegated, true, '点按钮交出也记同一个字段')
  assert.equal((await read('c3')).parentAsks?.length ?? 0, 0, '子对话的弹窗收起')
})

test('收尾建议：「提问」关着时同样自动交给父对话，不弹给用户', async () => {
  await make('p4', { askUser: false })
  await make('c4', { parentTaskId: 'p4', rootTaskId: 'p4' })
  const t = api()

  const r = await t.askParent('c4', '接着补两个模块的回归测试', ['继续补测试（推荐）', '先停在这'], 'suggestion')
  assert.equal(r.ok, true)
  assert.equal((await read('c4')).parentAsks?.length ?? 0, 0, '建议不弹给用户')
  const parent = await askStateUntil(t, 'p4', (x) => x.messages.some((m) => m.panel === 'child'), 8000)
  assert.equal(parent.messages.filter((m) => m.panel === 'ask').length, 0, '建议也不产生要用户选的卡片')
  assert.match(parent.messages.find((m) => m.panel === 'child')!.text, /接着补两个模块的回归测试/)
  assert.match(r.info, /自动交给父对话决定/)
})

test('关掉「提问」：父对话里还没回答的子对话提问一起交给 AI，子对话的弹窗收起', async () => {
  await make('p5', { askUser: true })
  await make('c5', { parentTaskId: 'p5', rootTaskId: 'p5' })
  const t = api()
  await t.askParent('c5', '要不要一起改配置？', ['改', '不改'])
  const pending = (await askStateUntil(t, 'p5', (x) => x.messages.some((m) => m.panel === 'ask'))).messages.find(
    (m) => m.panel === 'ask',
  )!
  assert.equal(pending.ask?.delegated, undefined, '开着时先正常等用户选')
  const kidBefore = await askStateUntil(t, 'c5', (x) => (x.parentAsks?.length ?? 0) === 1)
  assert.equal(kidBefore.parentAsks?.length, 1, '子对话挂着等用户选的弹窗')

  const res = await t.routes.request('/p5', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ askUser: false }),
  })
  assert.equal(res.status, 200)
  const after = await askStateUntil(
    t,
    'p5',
    (x) => x.messages.find((m) => m.id === pending.id)?.ask?.delegated === true,
  )
  assert.equal(after.messages.find((m) => m.id === pending.id)?.ask?.delegated, true, '卡片不再等用户')
  assert.ok(
    after.messages.some((m) => m.panel === 'child' && m.text.includes('要不要一起改配置？')),
    '交给父对话的 AI 作答',
  )
  const kid = await askStateUntil(t, 'c5', (x) => (x.parentAsks?.length ?? 0) === 0)
  assert.equal(kid.parentAsks?.length ?? 0, 0, '子对话的选择弹窗收起')
})
