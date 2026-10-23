/**
 * 导出 / 导入整棵树（路由级）：父对话连同它分出的子对话、孙对话一起导出，导入后
 * 是本机的只读任务、父子关系指向新分配的 id，子对话栏能直接看到它们。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 任务记录放在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-export-tree-'))
process.env.AGENT_PANEL_DATA = dir

const { tasksApi } = await import('./tasks.ts')
const { createTaskStore } = await import('./task-store.ts')
const { Agent, Task } = await import('../shared/schema.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const at = '2026-10-19T00:00:00.000Z'
const coder = Agent.parse({ id: 'a1', name: '开发', instructions: '写代码', createdAt: at, updatedAt: at })
const store = createTaskStore()
const empty = { list: async () => [], get: async () => null }
const api = () =>
  tasksApi({
    agents: { list: async () => [coder], get: async () => coder },
    workflows: empty,
    projects: empty,
    projectCategories: empty,
  } as never)

const make = (id: string, over: Record<string, unknown> = {}) =>
  store.create(
    Task.parse({
      id,
      projectId: '',
      title: id,
      mode: 'chat',
      status: 'done',
      agentId: coder.id,
      messages: [{ id: `${id}-m`, role: 'user', text: `${id} 的要求`, at }],
      steps: [{ id: `${id}-s`, title: '干活', agentId: coder.id, status: 'done', startedAt: at, endedAt: at }],
      createdAt: at,
      updatedAt: at,
      ...over,
    }),
  )

test('导出接口带出整棵树，导入接口还原成同一个只读结构', async () => {
  await make('r1')
  await make('c1', { parentTaskId: 'r1', rootTaskId: 'r1' })
  await make('g1', { parentTaskId: 'c1', rootTaskId: 'r1' })
  const t = api()

  const res = await t.routes.request('/r1/export?app=0.28.0')
  assert.equal(res.status, 200)
  const { bundle, bytes } = (await res.json()) as { bundle: Record<string, unknown>; bytes: number }
  assert.ok(bytes > 0, '给出包的体积')
  assert.equal(bundle.app as string, '0.28.0')
  assert.deepEqual(
    ((bundle.children as { id: string; parentTaskId: string }[]) ?? []).map((c) => [c.id, c.parentTaskId]),
    [
      ['c1', ''],
      ['g1', 'c1'],
    ],
    '两个子对话都在包里，孙对话靠 parentTaskId 指回子对话',
  )
  assert.equal((await t.routes.request('/nope/export')).status, 404, '任务不存在时给出 404')

  const imported = await t.routes.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: '', bundle }),
  })
  assert.equal(imported.status, 201)
  const made = (await imported.json()) as { id: string; parentTaskId: string; rootTaskId: string; imported?: unknown }[]
  assert.equal(made.length, 3, '父任务和两个子对话都建了')
  const [father, son, grandson] = made
  assert.equal(father.parentTaskId, '')
  assert.equal(son.parentTaskId, father.id)
  assert.equal(grandson.parentTaskId, son.id, '孙对话挂在子对话的新 id 下')
  assert.ok(
    made.every((x) => !!x.imported),
    '导入的任务都是只读的',
  )

  // 子对话栏能看到它们，父子结构在界面上就是对得上的（孙对话挂在子对话下，不在父对话那一层）
  const kids = (await (await t.routes.request(`/${father.id}/children`)).json()) as { id: string }[]
  assert.deepEqual(
    kids.map((x) => x.id),
    [son.id],
  )
  const grandkids = (await (await t.routes.request(`/${son.id}/children`)).json()) as { id: string }[]
  assert.deepEqual(
    grandkids.map((x) => x.id),
    [grandson.id],
  )
  // 子对话自己的消息、步骤都在
  const got = (await (await t.routes.request(`/${grandson.id}`)).json()) as {
    messages: { text: string }[]
    steps: { id: string }[]
  }
  assert.equal(got.messages[0].text, 'g1 的要求')
  assert.deepEqual(
    got.steps.map((s) => s.id),
    ['g1-s'],
  )
})
