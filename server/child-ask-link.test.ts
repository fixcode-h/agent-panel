/**
 * 父对话「提问」和「子对话也提问」的联动落库结果（规则本身见 shared/child-ask.test.ts）：
 * 父对话关掉提问时已有子对话一起关，重开后只开自己；右键菜单改的只是「之后新建」的默认值。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-child-ask-link-'))
process.env.AGENT_PANEL_DATA = dir

const { tasksApi } = await import('./tasks.ts')
const { createTaskStore } = await import('./task-store.ts')
const { newTask } = await import('../shared/task.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()

const make = async (id: string, over: Record<string, unknown> = {}) =>
  store.create({ ...newTask({ projectId: '', mode: 'chat', prompt: id } as never, undefined, '', id), id, ...over })

/** 读接口返回的最新状态：写盘是排队的，另开一个 store 可能读到旧快照 */
const read = async (t: ReturnType<typeof api>, id: string) =>
  (await (await t.routes.request(`/${id}`)).json()) as Awaited<ReturnType<typeof make>>

const patch = async (t: ReturnType<typeof api>, id: string, body: Record<string, unknown>) => {
  const res = await t.routes.request(`/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(res.status, 200)
  return (await res.json()) as Awaited<ReturnType<typeof make>>
}

test('父对话关掉提问：已创建的子对话一起关，「之后新建」的值不变', async () => {
  await make('pa', { askUser: true, childAskUser: true })
  await make('ca', { parentTaskId: 'pa', rootTaskId: 'pa', askUser: true })
  await make('cb', { parentTaskId: 'pa', rootTaskId: 'pa', askUser: true })
  const t = api()

  const parent = await patch(t, 'pa', { askUser: false })
  assert.equal(parent.askUser, false)
  assert.equal(parent.childAskUser, true, '重新打开父对话时菜单项还能回到勾选')
  assert.equal((await read(t, 'ca')).askUser, false, '子对话 a 的提问也关掉')
  assert.equal((await read(t, 'cb')).askUser, false, '子对话 b 的提问也关掉')
})

test('父对话重新打开提问：只开自己，之前被关掉的子对话保持关着', async () => {
  await make('pb', { askUser: true, childAskUser: true })
  await make('cc', { parentTaskId: 'pb', rootTaskId: 'pb', askUser: true })
  const t = api()
  await patch(t, 'pb', { askUser: false })
  assert.equal((await read(t, 'cc')).askUser, false)

  const parent = await patch(t, 'pb', { askUser: true })
  assert.equal(parent.askUser, true)
  assert.equal((await read(t, 'cc')).askUser, false, '不自动打开已有的子对话')
})

test('右键勾上「子对话也提问」并选应用到已创建：父对话和已有子对话一起开', async () => {
  await make('pc', { askUser: false, childAskUser: false })
  await make('cd', { parentTaskId: 'pc', rootTaskId: 'pc', askUser: false })
  const t = api()

  const parent = await patch(t, 'pc', { childAskUser: true, applyChildAsk: true })
  assert.equal(parent.childAskUser, true)
  assert.equal(parent.askUser, true, '父对话关着时勾上这一项，父对话自己也打开')
  assert.equal((await read(t, 'cd')).askUser, true)
})

test('右键勾上但只对之后新建：已有子对话不动', async () => {
  await make('pd', { askUser: true, childAskUser: false })
  await make('ce', { parentTaskId: 'pd', rootTaskId: 'pd', askUser: true })
  const t = api()

  const parent = await patch(t, 'pd', { childAskUser: true, applyChildAsk: false })
  assert.equal(parent.childAskUser, true)
  assert.equal((await read(t, 'ce')).askUser, true, '已创建的子对话保持原样')
})

test('右键取消「子对话也提问」：只改之后新建的默认值，已有子对话和父对话自己都不动', async () => {
  await make('pe', { askUser: true, childAskUser: true })
  await make('cf', { parentTaskId: 'pe', rootTaskId: 'pe', askUser: true })
  const t = api()

  const parent = await patch(t, 'pe', { childAskUser: false })
  assert.equal(parent.childAskUser, false)
  assert.equal(parent.askUser, true, '父对话自己的提问不动')
  assert.equal((await read(t, 'cf')).askUser, true, '已创建的子对话不动')
})
