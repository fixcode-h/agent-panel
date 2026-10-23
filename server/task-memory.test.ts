import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { Task, TaskProcess, TaskProcesses } from '../shared/schema.ts'
import { setLang } from '../shared/i18n.ts'
import { StoredSample } from './exec/proc-stats.ts'
import { taskMemoryApi } from './task-memory.ts'

// 断言里是中文，不管本机是什么语言
setLang('zh')

const MB = 1024 * 1024
const T0 = Date.parse('2025-01-01T10:00:00.000Z')

/** 一个任务：只要分析接口用到的字段 */
const task = (id: string, parentTaskId: string, extra: Partial<Task> = {}) =>
  ({
    id,
    parentTaskId,
    title: `对话 ${id}`,
    mode: 'chat',
    status: 'running',
    projectId: 'p1',
    rootTaskId: parentTaskId ? 'p1' : '',
    steps: [],
    messages: [],
    usage: { agents: {} },
    ...extra,
  }) as unknown as Task

const proc = (pid: number, ownerTaskId: string, rss: number | null, extra: Partial<TaskProcess> = {}) =>
  ({
    pid,
    parentPid: null,
    command: `cmd ${pid}`,
    ownerTaskId,
    ownerTitle: ownerTaskId,
    startedAt: T0,
    durationMs: 60_000,
    rss,
    status: 'running',
    kind: 'cli',
    ...extra,
  }) satisfies TaskProcess

const panel = (processes: TaskProcess[]): TaskProcesses => ({
  sampledAt: T0,
  processes,
  cliMemory: processes.reduce((n, p) => n + (p.rss ?? 0), 0),
  serverMemory: 200 * MB,
  totalMemory: 200 * MB + processes.reduce((n, p) => n + (p.rss ?? 0), 0),
  unavailable: '',
})

/** 两小时、30 秒一点的历史：p1 这一路从 100 MB 涨到 160 MB */
const history = (): StoredSample[] =>
  Array.from({ length: 120 }, (_, i) => ({
    t: T0 + i * 30_000,
    server: 200 * MB,
    roots: [{ root: 'p1', rss: (100 + i * 0.5) * MB, pids: 2 }],
    unavailable: false,
  }))

const app = (
  all: Task[],
  panelOf: (id: string) => TaskProcesses | null,
  project: { name: string; path: string } | null = null,
) =>
  new Hono().route(
    '/tasks',
    taskMemoryApi({
      tasks: {
        get: async (id) => all.find((x) => x.id === id) ?? null,
        peek: async (id) => all.find((x) => x.id === id) ?? null,
        list: async () => all,
      },
      panel: async (id) => panelOf(id),
      projects: { get: async () => project },
      history,
    }).routes,
  )

test('会话内存分析接口：报告带采样、归属和任务树，子对话只算自己的进程', async () => {
  const all = [
    task('p1', '', { usage: { agents: { a: { context: 48_000, window: 200_000 } } } as unknown as Task['usage'] }),
    task('c1', 'p1', { usage: { agents: { b: { context: 62_000, window: 200_000 } } } as unknown as Task['usage'] }),
  ]
  const res = await app(
    all,
    () =>
      panel([
        proc(11, 'p1', 140 * MB),
        proc(12, 'c1', 60 * MB),
        // 登记还在、进程已经没了归属的那个对话：读不到内存就记未采集，不能平摊
        proc(13, 'gone', null),
      ]),
    { name: 'agent-panel', path: 'E:/Project/agent-panel' },
  ).request('/tasks/p1/memory-analysis')
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    report: string
    ask: string
    cwd: string
    trend: string
    trendText: string
    owners: { taskId: string; self: boolean; rss: number | null; count: number; counted: number }[]
    tree: { tasks: number; children: number; running: number }
  }
  // 归属：本对话在最前，子对话只算它自己的 60 MB，未采集的那组是 null
  assert.deepEqual(
    body.owners.map((g) => [g.taskId, g.self, g.rss, g.count, g.counted]),
    [
      ['p1', true, 140 * MB, 1, 1],
      ['c1', false, 60 * MB, 1, 1],
      ['gone', false, null, 1, 0],
    ],
  )
  assert.equal(body.cwd, 'E:/Project/agent-panel')
  assert.equal(body.tree.tasks, 2)
  assert.equal(body.tree.children, 1)
  assert.equal(body.tree.running, 2)
  // 采样是涨的：趋势和面板摘要同源
  assert.equal(body.trend, 'up')
  assert.match(body.trendText, /持续上涨/)
  assert.match(body.report, /会话内存分析/)
  assert.match(body.report, /会话的标题|对话：「对话 p1」/)
  assert.match(body.report, /E:\/Project\/agent-panel/)
  assert.match(body.report, /趋势/)
  assert.match(body.report, /未采集（1 个进程都没读到内存，不是 0）/)
  assert.match(body.report, /任务树：本对话 \+ 1 个子对话，共 2 个任务/)
  assert.match(body.report, /子对话合计 62\.0k tokens/)
  assert.match(body.ask, /这个会话的内存/)
})

test('会话内存分析接口：任务不存在时报错，进程面板取不到也不炸', async () => {
  const missing = await app([], () => null).request('/tasks/none/memory-analysis')
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { error: '任务不存在' })

  // 进程面板还没准备好（无进程）：报告照常出，只是归属为空
  const res = await app([task('p1', '')], () => null).request('/tasks/p1/memory-analysis')
  assert.equal(res.status, 200)
  const body = (await res.json()) as { report: string; owners: unknown[]; cwd: string }
  assert.deepEqual(body.owners, [])
  assert.match(body.report, /这个会话现在没有在跑的进程/)
  // 没有项目时 cwd 为空，交给 AI 时用用户目录
  assert.equal(body.cwd, '')
})
