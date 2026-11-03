/**
 * 被面板重启打断的对话（实测报告问题 18）：退出前记名单，重启后首页问一次要不要全部继续。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 记录写在临时数据目录，别碰本机的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-restart-'))
process.env.AGENT_PANEL_DATA = dir

const { recordRestart, restartRoutes } = await import('./restart-interrupted.ts')
const { recordInterrupted, acknowledgeInterrupted } = await import('./interrupted.ts')
const { restartResumable } = await import('../shared/resume-kids.ts')
type Task = import('../shared/schema.ts').Task
type Body = import('../shared/version.ts').InterruptedTasks

const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    title: `对话 ${id}`,
    projectId: '',
    status: 'stopped',
    stopReason: 'restart',
    messages: [],
    steps: [],
    ...extra,
  }) as unknown as Task

const tasks = new Map(
  [
    task('top'),
    task('crash'),
    // 子对话由父对话继续时连带拉起（resumeKids），首页不重复拉
    task('kid', { parentTaskId: 'top' }),
    // 重启后用户自己停掉的、已经做完的、进了回收站的：不再列
    task('user', { stopReason: 'user' }),
    task('done', { status: 'done' }),
    task('trash', { deletedAt: '2026-10-01T00:00:00.000Z' }),
    task('upd'),
  ].map((x) => [x.id, x]),
)

const deps = (crashed: string[] = []) => ({
  ready: async () => crashed,
  getTask: async (id: string) => tasks.get(id) ?? null,
  projectName: async () => '',
})

function routes(crashed: string[] = []) {
  const app = restartRoutes(deps(crashed))
  return {
    get: async () => (await (await app.request('/restart-interrupted')).json()) as Body,
    ack: async () => (await (await app.request('/restart-interrupted/ack', { method: 'POST' })).json()) as Body,
  }
}
const ids = (b: Body) => b.tasks.map((x) => x.id)

test('restartResumable：只认顶层、停止原因是面板重启、还停着的对话', () => {
  assert.deepEqual(
    [...tasks.values()].filter(restartResumable).map((x) => x.id),
    ['top', 'crash', 'upd'],
  )
})

test('名单 = 退出前记下的 + 启动时发现还在执行的；子对话、用户停的、做完的、回收站的不列；确认后不再列', async () => {
  await recordRestart(
    ['top', 'kid', 'user', 'done', 'trash', 'gone'].map((id) => ({ id, doing: id === 'top' ? '计划 3/5' : '' })),
  )
  const r = routes(['crash', 'kid'])
  const body = await r.get()
  assert.deepEqual(ids(body), ['top', 'crash'])
  assert.equal(body.tasks[0].doing, '计划 3/5')
  assert.deepEqual((await r.ack()).tasks, [])
  // 文件里那部分已确认：换个进程（重启）再读不再提示；内存里那部分是新一次启动发现的，照常列
  assert.deepEqual(ids(await routes(['crash']).get()), ['crash'])
})

test('强制更新的弹窗还没处理时，它列过的对话不在首页重复出现；处理过了照常列', async () => {
  await recordRestart([{ id: 'upd', doing: '' }])
  await recordInterrupted([{ id: 'upd', doing: '' }])
  assert.deepEqual(ids(await routes().get()), [])
  await acknowledgeInterrupted()
  assert.deepEqual(ids(await routes().get()), ['upd'])
})

test('退出时没有在运行的对话也写一次空名单，把上次没处理的冲掉', async () => {
  await recordRestart([{ id: 'top', doing: '' }])
  await recordRestart([])
  assert.deepEqual(ids(await routes().get()), [])
})

test('设置里开了「重启后自动继续」：按首页同一份名单逐个继续，全部拉起才确认；关着时什么都不做（ADR 0042）', async () => {
  const { autoResumeAfterRestart } = await import('./restart-interrupted.ts')
  const run = async (enabled: boolean, fail: string[] = []) => {
    const calls: string[] = []
    await autoResumeAfterRestart({
      enabled: async () => enabled,
      call: async (method, path) => {
        calls.push(`${method} ${path}`)
        if (path === '/app/restart-interrupted')
          return { at: 'x', acknowledged: false, tasks: [{ id: 'a' }, { id: 'b' }] }
        if (fail.some((id) => path === `/tasks/${id}/resume`)) throw new Error('起不来')
        return {}
      },
    })
    return calls
  }
  assert.deepEqual(await run(false), [], '默认关：不读名单、不继续')
  assert.deepEqual(await run(true), [
    'GET /app/restart-interrupted',
    'POST /tasks/a/resume',
    'POST /tasks/b/resume',
    'POST /app/restart-interrupted/ack',
  ])
  // 有拉不起来的：不确认，首页照旧提示用户自己处理
  assert.ok(!(await run(true, ['b'])).includes('POST /app/restart-interrupted/ack'))
})
