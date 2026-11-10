/**
 * 正式后端的接口契约（A9）：任务列表、任务详情、子对话、发消息的返回形状，
 * 和演示后端（web/src/lib/demo-contract.test.ts）用 shared/task-api-contract.ts 的同一份 schema 校验。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-contract-'))
process.env.AGENT_PANEL_DATA = dir

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask } = await import('../shared/task.ts')
const { setLang } = await import('../shared/i18n.ts')
const contract = await import('../shared/task-api-contract.ts')

setLang('zh')

const store = createTaskStore()
const make = (id: string, extra: Record<string, unknown> = {}) => ({
  ...newTask({ projectId: 'p1', mode: 'chat', prompt: id, ...extra } as never, undefined, '', id),
  id,
  status: 'done' as const,
  title: id,
})
await store.create(make('contract-parent'))
await store.create(make('contract-child', { parentTaskId: 'contract-parent' }))

// 任务都建好之后再起接口：它第一次读列表后会留在内存里
const empty = { list: async () => [], get: async () => null }
const app = tasksApi({
  agents: empty,
  workflows: empty,
  projects: {
    list: async () => [],
    get: async (id: string) => (id === 'p1' ? { id: 'p1', name: '项目', path: dir } : null),
  },
  projectCategories: empty,
  // 子对话没有独立分支，用不到 git；给个假的，免得测试碰真的 git
  worktreeStatus: async () => ({ exists: false, branch: false, ahead: 0, dirty: 0, merged: true }),
} as never)

const check = (
  schema: { safeParse: (x: unknown) => { success: boolean; error?: unknown } },
  x: unknown,
  what: string,
) => {
  const r = schema.safeParse(x)
  assert.ok(r.success, `${what}的返回形状和契约对不上：${JSON.stringify(r.error, null, 1)?.slice(0, 1500)}`)
}

const get = async (url: string) => {
  const res = await app.routes.request(url)
  assert.equal(res.status, 200, url)
  return res.json()
}

test('正式后端的任务列表、详情、子对话、发消息：返回形状和演示后端同一份契约', async () => {
  const list = await get('/?projectId=p1')
  check(contract.TaskListContract, list, '任务列表')
  assert.deepEqual(
    (list as { id: string }[]).map((t) => t.id),
    ['contract-parent'],
    '子对话不进项目列表',
  )
  check(contract.TaskPageContract, await get('/contract-parent?limit=40'), '任务详情')
  const kids = await get('/contract-parent/children')
  check(contract.ChildListContract, kids, '子对话列表')
  assert.equal((kids as unknown[]).length, 1)

  // 发普通消息会真的拉起 CLI 跑一轮（那一段由 e2e 03-chat 兜着）；这里发面板自己处理的 /rule，
  // 走的是同一个接口、同一种返回（整份任务），不起 CLI
  const res = await app.routes.request('/contract-parent/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '/rule 契约测试的规则' }),
  })
  assert.equal(res.status, 200)
  const sent = await res.json()
  check(contract.SendMessageContract, sent, '发消息')
  assert.ok((sent as { messages: { text: string }[] }).messages.some((m) => m.text.includes('契约测试的规则')))
})
