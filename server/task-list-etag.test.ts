/**
 * `GET /tasks` 的 ETag：前端每 2.5 秒拉一次列表，数据没变时回 304（省传输、侧栏不重渲染），
 * 有任何变化都要给出新的 ETag，不能让界面拿着旧数据。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-etag-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask } = await import('../shared/task.ts')
const { setLang } = await import('../shared/i18n.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()
const at = '2026-10-01T02:00:00.000Z'

const make = async (id: string, title: string) =>
  store.create({
    ...newTask({ projectId: '', mode: 'chat', prompt: title } as never, undefined, at, id),
    id,
    status: 'done',
    title,
  })

const list = async (etag?: string) => {
  const res = await api().routes.request('/', { headers: etag ? { 'If-None-Match': etag } : {} })
  return { status: res.status, etag: res.headers.get('ETag') ?? '', text: await res.text() }
}

await make('etag-a', '第一条对话')

test('列表带上 ETag；同一条数据再拉一次回 304，不再传响应体', async () => {
  const first = await list()
  assert.equal(first.status, 200)
  assert.ok(first.etag, '响应带 ETag')
  assert.ok(first.text.includes('第一条对话'))

  const again = await list(first.etag)
  assert.equal(again.status, 304)
  assert.equal(again.text, '', '304 不带响应体')
})

test('数据变了（新增 / 改名 / 状态变化）ETag 就变，不会让界面拿着旧列表', async () => {
  const base = (await list()).etag

  await make('etag-b', '第二条对话')
  const added = await list(base)
  assert.equal(added.status, 200, '新任务出现时必须重新传列表')
  assert.notEqual(added.etag, base)

  const task = await store.get('etag-a')
  assert.ok(task)
  await store.update('etag-a', { ...task, title: '改过名的对话' })
  const renamed = await list(added.etag)
  assert.equal(renamed.status, 200)
  assert.ok(renamed.text.includes('改过名的对话'))
  assert.notEqual(renamed.etag, added.etag)
})
