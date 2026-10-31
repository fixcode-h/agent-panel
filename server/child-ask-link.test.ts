/**
 * 父对话「提问」和「子对话也提问」的联动落库结果（规则本身见 shared/child-ask.test.ts）：
 * 提问按钮只影响父对话自己（已有子对话不跟着开关）；右键菜单改的只是「之后新建」的默认值，用户选了才动已有的。
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

test('父对话开关提问：只改自己，已创建的子对话保持各自的选择', async () => {
  await make('pa', { askUser: true, childAskUser: true })
  await make('ca', { parentTaskId: 'pa', rootTaskId: 'pa', askUser: true })
  await make('cb', { parentTaskId: 'pa', rootTaskId: 'pa', askUser: false })
  const t = api()

  const parent = await patch(t, 'pa', { askUser: false })
  assert.equal(parent.askUser, false)
  assert.equal(parent.childAskUser, true, '「之后新建」的值不变')
  assert.equal((await read(t, 'ca')).askUser, true, '子对话 a 照旧开着')
  assert.equal((await read(t, 'cb')).askUser, false, '子对话 b 照旧关着')
  await patch(t, 'pa', { askUser: true })
  assert.equal((await read(t, 'cb')).askUser, false, '重新打开父对话也不动子对话')
})

test('右键勾上「子对话也提问」并选应用到已创建：已有子对话一起开，父对话自己不动', async () => {
  await make('pc', { askUser: false, childAskUser: false })
  await make('cd', { parentTaskId: 'pc', rootTaskId: 'pc', askUser: false })
  const t = api()

  const parent = await patch(t, 'pc', { childAskUser: true, applyChildAsk: true })
  assert.equal(parent.childAskUser, true)
  assert.equal(parent.askUser, false, '父对话自己的提问不跟着变')
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
