import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost } from '../shared/engine.ts'

/**
 * 多步骤节点：每一步一条 slot=step 的执行记录、一个独立会话，按顺序执行，
 * 上一步的输出作为下一步的输入；失败即停，中断后已完成的步骤不重跑。
 */
const agent = (id: string, name: string): Agent => ({
  ...AgentInput.parse({ name }),
  id,
  createdAt: '',
  updatedAt: '',
})
const agents = [agent('m', '主管'), agent('w', '开发'), agent('v', '验收')]

type StepSpec = {
  id: string
  title: string
  agentId?: string
  instructions?: string
  confirm?: boolean
  review?: { kind: 'sub'; id: string } | null
  maxRounds?: number
}

const workflow = (steps: StepSpec[], withCheck = false): Workflow =>
  Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: '多步',
    mainAgentId: 'm',
    dispatch: false,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'a',
            title: '方案与实现',
            instructions: '',
            steps: steps.map((s) => ({ agentId: 'w', ...s })),
          },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'end' },
        ],
      },
      ...(withCheck
        ? [
            {
              id: 'check',
              name: '验收',
              nodes: [{ id: 'verify', title: '验收', agentId: 'v', instructions: '检查。' }],
              edges: [
                { id: 'c1', from: 'start', to: 'verify' },
                { id: 'c2', from: 'verify', to: 'end' },
              ],
            },
          ]
        : []),
    ],
  })

function makeHost(
  w: Workflow,
  reply: (call: AgentCall) => string | Promise<string> | { ok: false; stopped?: boolean; error: string },
  confirm?: EngineHost['confirm'],
) {
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, w, '', 't'),
    id: 't',
  } as Task
  const log: AgentCall[] = []
  let n = 0
  const host: EngineHost = {
    task,
    agents,
    workflows: [w],
    workflow: w,
    prompt: '做功能',
    changed: () => {},
    newId: () => `id${++n}`,
    confirm,
    runAgent: async (call) => {
      log.push(call)
      const r = await reply(call)
      return typeof r === 'string' ? { ok: true, text: r } : r
    },
  }
  return { task, log, host }
}

test('多步骤节点：按顺序执行，每步独立会话，上一步输出交给下一步', async () => {
  const w = workflow([
    { id: 's1', title: '方案', instructions: '先出方案。' },
    { id: 's2', title: '实现', instructions: '按方案实现。' },
  ])
  const { task, log, host } = makeHost(w, (call) => (call.step?.id === 'a/step/s1' ? '第一步的结果' : '第二步的结果'))
  await runEngineTurn(host)

  const node = task.steps.find((s) => s.id === 'a')!
  const s1 = task.steps.find((s) => s.id === 'a/step/s1')!
  const s2 = task.steps.find((s) => s.id === 'a/step/s2')!
  assert.equal(node.status, 'done')
  assert.equal(node.output, '第二步的结果')
  assert.equal(s1.slot, 'step')
  assert.equal(s2.slot, 'step')
  assert.equal(s1.status, 'done')
  assert.equal(s2.status, 'done')
  // 两步各自一个会话，按顺序调用
  assert.deepEqual(
    log.filter((c) => !c.dispatching).map((c) => c.sessionKey),
    ['a/step/s1', 'a/step/s2'],
  )
  assert.match(log[1].prompt, /第一步的结果/)
  assert.doesNotMatch(log[0].prompt, /第二步/)
})

test('多步骤节点：某一步失败后后面的步骤不执行，节点失败', async () => {
  const w = workflow([
    { id: 's1', title: '一步', instructions: '一。' },
    { id: 's2', title: '二步', instructions: '二。' },
    { id: 's3', title: '三步', instructions: '三。' },
  ])
  const { task, log, host } = makeHost(w, (call) =>
    call.step?.id === 'a/step/s2' ? { ok: false, error: '坏了' } : '完成',
  )
  await runEngineTurn(host)

  assert.equal(task.status, 'failed')
  const node = task.steps.find((s) => s.id === 'a')!
  assert.equal(node.status, 'failed')
  assert.equal(task.steps.find((s) => s.id === 'a/step/s1')!.status, 'done')
  assert.equal(task.steps.find((s) => s.id === 'a/step/s2')!.status, 'failed')
  assert.equal(
    task.steps.find((s) => s.id === 'a/step/s3'),
    undefined,
  )
  assert.equal(log.filter((c) => c.sessionKey === 'a/step/s3').length, 0)
})

test('多步骤节点：确认只作用于配了确认的那一步', async () => {
  const w = workflow([
    { id: 's1', title: '方案', instructions: '一。', confirm: true },
    { id: 's2', title: '实现', instructions: '二。' },
  ])
  const asked: string[] = []
  const { task, host } = makeHost(
    w,
    () => '完成',
    async (step) => {
      asked.push(step.id)
      return { allow: true }
    },
  )
  await runEngineTurn(host)

  assert.deepEqual(asked, ['a/step/s1'])
  assert.equal(task.steps.find((s) => s.id === 'a')!.status, 'done')
})

test('多步骤节点：验收意见只回到那一步，通过后继续下一步', async () => {
  const w = workflow(
    [
      {
        id: 's1',
        title: '实现',
        instructions: '写代码。',
        review: { kind: 'sub', id: 'check' },
        maxRounds: 2,
      },
      { id: 's2', title: '收尾', instructions: '收尾。' },
    ],
    true,
  )
  let reviews = 0
  const { task, log, host } = makeHost(w, (call) => {
    if (call.step?.nodeId === 'verify') return ++reviews === 1 ? '验收结论：不通过' : '验收结论：通过'
    return call.step?.id === 'a/step/s1' ? '实现结果' : '收尾结果'
  })
  await runEngineTurn(host)

  const s1 = task.steps.find((s) => s.id === 'a/step/s1')!
  assert.equal(s1.rounds, 2)
  assert.equal(s1.verdict, 'pass')
  assert.equal(task.steps.find((s) => s.id === 'a/step/s2')!.status, 'done')
  // 返工续接这一步自己的会话
  const rework = log.find((c) => c.sessionKey === 'a/step/s1' && c.prompt.includes('验收没有通过'))
  assert.ok(rework)
  assert.equal(log.filter((c) => c.sessionKey?.startsWith('a/step/s1/review.')).length, 2)
})

test('多步骤节点：停止后续跑不重跑已完成的步骤，只续接没做完的一步', async () => {
  const w = workflow([
    { id: 's1', title: '一步', instructions: '一。' },
    { id: 's2', title: '二步', instructions: '二。' },
  ])
  let stopped = false
  const { task, log, host } = makeHost(w, (call) => {
    if (call.sessionKey === 'a/step/s2' && !stopped) {
      stopped = true
      task.sessions[call.sessionKey] = 'sess2'
      return { ok: false, stopped: true, error: '停止' }
    }
    return call.sessionKey === 'a/step/s1' ? '一步结果' : '二步结果'
  })
  await runEngineTurn(host)
  assert.equal(task.status, 'stopped')
  assert.equal(task.steps.find((s) => s.id === 'a/step/s1')!.status, 'done')
  assert.equal(task.steps.find((s) => s.id === 'a/step/s2')!.status, 'pending')

  // 每一轮在服务端都是一个新宿主；这里沿用同一个，复位上一轮失败时的暂停标记
  host.halted = false
  await runEngineTurn(host)
  assert.equal(task.status, 'done')
  assert.equal(task.steps.find((s) => s.id === 'a')!.status, 'done')
  // 第一步只跑过一次
  assert.equal(log.filter((c) => c.sessionKey === 'a/step/s1').length, 1)
  const resumed = log.filter((c) => c.sessionKey === 'a/step/s2')
  assert.equal(resumed.length, 2)
  assert.match(resumed[1].prompt, /被中断/)
})

test('多步骤节点：步骤派出的子 Agent 挂在步骤记录下', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  const { task, host } = makeHost(w, (call) => {
    if (call.step?.id === 'a/step/s1') {
      const ids = call.orch!.spawn([{ title: '子任务', instructions: '帮我查一下' }]).ids
      return call.orch!.wait(ids, 1000).then(() => '一步结果')
    }
    return '子任务结果'
  })
  await runEngineTurn(host)
  const helper = task.steps.find((s) => s.slot === 'sub')!
  assert.equal(helper.parentId, 'a/step/s1')
  assert.equal(helper.status, 'done')
  // wait 已经取回的结果不再重复并进节点输出
  assert.equal(task.steps.find((s) => s.id === 'a/step/s1')!.output, '一步结果')
})
