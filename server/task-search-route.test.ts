/**
 * `GET /tasks/search`：搜对话正文，只回片段 + 对话 id + 消息 id，不回整份消息；
 * 已删除（回收站里）的对话不参与；结果有上限、按最近活动排序。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-search-'))
process.env.AGENT_PANEL_DATA = dir
process.env.AGENT_PANEL_PRESENCE_GRACE_MS = '500'

const { createTaskStore } = await import('./task-store.ts')
const { tasksApi } = await import('./tasks.ts')
const { newTask } = await import('../shared/task.ts')
const { TaskMessage } = await import('../shared/schema.ts')
const { setLang } = await import('../shared/i18n.ts')
const { SEARCH_HIT_LIMIT, SEARCH_HITS_PER_TASK } = await import('../shared/task-search.ts')

setLang('zh')

const empty = { list: async () => [], get: async () => null }
const api = () => tasksApi({ agents: empty, workflows: empty, projects: empty, projectCategories: empty } as never)
const store = createTaskStore()
const at = '2026-10-01T02:00:00.000Z'

const msg = (id: string, role: 'user' | 'agent', text: string) =>
  TaskMessage.parse({ id, role, agentId: '', step: '', text, tools: [], at })

const make = async (id: string, title: string, messages: { id: string; role: 'user' | 'agent'; text: string }[]) =>
  store.create({
    ...newTask({ projectId: '', mode: 'chat', prompt: title } as never, undefined, '', id),
    id,
    status: 'done',
    title,
    messages: messages.map((m) => msg(m.id, m.role, m.text)),
  })

const search = async (t: ReturnType<typeof api>, q: string, limit?: number) => {
  const res = await t.routes.request(`/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`)
  assert.equal(res.status, 200)
  return (await res.json()) as {
    hits: { taskId: string; title: string; messageId: string; count: number; snippet: string; index: number }[]
    scanned: number
    more: boolean
  }
}

test('命中正文里的词：回片段、消息 id 和命中次数，不回整条消息', async () => {
  await make('search-a', '聊天记录', [
    { id: 'sa-u1', role: 'user', text: '帮我把对话删掉' },
    { id: 'sa-a1', role: 'agent', text: '删掉之后进了回收站，7 天内还能恢复，回收站里能看到它。' },
  ])
  await make('search-b', '别的', [{ id: 'sb-u1', role: 'user', text: '和搜索无关的一句话' }])
  const { hits } = await search(api(), '回收站')

  const hit = hits.find((x) => x.taskId === 'search-a')
  assert.ok(hit, '命中了正文里有这个词的对话')
  assert.equal(hit.messageId, 'sa-a1', '定位到那条消息')
  assert.equal(hit.count, 2, '这条消息里出现了两次')
  assert.ok(hit.snippet.includes('回收站'), '片段里带着命中词')
  assert.equal(hit.snippet.slice(hit.index, hit.index + 3), '回收站', 'index 指向片段里的命中词')
  assert.ok(!hits.some((x) => x.taskId === 'search-b'), '无关的对话不出现')
  assert.ok(!('text' in hit), '不回整条消息')
})

test('标题命中不在这里算：接口只搜正文', async () => {
  await make('search-title', '回收站怎么用', [{ id: 'st-u1', role: 'user', text: '随便聊聊别的' }])
  const { hits } = await search(api(), '回收站')
  assert.ok(!hits.some((x) => x.taskId === 'search-title'), '标题里有时正文没有，不算内容命中')
})

test('进了回收站的对话不会被搜出来', async () => {
  await make('search-deleted', '被删的', [{ id: 'sd-u1', role: 'user', text: '这句只在被删的对话里出现' }])
  const t = api()
  assert.ok((await search(t, '这句只在被删的对话里出现')).hits.length === 1)
  await t.routes.request('/search-deleted', { method: 'DELETE' })
  const { hits } = await search(t, '这句只在被删的对话里出现')
  assert.equal(hits.length, 0, '删除后搜不到了')
  // 恢复以后又能搜到
  await t.routes.request('/search-deleted/restore', { method: 'POST' })
  assert.ok((await search(t, '这句只在被删的对话里出现')).hits.length === 1, '恢复后重新可搜')
})

test('同一个对话最多回几条命中，limit 生效', async () => {
  const many = Array.from({ length: SEARCH_HITS_PER_TASK + 4 }, (_, i) => ({
    id: `sm-u${i}`,
    role: 'agent' as const,
    text: `第 ${i} 条都提到了回收站`,
  }))
  await make('search-many', '很多条', many)
  const all = await search(api(), '回收站')
  assert.equal(
    all.hits.filter((x) => x.taskId === 'search-many').length,
    SEARCH_HITS_PER_TASK,
    '一个对话最多占这么几条',
  )
  const one = await search(api(), '回收站', 1)
  assert.equal(one.hits.length, 1, 'limit 生效')
  assert.equal(one.more, true, '还有没返回的命中')
})

test('空搜索词直接回空，不去扫对话文件', async () => {
  const { hits, scanned } = await search(api(), '   ')
  assert.deepEqual(hits, [])
  assert.equal(scanned, 0)
})

test('结果上限不超过 SEARCH_HIT_LIMIT', async () => {
  for (let i = 0; i < 3; i++)
    await make(`search-cap-${i}`, `上限 ${i}`, [{ id: `sc-u${i}`, role: 'user', text: '上限测试里的回收站' }])
  const { hits } = await search(api(), '回收站', 999)
  assert.ok(hits.length <= SEARCH_HIT_LIMIT)
})
