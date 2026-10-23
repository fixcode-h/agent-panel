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
    usage: { agents: {}, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  }) as unknown as Task

const app = (all: Task[]) =>
  new Hono().route(
    '/tasks',
    runUsageApi({
      tasks: {
        getMeta: async (id: string) => all.find((x) => x.id === id) ?? null,
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

test('整个运行的用量接口：只取任务本身，不读完整对话', async () => {
  const all = [task('p1', '', 100, 10), task('c1', 'p1', 40, 4), task('c2', 'c1', 5, 1)]
  const asked: string[] = []
  // 完整读取（带全部对话）一旦发生就是这个接口的退化：它每秒跑一次，会把整棵树的消息读进内存
  const deps = {
    getMeta: async (id: string) => {
      asked.push(id)
      return all.find((x) => x.id === id) ?? null
    },
    list: async () => all,
    get: async (id: string): Promise<Task | null> => {
      throw new Error(`不该读完整对话：${id}`)
    },
  }
  const res = await new Hono().route('/tasks', runUsageApi({ tasks: deps }).routes).request('/tasks/p1/run-usage')
  assert.equal(res.status, 200)
  // 根任务和每层子对话都只要元数据，一次完整读取都没有
  assert.deepEqual(asked, ['p1', 'c1', 'c2'])
})

test('整个运行的用量接口：子树里混入别的父任务或已被删掉的任务时跳过，不报错', async () => {
  const all = [task('p1', '', 100, 10), task('c1', 'p1', 40, 4), task('other', '', 900, 90)]
  const deps = {
    getMeta: async (id: string) => (id === 'c1' ? null : (all.find((x) => x.id === id) ?? null)),
    list: async () => all,
  }
  const res = await new Hono().route('/tasks', runUsageApi({ tasks: deps }).routes).request('/tasks/p1/run-usage')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { total: { inputTokens: number }; children: number }
  // c1 在树里但取不到：它和它的子树都不算进结果，也不影响接口
  assert.equal(body.total.inputTokens, 100)
  assert.equal(body.children, 0)
})
