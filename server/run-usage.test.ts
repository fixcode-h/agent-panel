import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { Task } from '../shared/schema.ts'
import { setLang } from '../shared/i18n.ts'
import { runUsageApi } from './run-usage.ts'

// 断言里是中文，不管本机是什么语言
setLang('zh')

/** 一个任务：只要用量相关的字段 */
const task = (id: string, parentTaskId: string, inputTokens: number, outputTokens: number) =>
  ({
    id,
    parentTaskId,
    steps: [],
    messages: [],
    usage: { agents: {}, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  }) as unknown as Task

const app = (all: Task[]) =>
  new Hono().route(
    '/tasks',
    runUsageApi({
      tasks: {
        peek: async (id) => all.find((x) => x.id === id) ?? null,
        get: async (id) => all.find((x) => x.id === id) ?? null,
        list: async () => all,
      },
    }).routes,
  )

test('整个运行的用量接口：父对话带上多层子对话', async () => {
  const all = [task('p1', '', 100, 10), task('c1', 'p1', 40, 4), task('c2', 'c1', 5, 1), task('other', '', 900, 90)]
  const res = await app(all).request('/tasks/p1/run-usage')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { total: { inputTokens: number }; own: { inputTokens: number }; children: number }
  assert.equal(body.total.inputTokens, 145)
  assert.equal(body.own.inputTokens, 100)
  assert.equal(body.children, 2)
  // 传子对话的 id 也能算（它自己就是那棵子树的根）
  const kid = (await (await app(all).request('/tasks/c1/run-usage')).json()) as { total: { inputTokens: number } }
  assert.equal(kid.total.inputTokens, 45)
})

test('整个运行的用量接口：任务不存在时报错，不是空数字', async () => {
  const res = await app([]).request('/tasks/none/run-usage')
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: '任务不存在' })
})

test('子对话统计接口：耗时、token、报错都按整棵子树汇总', async () => {
  const err = { id: 'm1', role: 'system', step: '', text: '执行出错', error: true, at: '', tools: [] }
  const all = [
    task('p1', '', 100, 10),
    { ...task('c1', 'p1', 40, 4), runMs: 60_000, messages: [err] } as unknown as Task,
    task('c2', 'c1', 5, 1),
    task('other', '', 900, 90),
  ]
  const res = await app(all).request('/tasks/p1/children-stats')
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    tasks: number
    durationMs: number
    inputTokens: number
    outputTokens: number
    errors: number
    cacheHitRate: number
  }
  assert.equal(body.tasks, 2, '含多层子对话，不含父对话自己')
  assert.equal(body.durationMs, 60_000)
  assert.equal(body.inputTokens, 45)
  assert.equal(body.outputTokens, 5)
  assert.equal(body.errors, 1)
  assert.equal(body.cacheHitRate, 0)
  // 没有子对话时是 0，不是一个空对象或 null
  const none = (await (await app(all).request('/tasks/other/children-stats')).json()) as { tasks: number }
  assert.equal(none.tasks, 0)
  const missing = await app(all).request('/tasks/none/children-stats')
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { error: '任务不存在' })
})
