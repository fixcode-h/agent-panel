import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { NewTaskInput, Task } from '../shared/schema.ts'
import type { Schedule } from '../shared/schedule.ts'

// 数据目录换成临时的，别动本机的计划和配置
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-schedules-'))
process.env.AGENT_PANEL_DATA = dir

const { schedulesApi } = await import('./schedules.ts')

const at = (ms: number) => new Date(ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** 几个用例共用同一个数据文件，按计划名区分自己触发的那几次 */
let seq = 0
const unique = () => `计划-${++seq}`

/** 建一个可控的 api：startChat 只记下调用，返回一个假任务 */
function setup(fail?: string) {
  const calls: NewTaskInput[] = []
  const api = schedulesApi({
    startChat: async (input) => {
      calls.push(input)
      if (fail) throw new Error(fail)
      return { id: `task:${input.prompt}` } as Task
    },
  })
  const create = async (body: Record<string, unknown>) => {
    const res = await api.routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(res.status, 201)
    return (await res.json()) as Schedule
  }
  const list = async () => (await (await api.routes.request('/')).json()) as Schedule[]
  const find = async (id: string) => (await list()).find((s) => s.id === id)!
  const fired = (prompt: string) => calls.filter((c) => c.prompt === prompt).length
  return { api, calls, create, list, find, fired }
}

const plan = (prompt: string, over: Record<string, unknown> = {}) => ({
  name: prompt,
  prompt,
  projectId: '',
  agentId: '',
  repeat: 'once',
  enabled: true,
  ...over,
})

test('到点启动一次对话：每天的推到明天，当天不再重复启动', async () => {
  const { api, create, find, fired } = setup()
  const now = Date.now()
  const name = unique()
  const s = await create(plan(name, { repeat: 'daily', at: at(now - 1000) }))

  await api.tick(now)
  assert.equal(fired(name), 1)

  const after = await find(s.id)
  assert.equal(after.status, 'pending')
  assert.equal(after.lastTaskId, `task:${name}`)
  assert.ok(Date.parse(after.at) > now, '下次执行时间推到了未来')

  // 同一天再轮询几次也不会再启动
  await api.tick(now + MINUTE)
  await api.tick(now + 2 * MINUTE)
  assert.equal(fired(name), 1)
})

test('单次计划执行后标成已执行，之后不再启动', async () => {
  const { api, create, find, fired } = setup()
  const now = Date.now()
  const name = unique()
  const s = await create(plan(name, { at: at(now - 1000) }))

  await api.tick(now)
  assert.equal(fired(name), 1)
  assert.equal((await find(s.id)).status, 'done')
  await api.tick(now + MINUTE)
  assert.equal(fired(name), 1)
})

test('错过的计划不补跑：只标成已跳过并记下错过的那一次', async () => {
  const { api, create, find, fired } = setup()
  const now = Date.now()
  const past = now - 5 * MINUTE
  const name = unique()
  const s = await create(plan(name, { at: at(past) }))

  await api.tick(now)
  assert.equal(fired(name), 0)
  const after = await find(s.id)
  assert.equal(after.status, 'skipped')
  assert.equal(after.missedAt, at(past))
})

test('立即执行不改排期：只记下这次启动的对话', async () => {
  const { api, create, find, fired } = setup()
  const now = Date.now()
  const later = now + HOUR
  const name = unique()
  const s = await create(plan(name, { at: at(later) }))

  const res = await api.runNow(s.id, now)
  assert.equal(res?.taskId, `task:${name}`)
  assert.equal(fired(name), 1)
  const after = await find(s.id)
  assert.equal(after.status, 'pending')
  assert.equal(after.at, at(later), '排期不变')
  assert.equal(after.lastTaskId, `task:${name}`)
})

test('启动失败：原因记进计划，单次的标成已跳过，不会每次轮询都重试', async () => {
  const { api, create, find, fired } = setup('项目不存在')
  const now = Date.now()
  const name = unique()
  const s = await create(plan(name, { at: at(now - 1000) }))

  await api.tick(now)
  assert.equal(fired(name), 1)
  const after = await find(s.id)
  assert.equal(after.status, 'skipped')
  assert.equal(after.lastError, '项目不存在')
  await api.tick(now + MINUTE)
  assert.equal(fired(name), 1)
})

test('删除之后不再触发', async () => {
  const { api, create, list, fired } = setup()
  const now = Date.now()
  const name = unique()
  const s = await create(plan(name, { at: at(now + HOUR) }))
  const res = await api.routes.request(`/${s.id}`, { method: 'DELETE' })
  assert.equal(res.status, 204)
  assert.equal(
    (await list()).some((x) => x.id === s.id),
    false,
  )
  await api.tick(now + 2 * HOUR)
  assert.equal(fired(name), 0)
})

test('启动对话期间用户改了排期：写回保留用户的新时间，只更新这次启动的记录', async () => {
  const now = Date.now()
  const name = unique()
  const calls: NewTaskInput[] = []
  let target: Schedule | undefined
  let api!: ReturnType<typeof schedulesApi>
  api = schedulesApi({
    startChat: async (input) => {
      calls.push(input)
      // 模拟：启动对话这几秒里，用户在弹窗里把每天的时间改到了两小时后
      if (target)
        await api.routes.request(`/${target.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(plan(target.prompt, { repeat: 'daily', at: at(now + 2 * HOUR) })),
        })
      return { id: `task:${input.prompt}` } as Task
    },
  })
  const res = await api.routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan(name, { repeat: 'daily', at: at(now - 1000) })),
  })
  target = (await res.json()) as Schedule

  await api.tick(now)
  const after = (await (await api.routes.request('/')).json()) as Schedule[]
  const saved = after.find((x) => x.id === target!.id)!
  assert.equal(calls.length, 1)
  assert.equal(saved.at, at(now + 2 * HOUR), '用户改的时间没有被快照覆盖')
  assert.equal(saved.lastTaskId, `task:${name}`)
  assert.equal(saved.status, 'pending')
})

test('只改名字、时间还是同一分钟：状态保持已执行，不会重置成待执行', async () => {
  const { api, create, find } = setup()
  const now = Date.now()
  const name = unique()
  const s = await create(plan(name, { at: at(now - 1000) }))
  await api.tick(now)
  assert.equal((await find(s.id)).status, 'done')

  // 前端的时间只到分钟：带秒的时间在弹窗里改名字时会被截断成同一分钟的整分，
  // 旧实现按字符串比较会判成「改了时间」，把已执行的计划重置成待执行
  const sameMinuteAt = new Date(Date.parse(s.at) + 20_000).toISOString()
  const res = await api.routes.request(`/${s.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan(`${name}-改名`, { at: sameMinuteAt })),
  })
  assert.equal(res.status, 200)
  const after = (await res.json()) as Schedule
  assert.equal(after.name, `${name}-改名`)
  assert.equal(after.status, 'done')
  assert.equal(after.at, sameMinuteAt)
})

test('到点启动期间用户只改名字、时间被截成整分：单次计划仍算已执行，不会重复启动', async () => {
  // at 带 30 秒，界面上的时间只到分钟：用户保存时会被截成同一分钟的整分
  const atMs = Math.floor(Date.now() / MINUTE) * MINUTE + 30_000
  const tickAt = atMs + 1000
  const name = unique()
  const calls: NewTaskInput[] = []
  let target: Schedule | undefined
  let api!: ReturnType<typeof schedulesApi>
  api = schedulesApi({
    startChat: async (input) => {
      calls.push(input)
      if (target) {
        const minute = new Date(Math.floor(Date.parse(target.at) / MINUTE) * MINUTE).toISOString()
        await api.routes.request(`/${target.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(plan(`${name}-改名`, { at: minute })),
        })
      }
      return { id: `task:${input.prompt}` } as Task
    },
  })
  const res = await api.routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan(name, { at: at(atMs) })),
  })
  target = (await res.json()) as Schedule

  await api.tick(tickAt)
  const list = (await (await api.routes.request('/')).json()) as Schedule[]
  const saved = list.find((x) => x.id === target!.id)!
  assert.equal(saved.status, 'done', '启动完成后单次计划要标成已执行')
  assert.equal(saved.at, new Date(Math.floor(atMs / MINUTE) * MINUTE).toISOString(), '用户截断后的时间保留')
  // 下一轮轮询：at 还在宽限时间内，但已经执行过，不能再启动一次
  await api.tick(tickAt + 30_000)
  assert.equal(calls.length, 1)
})
