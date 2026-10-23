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

test('推送由父对话决定：子对话的提示词不问用户要不要推送，父对话侧仍按授权流程问一次', async () => {
  /** 跑一轮对话，拿回这次交给 CLI 的提示词 */
  const promptsOf = async (chat: Record<string, unknown>) => {
    const prompts: string[] = []
    const task = {
      ...newTask({ projectId: 'p', mode: 'chat', prompt: '把剩下的测试补完', ...chat } as never, undefined, '', 'kid'),
      id: 'kid',
    } as Task
    await runEngineTurn({
      task,
      agents,
      workflows: [],
      prompt: '把剩下的测试补完',
      // 项目设置是「第一次问」：这正是子对话以前会弹「要不要推送」的地方
      policy: { push: 'ask', tools: [] },
      // 有 messageParent 才有「收尾建议要交给用户选」那一段
      messageParent: async () => ({ ok: true, info: '' }),
      changed: () => {},
      newId: () => 'x',
      runAgent: async (call) => {
        prompts.push(call.prompt)
        return { ok: true, text: '好了' }
      },
    })
    return prompts
  }

  const child = await promptsOf({ parentTaskId: 'parent' })
  assert.equal(child.length, 1)
  assert.match(child[0], /由父对话决定，不在你的处理范围内/)
  assert.match(child[0], /不执行、不询问用户、也不写进提问、计划步骤或建议/)
  assert.match(child[0], /完成」就是改动已合回父对话所在的分支/, '完成只到「已合回父对话所在的分支」')
  assert.match(child[0], /不要写进计划步骤/, '合回父分支是收尾动作，不是计划里的一步')
  assert.match(child[0], /不要写「等推送 \/ 等合入其他分支 \/ 同步远端」/, '计划步骤里也不许写等推送')
  assert.doesNotMatch(child[0], /第一次需要推送时先用提问工具问用户一次/, '子对话不再问用户要不要推送')
  // 收尾建议的工具说明也写清了：只能写本地动作、remote 必须写 none
  assert.match(child[0], /remote 必须写/)

  const main = await promptsOf({})
  assert.equal(main.length, 1)
  assert.match(main[0], /第一次需要推送时先用提问工具问用户一次/, '父对话的授权规则保持不变')
  // 通用约束里的「安全边界」是所有角色都有的；这里只看授权情况那一段不会被子对话的写法盖掉
  assert.doesNotMatch(
    main[0],
    /## 授权情况[\s\S]{0,10}推送：推送、创建 PR、P4 submit、合并到主干由父对话决定，不在你的处理范围内/,
  )
})

test('搜索排除清单：项目设置里的目录写进提示词，找 Bug 也用同一份 globs', async () => {
  const prompts: string[] = []
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', prompt: '找一下这个报错' } as never, undefined, '', 's1'),
    id: 's1',
  } as Task
  await runEngineTurn({
    task,
    agents,
    workflows: [],
    prompt: '找一下这个报错',
    // 项目设置里填的（UE 预设）：提示词里要能直接照着拼 -g '!Saved'
    searchExclude: ['Saved', 'Intermediate'],
    changed: () => {},
    newId: () => 'x',
    runAgent: async (call) => {
      prompts.push(call.prompt)
      return { ok: true, text: '好了' }
    },
  })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /## 搜索排除（这个项目）/, '通用约束后面带上这个项目的排除清单')
  assert.match(prompts[0], /搜索时排除：[^\n]*Saved/)
  assert.match(prompts[0], /-g '!Saved'/, 'rg 的排除写法直接给出来')
  assert.match(prompts[0], /找 Bug 在这一层定位时也用同样的排除/, '找 Bug 那段用同一份清单')
  assert.match(prompts[0], /node_modules/, '内置默认清单也在（项目没填时至少挡住依赖和产物）')
})
