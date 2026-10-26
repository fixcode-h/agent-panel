import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost, type HelperSpec } from '../shared/engine.ts'
import { coreDefinition, syncCore, upgradeRunIn } from '../shared/builtin/core.ts'

/**
 * 「禁止子对话执行」的角色（runIn: 'parent'，见 ADR 0019）：
 * 子对话里点名它时不在这里跑，转交父对话创建；子对话点名的计划步骤立即标完成，不等它的结果。
 */
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  ...AgentInput.parse({ name }),
  id,
  createdAt: '',
  updatedAt: '',
  ...extra,
})

/**
 * 一个对话任务（默认是子对话）：run 在对话那一轮里跑，子任务的执行直接返回固定文本，
 * 测试只关心对话这一轮怎么派。
 */
function makeHost(
  run: (call: AgentCall, task: Task) => Promise<string>,
  opts: { child?: boolean; forwardSpawn?: EngineHost['forwardSpawn'] } = {},
) {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', agentId: 'w', prompt: '补文档' } as never, undefined, '', 't'),
    id: 't',
    ...(opts.child === false ? {} : { parentTaskId: 'parent' }),
  } as Task
  let n = 0
  const host: EngineHost = {
    task,
    agents: [agent('w', '执行'), agent('d', '文档', { runIn: 'parent' })],
    workflows: [],
    prompt: '补文档',
    changed: () => {},
    newId: () => `id${++n}`,
    ...(opts.forwardSpawn ? { forwardSpawn: opts.forwardSpawn } : {}),
    runAgent: async (call) => {
      if (call.step) return { ok: true, text: '子任务结果' }
      return { ok: true, text: await run(call, task) }
    },
  }
  return { task, host }
}

test('runIn：默认任意对话，写坏了按 any 读，认得的只有 any / parent', () => {
  assert.equal(AgentInput.parse({ name: '角色' }).runIn, 'any')
  assert.equal(AgentInput.parse({ name: '角色', runIn: 'parent' }).runIn, 'parent')
  assert.equal(AgentInput.parse({ name: '角色', runIn: '只在子对话' }).runIn, 'any')
})

test('内置角色：只有「文档」默认禁止子对话执行', () => {
  assert.equal(coreDefinition('docsync').agent.runIn, 'parent')
  for (const key of ['orchestrator', 'worker', 'reviewer', 'tester', 'vcs', 'helper', 'analyzer'] as const)
    assert.equal(coreDefinition(key).agent.runIn, 'any', `${key} 不该跟着改`)
})

test('已装的「文档」：一次性升级成禁止子对话执行，用户改回去不再被覆盖', () => {
  const before = AgentInput.parse({ name: '文档' })
  const up = upgradeRunIn(before, 'docsync')
  assert.equal(up.runIn, 'parent')
  assert.ok(up.upgrades?.includes('docsync.run-in-parent'))
  // 升级做过之后用户改回「任意对话」：不会被再改回来
  assert.equal(upgradeRunIn({ ...up, runIn: 'any' }, 'docsync').runIn, 'any')
  // 别的必备角色不跟着改
  assert.equal(upgradeRunIn(before, 'worker').runIn, 'any')
})

test('内置角色保存时保留用户改的启动位置', () => {
  const def = coreDefinition('docsync')
  const next = syncCore(AgentInput.parse({ name: '文档', runIn: 'any' }), def, { categoryId: '', includes: [] })
  assert.equal(next.runIn, 'any')
})

test('子对话派禁止子对话执行的角色：转交父对话，不在这里建，点名的步骤立即完成', async () => {
  const forwarded: HelperSpec[] = []
  const { task, host } = makeHost(
    async (call, t) => {
      await call.orch!.setPlan({ title: '补文档', steps: [{ title: '补文档', status: 'running' }] })
      const id = t.plans[0].steps[0].id
      const r = call.orch!.spawn([{ title: '补文档', instructions: '写 README', agent: '文档' }], id)
      assert.deepEqual(r.ids, [])
      assert.equal(r.error, undefined)
      assert.match(r.info!, /已转交父对话/)
      assert.equal(t.plans[0].steps[0].status, 'done', '点名的那一步立即标完成，不等父对话那边的结果')
      return '已经转交'
    },
    {
      forwardSpawn: (spec) => {
        forwarded.push(spec)
        return { ok: true, id: 'parent/sub/h1', info: '已在父对话里创建' }
      },
    },
  )
  await runEngineTurn(host)
  assert.equal(forwarded.length, 1)
  assert.equal(forwarded[0].agent, '文档')
  assert.equal(task.steps.filter((s) => s.slot === 'sub').length, 0, '子对话里不建这个子任务')
  assert.equal(task.status, 'done')
})

test('父对话接不了：返回明确错误，不假装派出去，步骤也不标完成', async () => {
  const { task, host } = makeHost(
    async (call, t) => {
      await call.orch!.setPlan({ title: '补文档', steps: [{ title: '补文档', status: 'running' }] })
      const id = t.plans[0].steps[0].id
      const r = call.orch!.spawn([{ title: '补文档', instructions: '写 README', agent: '文档' }], id)
      assert.deepEqual(r.ids, [])
      assert.match(r.error!, /父对话自己也是被派出来的子对话/)
      assert.notEqual(t.plans[0].steps[0].status, 'done')
      return '没能转交'
    },
    { forwardSpawn: () => ({ ok: false, info: '父对话自己也是被派出来的子对话' }) },
  )
  await runEngineTurn(host)
  assert.equal(task.steps.filter((s) => s.slot === 'sub').length, 0)
})

test('禁止子对话执行的角色不能带 resume 转交（父对话那边是新任务）', async () => {
  let called = 0
  const { host } = makeHost(
    async (call) => {
      const r = call.orch!.spawn([{ title: '补文档', instructions: '写 README', agent: '文档', resume: 't/sub/h1' }])
      assert.deepEqual(r.ids, [])
      assert.match(r.error!, /resume/)
      return '没有派'
    },
    {
      forwardSpawn: () => {
        called++
        return { ok: true, info: '' }
      },
    },
  )
  await runEngineTurn(host)
  assert.equal(called, 0, '没有真的转交出去')
})

test('整批转交里有一件没交出去：返回错误，点名的步骤不标完成', async () => {
  const forwarded: HelperSpec[] = []
  const { task, host } = makeHost(
    async (call, t) => {
      await call.orch!.setPlan({ title: '补文档', steps: [{ title: '补文档', status: 'running' }] })
      const id = t.plans[0].steps[0].id
      const r = call.orch!.spawn(
        [
          { title: '补文档', instructions: '写 README', agent: '文档' },
          { title: '补模块文档', instructions: '写模块 README', agent: '文档', resume: 't/sub/h1' },
        ],
        id,
      )
      assert.deepEqual(r.ids, [])
      // 有没交出去的不算成功：要报错，模型才知道少做了一件
      assert.match(r.error!, /resume/)
      assert.notEqual(t.plans[0].steps[0].status, 'done', '还有没交出去的，不能标完成')
      return '部分没交出去'
    },
    {
      forwardSpawn: (spec) => {
        forwarded.push(spec)
        return { ok: true, id: 'parent/sub/h1', info: '' }
      },
    },
  )
  await runEngineTurn(host)
  assert.deepEqual(
    forwarded.map((f) => f.title),
    ['补文档'],
    '能交出去的那件照常交出去',
  )
  assert.ok(
    task.messages.some((m) => /已转交父对话创建「补文档」/.test(m.text)),
    '部分成交时子对话里也留一条可读的记录（收尾总结能说明这件事）',
  )
})

test('任意对话的角色照常在本地派：不转交，点名的步骤挂等待', async () => {
  let called = 0
  const { task, host } = makeHost(
    async (call, t) => {
      await call.orch!.setPlan({ title: '查代码', steps: [{ title: '查代码', status: 'running' }] })
      const id = t.plans[0].steps[0].id
      const r = call.orch!.spawn([{ title: '查代码', instructions: '查一下', agent: '执行' }], id)
      assert.equal(r.ids.length, 1)
      await call.orch!.wait(r.ids, 1000)
      return '查完了'
    },
    {
      forwardSpawn: () => {
        called++
        return { ok: true, info: '' }
      },
    },
  )
  await runEngineTurn(host)
  assert.equal(called, 0)
  assert.equal(task.steps.filter((s) => s.slot === 'sub').length, 1)
})

test('一批里既有本地派又有转交：本地建自己的，转交的不占本地名额', async () => {
  const forwarded: HelperSpec[] = []
  const { task, host } = makeHost(
    async (call) => {
      const r = call.orch!.spawn([
        { title: '查代码', instructions: '查', agent: '执行' },
        { title: '补文档', instructions: '写 README', agent: '文档' },
      ])
      assert.equal(r.ids.length, 1, '本地只派了「执行」那个')
      await call.orch!.wait(r.ids, 1000)
      assert.match(r.info!, /转交父对话创建：补文档/)
      return '好了'
    },
    {
      forwardSpawn: (spec) => {
        forwarded.push(spec)
        return { ok: true, id: 'parent/sub/h1', info: '' }
      },
    },
  )
  await runEngineTurn(host)
  assert.deepEqual(
    forwarded.map((f) => f.title),
    ['补文档'],
  )
  assert.deepEqual(
    task.steps.filter((s) => s.slot === 'sub').map((s) => s.title),
    ['查代码'],
  )
})

test('父对话自己派禁止子对话执行的角色：照常在本地派', async () => {
  const { task, host } = makeHost(
    async (call) => {
      const r = call.orch!.spawn([{ title: '补文档', instructions: '写 README', agent: '文档' }])
      assert.equal(r.ids.length, 1)
      await call.orch!.wait(r.ids, 1000)
      return '写完了'
    },
    { child: false, forwardSpawn: () => ({ ok: false, info: '父对话不该走这条路' }) },
  )
  await runEngineTurn(host)
  assert.equal(task.steps.filter((s) => s.slot === 'sub').length, 1)
})

test('父对话自己派（local）：不再按 runIn 转交，避免转一圈又回来', async () => {
  const { task, host } = makeHost(
    async (call) => {
      const r = call.orch!.spawn([{ title: '补文档', instructions: '写 README', agent: '文档' }], undefined, {
        local: true,
      })
      assert.equal(r.ids.length, 1)
      await call.orch!.wait(r.ids, 1000)
      return '写完了'
    },
    { forwardSpawn: () => ({ ok: false, info: '父对话不该走这条路' }) },
  )
  await runEngineTurn(host)
  assert.equal(task.steps.filter((s) => s.slot === 'sub').length, 1)
})

test('没有父对话容器的环境：转交时报错，不静默', async () => {
  const { task, host } = makeHost(async (call) => {
    const r = call.orch!.spawn([{ title: '补文档', instructions: '写 README', agent: '文档' }])
    assert.deepEqual(r.ids, [])
    assert.match(r.error!, /没有父对话/)
    return '没有派'
  })
  await runEngineTurn(host)
  assert.equal(task.steps.filter((s) => s.slot === 'sub').length, 0)
})
