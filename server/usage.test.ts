import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { Task, TaskTurn } from '../shared/schema.ts'
import { usageApi } from './usage.ts'

/** 一轮执行：时间按「多少毫秒之前」给，测试不依赖具体日期 */
const turn = (agoMs: number, inputTokens: number, outputTokens: number) =>
  ({
    id: String(agoMs),
    title: '',
    agentId: '',
    status: 'done',
    startedAt: new Date(Date.now() - agoMs).toISOString(),
    endedAt: '',
    from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    waitMs: 0,
  }) as TaskTurn

const taskWith = (id: string, turns: TaskTurn[]) =>
  ({
    id,
    turns,
    usage: { agents: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  }) as Task

const app = (tasks: Task[]) => {
  const hono = new Hono()
  hono.route('/usage', usageApi({ tasks: { list: async () => tasks } }).routes)
  return hono
}

test('GET /usage：按粒度和桶数返回报表，合计就是各桶之和', async () => {
  const tasks = [taskWith('a', [turn(60_000, 100, 20), turn(120_000, 50, 5)])]
  const res = await app(tasks).request('/usage?grain=week&count=3')
  assert.equal(res.status, 200)
  // 服务端只带 Node 类型，Response.json() 是 unknown（DOM 里是 any）；测试按接口约定直接读字段，放宽成 any
  const report: any = await res.json()
  assert.equal(report.grain, 'week')
  assert.equal(report.buckets.length, 3)
  assert.equal(report.total.inputTokens, 150)
  assert.equal(report.total.outputTokens, 25)
  assert.equal(report.total.turns, 2)
  assert.equal(report.total.tasks, 1)
  const sumOf = (pick: 'inputTokens' | 'turns') => report.buckets.reduce((n: number, b: never) => n + b[pick], 0)
  assert.equal(report.total.inputTokens, sumOf('inputTokens'))
  assert.equal(report.total.turns, sumOf('turns'))
})

test('GET /usage：没有任务时返回全是 0 的空报表', async () => {
  const res = await app([]).request('/usage?grain=month&count=2')
  const report: any = await res.json()
  assert.equal(report.grain, 'month')
  assert.equal(report.total.turns, 0)
  assert.equal(report.buckets.length, 2)
})

test('GET /usage：认不出来的粒度和桶数用默认值', async () => {
  const report: any = await (await app([]).request('/usage?grain=year&count=abc')).json()
  assert.equal(report.grain, 'day')
  assert.equal(report.buckets.length, 14)
})
