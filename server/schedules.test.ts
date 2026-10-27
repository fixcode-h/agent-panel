import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { NewTaskInput, Task } from '../shared/schema.ts'
import { t } from '../shared/i18n.ts'
import {
  afterBlocked,
  scheduleCycleLabel,
  type Schedule,
  type ScheduleDelivery,
  type ScheduleEvent,
} from '../shared/schedule.ts'

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

/** 建一个可控的 api：startChat 只记下调用，返回一个假任务；fail 可以是固定文案，也可以按输入决定哪一条启动失败 */
function setup(
  fail?: string | ((input: NewTaskInput) => string | undefined),
  /** 投递 Webhook 的假实现：不真发网络请求，记下每次投递的内容 */
  deliver?: (event: ScheduleEvent, s: Schedule, at: string, projectName: string) => Promise<ScheduleDelivery | null>,
) {
  const calls: NewTaskInput[] = []
  const api = schedulesApi({
    startChat: async (input) => {
      calls.push(input)
      const error = typeof fail === 'function' ? fail(input) : fail
      if (error) throw new Error(error)
      return { id: `task:${input.prompt}` } as Task
    },
    // 项目名固定：载荷里要能看出是哪个项目
    projectName: async (id) => (id ? '构建项目' : ''),
    ...(deliver ? { deliver } : {}),
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
  // 旧实现按字符串比较会判成「改了时间」，把已执行的计划重置成待执行。
  // 取这一分钟的第 5 秒（和原时间的秒不同），不能直接加 20 秒：秒数大时会跨到下一分钟
  const minute = Math.floor(Date.parse(s.at) / MINUTE) * MINUTE
  const sameMinuteAt = new Date(minute + (Date.parse(s.at) === minute + 5000 ? 6000 : 5000)).toISOString()
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

test('依赖：上游成功启动后下游才启动，同一批里按上游在前的顺序', async () => {
  const { api, create, find, fired, calls } = setup()
  const now = Date.now()
  const upName = unique()
  const downName = unique()
  const up = await create(plan(upName, { repeat: 'daily', at: at(now - 1000) }))
  const down = await create(plan(downName, { repeat: 'daily', at: at(now - 1000), dependsOn: [up.id] }))

  await api.tick(now)
  assert.equal(fired(upName), 1)
  assert.equal(fired(downName), 1, '上游本轮成功启动，下游同一轮就能启动')
  // 上游排在下游前面启动，下游判定时能拿到本轮的成功记录
  assert.deepEqual(
    calls.map((c) => c.prompt),
    [upName, downName],
  )
  assert.equal((await find(down.id)).blockedAt, '', '启动成功之后不记「没启动」')
})

test('依赖：上游启动失败时下游不启动，原因写进计划给用户看', async () => {
  const now = Date.now()
  const upName = unique()
  const downName = unique()
  const { api, create, find, fired } = setup((input) => (input.prompt === upName ? '项目不存在' : undefined))
  const up = await create(plan(upName, { at: at(now - 1000) }))
  const down = await create(plan(downName, { repeat: 'daily', at: at(now - 1000), dependsOn: [up.id] }))

  await api.tick(now)
  assert.equal(fired(upName), 1, '上游照常尝试启动')
  assert.equal(fired(downName), 0, '上游失败，下游不启动')
  const blocked = await find(down.id)
  assert.equal(blocked.blockedAt, at(now - 1000))
  assert.equal(blocked.blockedReason, t('因为「{name}」启动失败，没有启动', { name: upName }))
  assert.equal(blocked.status, 'pending')
  assert.ok(Date.parse(blocked.at) > now, '按重复规则推到下一次，不会每轮询一次就重试')

  // 下一轮：上游已经失败（单次的话是 skipped），下游到下一天之前不会再被拦住一次
  await api.tick(now + MINUTE)
  assert.equal(fired(downName), 0)
})

test('依赖：上游停用 / 从没跑过 / 被删掉都拦住下游', async () => {
  const now = Date.now()
  const put = (api: ReturnType<typeof schedulesApi>, id: string, body: Record<string, unknown>) =>
    api.routes.request(`/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  // 停用：用户主动停下上游，下游也不再启动
  {
    const { api, create, find, fired } = setup()
    const upName = unique()
    const downName = unique()
    const up = await create(plan(upName, { repeat: 'daily', at: at(now - 1000) }))
    const down = await create(plan(downName, { repeat: 'daily', at: at(now - 1000), dependsOn: [up.id] }))
    assert.equal((await put(api, up.id, plan(upName, { repeat: 'daily', at: up.at, enabled: false }))).status, 200)
    await api.tick(now)
    assert.equal(fired(downName), 0)
    assert.equal((await find(down.id)).blockedReason, t('因为「{name}」已停用，没有启动', { name: upName }))
  }

  // 从没跑过：下游到点时上游还没到（或者被停着），原因写清是「还没有执行过」
  {
    const { api, create, find, fired } = setup()
    const upName = unique()
    const downName = unique()
    const up = await create(plan(upName, { repeat: 'daily', at: at(now + HOUR) }))
    const down = await create(plan(downName, { repeat: 'daily', at: at(now - 1000), dependsOn: [up.id] }))
    await api.tick(now)
    assert.equal(fired(downName), 0)
    assert.equal((await find(down.id)).blockedReason, t('因为「{name}」还没有执行过，没有启动', { name: upName }))
  }

  // 上游被删掉：拦住，并说清是上游已经不存在
  {
    const { api, create, find } = setup()
    const upName = unique()
    const downName = unique()
    const up = await create(plan(upName, { repeat: 'daily', at: at(now + HOUR) }))
    const down = await create(plan(downName, { repeat: 'daily', at: at(now - 1000), dependsOn: [up.id] }))
    await api.routes.request(`/${up.id}`, { method: 'DELETE' })
    await api.tick(now)
    assert.equal((await find(down.id)).blockedReason, t('因为上游计划已不存在，没有启动'))
  }
})

test('依赖：保存时拒绝不存在的上游、依赖自己和成环', async () => {
  const { api, create } = setup()
  const now = Date.now()
  const a = await create(plan(unique(), { at: at(now + HOUR) }))
  const b = await create(plan(unique(), { at: at(now + HOUR), dependsOn: [a.id] }))

  const put = (id: string, body: Record<string, unknown>) =>
    api.routes.request(`/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  // 依赖不存在的计划
  const missing = await api.routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan(unique(), { at: at(now + HOUR), dependsOn: ['not-exist'] })),
  })
  assert.equal(missing.status, 400)
  assert.equal(((await missing.json()) as { error: string }).error, t('选中的上游计划已经不存在，请重新选择'))

  // 依赖自己
  const self = await put(a.id, plan(a.name, { at: a.at, dependsOn: [a.id] }))
  assert.equal(self.status, 400)
  assert.equal(((await self.json()) as { error: string }).error, t('计划不能依赖自己，请去掉这一项'))

  // 成环：a 依赖 b，而 b 本来就依赖 a
  const cycle = await put(a.id, plan(a.name, { at: a.at, dependsOn: [b.id] }))
  assert.equal(cycle.status, 400)
  assert.equal(
    ((await cycle.json()) as { error: string }).error,
    t('依赖关系成环：{path}，请去掉一个上游再保存', {
      path: scheduleCycleLabel([a.id, b.id, a.id], [a, b]),
    }),
  )
})

test('Webhook：成功启动 / 启动失败 / 错过 / 上游没成功各投递一次，结果记进计划', async () => {
  const now = Date.now()
  const sent: { event: ScheduleEvent; at: string; projectName: string; payloadId: string }[] = []
  const deliver = async (event: ScheduleEvent, s: Schedule, at: string, projectName: string) => {
    sent.push({ event, at, projectName, payloadId: s.id })
    return {
      at: new Date().toISOString(),
      event,
      ok: true,
      status: 200,
      error: '',
      attempts: 1,
    } satisfies ScheduleDelivery
  }
  const upName = unique()
  const downName = unique()
  const { api, create, find } = setup((input) => (input.prompt === upName ? '项目不存在' : undefined), deliver)
  // 上游失败 → 下游被拦住；上游自己也投递一条 fail
  const up = await create(plan(upName, { projectId: 'proj-1', at: at(now - 1000) }))
  const down = await create(plan(downName, { projectId: 'proj-1', at: at(now - 1000), dependsOn: [up.id] }))
  await api.tick(now)
  await api.settled()

  assert.deepEqual(
    sent.map((x) => x.event),
    ['fail', 'blocked'],
    '上游启动失败投 fail，下游被拦住投 blocked',
  )
  assert.equal(sent[0].projectName, '构建项目')
  assert.equal(sent[0].at, at(now - 1000), '载荷里的时间是用这一轮到点的时间')
  // 投递结果写在计划上，界面上能看到最近一次投递
  const upSaved = await find(up.id)
  assert.equal(upSaved.lastDelivery?.ok, true)
  assert.equal(upSaved.lastDelivery?.event, 'fail')
  assert.equal((await find(down.id)).lastDelivery?.event, 'blocked')

  // 成功启动：投 run，带这次启动的对话 id
  const okName = unique()
  // 到点时间放在宽限时间内：错过太久的会被判成 miss，验不到 run
  const s = await create(plan(okName, { at: at(now + 30_000) }))
  await api.tick(now + MINUTE)
  await api.settled()
  const saved = await find(s.id)
  assert.equal(saved.lastDelivery?.event, 'run')
  assert.equal(saved.lastDelivery?.ok, true)

  // 错过：投 miss
  const missName = unique()
  const missed = await create(plan(missName, { at: at(now - 10 * MINUTE) }))
  await api.tick(now)
  await api.settled()
  assert.equal((await find(missed.id)).lastDelivery?.event, 'miss')
})

test('Webhook 投递失败不影响计划本身：启动照常、计划状态正常、不抛出', async () => {
  const now = Date.now()
  const { api, create, find, fired } = setup(undefined, async () => {
    throw new Error('connect ECONNREFUSED')
  })
  const name = unique()
  const s = await create(plan(name, { repeat: 'daily', at: at(now - 1000) }))
  await api.tick(now)
  await api.settled()
  // 对话照样启动了，下次执行时间照样往后推
  assert.equal(fired(name), 1)
  const saved = await find(s.id)
  assert.equal(saved.status, 'pending')
  assert.ok(Date.parse(saved.at) > now)
  assert.equal(saved.lastDelivery, null, '投递没成时不留一条假的成功记录')
})

test('计划的执行上限：启动对话时落到任务输入上，之后改计划不影响已经启动的对话', async () => {
  const { api, create, calls } = setup()
  const now = Date.now()
  const name = unique()
  const s = await create(plan(name, { at: at(now - 1000), budget: { tokens: 5000, minutes: 30 } }))
  await api.tick(now)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].budgetTokens, 5000)
  assert.equal(calls[0].budgetMinutes, 30)
  // 上限跟着这次新建的任务走：计划之后再改，已经启动的对话不受影响
  assert.equal(s.budget.tokens, 5000)
  assert.equal(calls[0].budgetTokens, 5000)
})

test('依赖：同批里上游被拦住时下游读的是这一轮的结果，不会被旧的成功放行', async () => {
  const aName = unique()
  const bName = unique()
  const cName = unique()
  const { api, create, find, fired } = setup((input) => (input.prompt === aName ? '项目不存在' : undefined))
  const now = Date.now()
  const a = await create(plan(aName, { repeat: 'daily', at: at(now - 1000) }))
  const b = await create(plan(bName, { repeat: 'daily', at: at(now - 1000), dependsOn: [a.id] }))
  const c = await create(plan(cName, { repeat: 'daily', at: at(now - 1000), dependsOn: [b.id] }))
  // B 昨天成功启动过（24 小时窗口内）：旧快照会把它当成「这一轮成功」，把 C 放过去
  await api.runNow(b.id, now - 23 * HOUR)
  assert.equal(fired(bName), 1)

  await api.tick(now)
  assert.equal(fired(aName), 1)
  assert.equal(fired(bName), 1, 'B 被上游拦住，这一次没有启动')
  assert.equal(fired(cName), 0, 'B 这一轮没跑成，C 不能靠 B 昨天的成功启动')
  const savedC = await find(c.id)
  assert.equal(savedC.blockedReason, t('因为「{name}」的上游没有成功，没有启动', { name: bName }))
})

test('被上游拦住时用户改了排期：不把旧到点时间和跳过状态写回', async () => {
  const { api, create, find } = setup()
  const now = Date.now()
  const name = unique()
  // 单次计划：被拦住时 afterBlocked 会把它标成 skipped
  const s = await create(plan(name, { at: at(now - 1000) }))
  const later = at(now + 2 * HOUR)
  const res = await api.routes.request(`/${s.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan(name, { at: later })),
  })
  assert.equal(res.status, 200)

  // 模拟 tick 已经按旧快照判定完，这时才写回：writeBack 会重新读、发现排期变了
  const saved = await api.writeBack(s.id, s.at, afterBlocked(s, now, '因为「构建」启动失败，没有启动'))
  assert.ok(saved)
  assert.equal(saved.status, 'pending', '用户改了排期，不能被写成已跳过')
  assert.equal(saved.at, later, '保留用户的新时间')
  assert.equal(saved.blockedAt, '', '旧到点时间不能落到新排期上')
  assert.equal(saved.blockedReason, '', '这次判定的原因归旧排期管，不挂到新排期上')
  assert.equal((await find(s.id)).status, 'pending')
})
