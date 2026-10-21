import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost } from '../shared/engine.ts'
import { currentRun, mainStep, topSteps } from '../shared/flow.ts'

/**
 * 常驻编排器：一个对话里只有一个主 Agent，它起停每一次运行。
 * 每次运行节点全部新建、按流程图顺序走，编排器的会话一直沿用。
 */
const agent = (id: string, name: string): Agent => ({
  ...AgentInput.parse({ name }),
  id,
  createdAt: '',
  updatedAt: '',
})
const agents = [agent('m', '主管'), agent('w', '开发')]

const workflow = (): Workflow =>
  Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: '常驻',
    mainAgentId: 'm',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'a', title: '实现', agentId: 'w', instructions: '写代码。' },
          { id: 'b', title: '验收', agentId: 'w', instructions: '验收。' },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'b' },
          { id: 'e3', from: 'b', to: 'end' },
        ],
      },
    ],
  })

/** 主 Agent 每次调度按 dispatch 里写的回答，用来驱动「第一轮跑完 → 用户提新要求 → 起第二次运行」 */
function host(task: Task, log: AgentCall[], decide: string[]): EngineHost {
  const w = workflow()
  let n = 0
  return {
    task,
    agents,
    workflows: [w],
    workflow: w,
    prompt: '做功能',
    changed: () => {},
    newId: () => `id${++n}`,
    runAgent: async (call) => {
      log.push(call)
      if (call.dispatching === 'evaluate') return { ok: true, text: '```dispatch\n{"action":"continue"}\n```' }
      if (call.dispatching === 'summary') return { ok: true, text: '这次的结果' }
      if (call.dispatching === 'plan')
        return { ok: true, text: decide.shift() ?? '```dispatch\n{"action":"answer"}\n```' }
      return { ok: true, text: `${call.step?.title}好了` }
    },
  }
}

test('常驻编排器：第一次要求跑一次运行，新要求起第二次运行，节点全部新建、编排器会话沿用', async () => {
  const w = workflow()
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, w, '', 't'),
    id: 't',
  } as Task
  const log: AgentCall[] = []
  const h = host(task, log, [
    '```dispatch\n{"action":"run","input":"做功能"}\n```',
    '```dispatch\n{"action":"run","input":"再补充一个接口"}\n```',
  ])

  // 第一条要求先交给编排器分析，由它起第一次运行
  await runEngineTurn(h)
  assert.equal(log[0].dispatching, 'plan')
  assert.match(log[0].prompt, /第一条要求/)
  assert.match(log[0].prompt, /做功能/)
  assert.equal(currentRun(task), 1)
  assert.deepEqual(
    topSteps(task).map((s) => s.id),
    ['a', 'b'],
  )
  assert.ok(topSteps(task).every((s) => s.status === 'done'))
  // 编排器补的要求作为第一次运行的输入交给第一个节点
  assert.match(log.find((c) => c.step?.id === 'a')!.prompt, /## 输入\n做功能/)

  // 用户提新要求：这次运行已经走完，交给编排器决定，它起第二次运行
  h.prompt = '再补充一个接口'
  await runEngineTurn(h)
  assert.equal(currentRun(task), 2)
  // 上一次运行的节点还在（记录保留），这一次是新的一批，id 带 r2/ 前缀
  assert.deepEqual(
    topSteps(task).map((s) => s.id),
    ['r2/a', 'r2/b'],
  )
  assert.ok(topSteps(task).every((s) => s.status === 'done'))
  assert.equal(task.steps.filter((s) => s.id === 'a' || s.id === 'r2/a').length, 2, '两次运行的节点互相隔离')
  // 编排器只有一个，会话一直沿用
  const mains = task.steps.filter((s) => s.kind === 'main')
  assert.equal(mains.length, 1)
  assert.equal(mainStep(task)?.id, '@main')
  const plans = log.filter((c) => c.dispatching === 'plan')
  assert.equal(plans.length, 2)
  assert.ok(plans.every((c) => c.sessionKey === '@main'))
  // 编排器的第二轮决策用到了上一次运行的结果小结
  assert.match(plans[1].prompt, /再补充一个接口/)
  assert.match(plans[1].prompt, /已经走完/)
})

test('常驻编排器：不是新对话时直接按流程图执行，不再先问一遍', async () => {
  const w = workflow()
  // 单个主 Agent 自己做的工作流没有调度，不需要先让编排器分析
  const flow = w.flows[0]
  const single = {
    ...w,
    flows: [
      {
        ...flow,
        nodes: [{ ...flow.nodes[0], agentId: 'm' }],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'end' },
        ],
      },
    ],
  }
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, single, '', 't3'),
    id: 't3',
  } as Task
  const log: AgentCall[] = []
  const h = host(task, log, ['```dispatch\n{"action":"answer"}\n```'])
  h.workflow = single
  h.workflows = [single]
  await runEngineTurn(h)
  assert.equal(log.filter((c) => c.dispatching === 'plan').length, 0)
  assert.deepEqual(
    topSteps(task).map((s) => s.id),
    ['a'],
  )
})

test('常驻编排器：第一条要求只是问问题就不起运行', async () => {
  const w = workflow()
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '这个项目用什么语言' } as never, w, '', 't4'),
    id: 't4',
  } as Task
  const log: AgentCall[] = []
  const h = host(task, log, ['这个项目用的是 TypeScript。\n```dispatch\n{"action":"answer"}\n```'])
  h.prompt = '这个项目用什么语言'
  await runEngineTurn(h)
  assert.equal(currentRun(task), 1, '没有起运行')
  assert.ok(
    topSteps(task).every((s) => s.status === 'pending'),
    '没有执行流程节点',
  )
  assert.match(mainStep(task)!.output, /TypeScript/)
  assert.equal(log.filter((c) => c.dispatching === 'plan').length, 1)
  assert.ok(!log.some((c) => c.step && c.step.kind !== 'main'), '没有执行流程节点')
})
