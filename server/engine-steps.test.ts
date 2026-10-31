import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentInput, Workflow, type Agent, type StopReason, type Task } from '../shared/schema.ts'
import { newTask, stopReasonText } from '../shared/task.ts'
import { retryBase, runEngineTurn, stopHelper, type AgentCall, type EngineHost } from '../shared/engine.ts'
import { t } from '../shared/i18n.ts'

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

type Failed = { ok: false; stopped?: boolean; error: string }

function makeHost(
  w: Workflow,
  reply: (call: AgentCall) => string | Promise<string | Failed> | Failed,
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

test('多步骤节点：步骤派出的子 Agent 挂在步骤记录下，一次派多个全部同时开跑、不排队', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  // 以前整个任务同时最多跑 6 个、多的排队（用户 2026-10-29 要求去掉）：派 8 个，每个都等到 8 个全开跑才结束，
  // 还有排队的话凑不齐，3 秒后放行并判失败
  const N = 8
  let started = 0
  let timedOut = false
  let release!: () => void
  const all = new Promise<void>((r) => (release = r))
  const timer = setTimeout(() => {
    timedOut = true
    release()
  }, 3000)
  const { task, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const ids = call.orch!.spawn(
        Array.from({ length: N }, (_, i) => ({ title: `子任务 ${i + 1}`, instructions: '帮我查一下' })),
      ).ids
      assert.equal(ids.length, N)
      await call.orch!.wait(ids, 5000)
      return '一步结果'
    }
    if (++started === N) release()
    await all
    return '子任务结果'
  })
  await runEngineTurn(host)
  clearTimeout(timer)
  assert.ok(!timedOut, `${N} 个子任务应同时开跑，不该排队等前面的做完`)
  const helpers = task.steps.filter((s) => s.slot === 'sub')
  assert.equal(helpers.length, N)
  for (const helper of helpers) {
    assert.equal(helper.parentId, 'a/step/s1')
    assert.equal(helper.status, 'done')
  }
  // wait 已经取回的结果不再重复并进节点输出
  assert.equal(task.steps.find((s) => s.id === 'a/step/s1')!.output, '一步结果')
})

test('终止或抛异常的子任务只收它自己：终止的按「已终止」、抛异常的按失败交回，别的子任务和节点照常做完', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  let report = ''
  const { task, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const ids = call.orch!.spawn([
        { title: '慢的', instructions: '一直查' },
        { title: '快的', instructions: '查一下' },
        // 启动 CLI 前抛异常的：以前停在执行中、终止又说已经结束了，等它的节点也跟着抛错
        { title: '坏的', instructions: '查一下' },
      ]).ids
      // 子任务都开始以后再终止「慢的」（界面上的按钮走的就是 stopHelper）
      await new Promise((r) => setTimeout(r, 10))
      const r = call.orch!.stopHelpers([ids[0]], '方向错了')
      assert.equal(r.ok, true)
      assert.match(r.info, /已终止 1 个子任务/)
      assert.equal(stopHelper('t', ids[0], '再停一次'), false, '已经停了的不能再停')
      const got = await call.orch!.wait(ids, 1000)
      report = JSON.stringify(got.done)
      return '一步结果'
    }
    if (call.step?.title === '慢的') {
      // 模拟一直在跑的 CLI：直到这一次调用自己的信号被触发
      await new Promise<void>((r) => call.signal?.addEventListener('abort', () => r(), { once: true }))
      return { ok: false as const, stopped: true, error: '已停止' }
    }
    if (call.step?.title === '坏的') throw new Error('配置文件被占用')
    return '快的结果'
  })
  await runEngineTurn(host)
  const slow = task.steps.find((s) => s.title === '慢的')!
  const fast = task.steps.find((s) => s.title === '快的')!
  const bad = task.steps.find((s) => s.title === '坏的')!
  assert.equal(slow.status, 'skipped')
  assert.equal(fast.status, 'done')
  assert.equal(bad.status, 'failed')
  assert.ok(bad.endedAt)
  assert.equal(task.steps.find((s) => s.id === 'a')!.status, 'done')
  assert.match(report, /已终止：方向错了/)
  assert.match(report, /配置文件被占用/, '失败原因交回给派它的节点')
  assert.ok(
    task.messages.some((m) => m.step === bad.id && m.error && m.text.includes('配置文件被占用')),
    '报错显示在子任务里',
  )
})

test('推送由父对话决定：子对话的提示词不问用户要不要推送，父对话侧仍按授权流程问一次', async () => {
  /** 跑一轮对话，拿回这次交给 CLI 的提示词 */
  const promptsOf = async (
    chat: Record<string, unknown>,
    extra: Partial<EngineHost> = {},
    /** 任务上 newTask 给不出的字段（worktree 这类运行时状态） */
    patch: Record<string, unknown> = {},
  ) => {
    const prompts: string[] = []
    const task = {
      ...newTask({ projectId: 'p', mode: 'chat', prompt: '把剩下的测试补完', ...chat } as never, undefined, '', 'kid'),
      id: 'kid',
      ...patch,
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
      ...extra,
    })
    return prompts
  }

  const child = await promptsOf({ parentTaskId: 'parent', askUser: true }, { wrapUp: 'merge' })
  assert.equal(child.length, 1)
  assert.match(child[0], /由父对话决定，不在你的处理范围内/)
  assert.match(child[0], /不执行、不询问用户、也不写进提问、计划步骤或建议/)
  assert.match(child[0], /完成」就是改动已合回父对话所在的分支/, '完成只到「已合回父对话所在的分支」')
  assert.match(child[0], /面板会自动列成计划的最后一步，不要自己再写一步/, '合回父分支由面板列成计划的最后一步')
  assert.match(child[0], /## 收尾：计划的最后一步[\s\S]*submit_merge/)
  // P4 工作区：收尾是按文件类型分 changelist，不是合回分支
  const p4 = await promptsOf({ parentTaskId: 'parent' }, { wrapUp: 'p4' })
  assert.match(p4[0], /完成」就是改动已按文件类型分进各自的 pending changelist/)
  assert.match(p4[0], /\[C\+\+\][\s\S]*\[XLSX\][\s\S]*\[Lua\][\s\S]*\[Other\]/)
  assert.match(p4[0], /不能全留在 default，也不能把几类放进同一个/)
  // 有面板的分 changelist 工具时交给它分；父对话自己放 CL 也要守同一套规则（曾经建出「[C++/Lua] …」）
  const p4Tool = await promptsOf(
    { parentTaskId: 'parent' },
    { wrapUp: 'p4', p4Split: async () => ({ ok: true, info: '' }) },
  )
  assert.match(p4Tool[0], /调用 p4_split_changelists 分/)
  const p4Main = await promptsOf({}, { p4Split: async () => ({ ok: true, info: '' }) })
  assert.match(p4Main[0], /## P4 changelist[\s\S]*调用 p4_split_changelists 分/)
  assert.match(p4Main[0], /不对整个工作区跑/, '大项目里不做整个工作区的 p4 扫描')
  assert.doesNotMatch(p4[0], /## P4 changelist/, '子对话的收尾已经写了，不重复一段')
  // 共用父对话目录的 Git 子对话没有收尾这一步
  const shared = await promptsOf({ parentTaskId: 'parent' })
  assert.doesNotMatch(shared[0], /## 收尾：计划的最后一步/)
  assert.match(child[0], /不要写「等推送 \/ 等合入其他分支 \/ 同步远端」/, '计划步骤里也不许写等推送')
  assert.doesNotMatch(child[0], /用提问工具问用户一次要不要推送/, '子对话不再问用户要不要推送')
  // 收尾建议的工具说明也写清了：只能写本地动作、remote 必须写 none
  assert.match(child[0], /remote 必须写/)
  assert.match(child[0], /问题会交给父对话（父对话开着「提问」时再转给用户）/)
  // 子对话没开「提问」：问题和收尾建议都自己决定，不要求提问、也不要求 suggest_next_step
  const solo = await promptsOf({ parentTaskId: 'parent', askUser: false }, { wrapUp: 'merge' })
  assert.match(solo[0], /## 「提问」关着：自己决定/)
  assert.doesNotMatch(solo[0], /## 停下之前先提问|## 收尾建议要交给用户选/)
  assert.match(solo[0], /## 子对话的完成标准/)

  const main = await promptsOf({})
  assert.equal(main.length, 1)
  assert.match(
    main[0],
    /第一次需要推送时问一次」。任务做完、验证通过并在本地提交之后，用提问工具问用户一次要不要推送并合并主干/,
    '父对话的授权规则：问一次时把合并主干也算进这次授权',
  )
  // 通用约束里的「安全边界」是所有角色都有的；这里只看授权情况那一段不会被子对话的写法盖掉
  assert.doesNotMatch(
    main[0],
    /## 授权情况[\s\S]{0,10}推送：推送、创建 PR、P4 submit、合并到主干由父对话决定，不在你的处理范围内/,
  )

  // 三个选项要有不同的效果：只写「可以推送」时，模型照技能里的「本地先行」只做本地提交，选什么都一样
  const allow = await promptsOf({}, { policy: { push: 'allow', tools: [] } })
  assert.match(
    allow[0],
    /允许直接推送」，这就是用户的授权，不用再问。任务做完、验证通过并在本地提交之后就把当前分支推到它跟踪的远端分支/,
  )
  assert.match(allow[0], /比角色设定、技能里「不推送 \/ 本地先行 \/ 创建 PR 和合并主干要用户明确授权」的默认写法优先/)
  // 允许推送 = 授权里默认包含「推送成功后用 gh 普通合并到主干」，不再要求用户每次单独说「合并到主干」
  assert.match(allow[0], /推送成功后用 GitHub CLI 把该分支普通合并到主干/)
  assert.match(allow[0], /gh pr create --base <主干> --head <当前分支>/, '已有 PR 就复用，没有就新建')
  assert.match(allow[0], /gh pr merge <PR> --merge/, '等检查通过后普通合并')
  assert.match(allow[0], /不 --admin、不绕过检查/, '不强制合并')
  assert.match(allow[0], /也不直接往主干推/, '失败就停，不直接往主干推')
  assert.match(allow[0], /defaultBranchRef/, '主干名从仓库默认分支取，不写死 main')
  assert.doesNotMatch(allow[0], /本仓库是 main/)
  // 有推送收尾时（父对话、Git 仓库有远端）：只让模型照着计划的最后一步做，不另写一条重复的推送步骤
  const allowWrap = await promptsOf({}, { policy: { push: 'allow', tools: [] }, wrapUp: 'push' })
  assert.match(
    allowWrap[0],
    /收尾：推送到远端并合并主干已经在计划的最后一步（面板已经列好，刷新也不会变），照着它做，不要自己再写一条/,
  )
  assert.match(allowWrap[0], /## 收尾：计划的最后一步[\s\S]*推送并合并成功后把这步标完成/)
  assert.match(
    allowWrap[0],
    /由面板加在最后，别删、别挪到前面，也不要自己再写一条重复的收尾步骤/,
    '计划那段也要讲清收尾由面板加',
  )
  // 「定位」段只在真正的父对话（coordinator）里注入，这里构造不出来；
  // 它和授权段读同一个 wrapKind(host)，由复看确认
  assert.doesNotMatch(allow[0], /收尾：推送到远端并合并主干已经在计划的最后一步/, '没有推送收尾时不提这一步')
  // 父对话在独立分支里：推送收尾和「执行目录」那段要一致（先合回原分支再推并合并，不直接推独立分支）
  const allowWt = await promptsOf(
    {},
    { policy: { push: 'allow', tools: [] }, wrapUp: 'push' },
    { worktree: { state: 'active', branch: 'agent-panel/x', path: '/tmp/wt', baseBranch: 'dev' } },
  )
  assert.match(allowWt[0], /计划的最后一步是「收尾：推送到远端并合并主干」：那时先把它合回原分支/)
  assert.match(allowWt[0], /推送归计划的最后一步「收尾：推送到远端并合并主干」：合回原分支之后推送原分支并合并主干/)
  assert.doesNotMatch(allowWt[0], /提交留在这个分支上，由用户决定合并还是丢弃/, '和推送收尾不矛盾')
  // 明确不推送（'none'）：计划里不提收尾这一段，也不提 gh 合并
  const none = await promptsOf({}, { policy: { push: 'deny', tools: [] }, wrapUp: 'none' })
  assert.doesNotMatch(none[0], /## 收尾：计划的最后一步/)
  assert.doesNotMatch(none[0], /gh pr create/)
  // 子对话的推送收尾不成立：子对话永远不碰远端，提示词里不出现 gh 合并流程
  const childWrap = await promptsOf(
    { parentTaskId: 'parent' },
    { policy: { push: 'allow', tools: [] }, wrapUp: 'push' },
  )
  assert.match(childWrap[0], /由父对话决定，不在你的处理范围内/)
  assert.doesNotMatch(childWrap[0], /gh pr create/)
  assert.doesNotMatch(childWrap[0], /完成标准是改动已推送到远端并合并到主干/, '收尾建议段也按 wrapKind 过滤')
  const deny = await promptsOf({}, { policy: { push: 'deny', tools: [] } })
  assert.match(deny[0], /不推送，只做本地提交」。不 push/)
  assert.match(deny[0], /不建 PR、不合并主干/)
  assert.doesNotMatch(deny[0], /用提问工具问用户一次要不要推送/)
  assert.doesNotMatch(deny[0], /gh pr create/)
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
  assert.match(prompts[0], /-g '!Saved\/'/, 'rg 的排除写法直接给出来')
  assert.match(prompts[0], /-g '!node_modules\/'/, '不是 Git 仓库时 rg 要带整份清单')
  assert.match(prompts[0], /find <目录> -maxdepth 4 \\\( -type d \\\( -name 'Saved'/, 'find 的剪枝也直接给出来')
  assert.match(prompts[0], /找 Bug 在这一层定位时也用同样的排除/, '找 Bug 那段用同一份清单')
  assert.match(prompts[0], /node_modules/, '内置默认清单也在（项目没填时至少挡住依赖和产物）')
})

test('搜索排除清单：Git 仓库里 rg 只补项目自己填的目录，并提醒别加 --no-ignore', async () => {
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
    searchExclude: ['Saved'],
    searchInGit: true,
    changed: () => {},
    newId: () => 'x',
    runAgent: async (call) => {
      prompts.push(call.prompt)
      return { ok: true, text: '好了' }
    },
  })
  const part = prompts[0].slice(prompts[0].indexOf('## 搜索排除（这个项目）'))
  assert.match(part, /不要加 `--no-ignore`/)
  assert.match(part, /`rg -g '!Saved\/' <关键字> <目录>`/, 'rg 只带项目填的，内置默认交给 .gitignore')
  assert.doesNotMatch(part.split('\n## ')[0], /-g '!node_modules\/'/)
  // find 不读 .gitignore，Git 仓库里也要整份剪枝
  assert.match(part, /-name 'node_modules'/)
})

/**
 * 跑一轮对话，runAgent 返回「被停止」：克隆出用户截图里那种「CLI 已经答完、面板才把它收掉」的场景
 * （answered=true 时先写 turnDoneAt，等于 runner 已经报过这一轮完成），以及真的没答完就被停掉。
 */
const stoppedChatTurn = async (opts: { answered: boolean; reason: StopReason }) => {
  const task = {
    ...newTask({ projectId: 'p', mode: 'chat', prompt: '做完收尾' } as never, undefined, '', 'kid'),
    id: 'kid',
    parentTaskId: 'parent',
  } as Task
  await runEngineTurn({
    task,
    agents,
    workflows: [],
    prompt: '做完收尾',
    stopReason: () => opts.reason,
    changed: () => {},
    newId: () => 'x',
    runAgent: async () => {
      // 这一轮已经答完：CLI 报过完成、停在等下一句，之后才被合并回收 / 收尾停掉
      if (opts.answered) task.turnDoneAt = new Date().toISOString()
      return { ok: false, stopped: true, error: '已停止' }
    },
  })
  return task
}

test('这一轮已经答完才被收掉：不写「这一轮被中断」，这一轮和任务都是完成', async () => {
  const task = await stoppedChatTurn({ answered: true, reason: 'finish' })
  assert.equal(task.turns.at(-1)?.status, 'done', '这一轮记成完成，不是停止')
  assert.equal(task.status, 'done', '任务状态不被改成 stopped')
  assert.equal(task.stopReason, undefined, '不记停止原因（界面就不会挂「被中断」）')
  // 这一轮答完了，finish 不该写任何系统提示（「这一轮被中断」「已暂停」都是 t() 出来的，这里不看具体语言）
  assert.ok(!task.messages.some((m) => m.role === 'system'), '既没有「这一轮被中断」，也没有「已暂停」')
})

test('真停止：用户自己暂停不写提示行，别的来源（父对话收尾、面板重启之类）照旧写中断说明', async () => {
  const paused = await stoppedChatTurn({ answered: false, reason: 'user' })
  assert.equal(paused.turns.at(-1)?.status, 'stopped')
  assert.equal(paused.status, 'stopped')
  assert.equal(paused.stopReason, 'user')
  // 用户自己按的暂停不写提示行：输入框旁已经有「继续执行」按钮
  assert.ok(!paused.messages.some((m) => m.role === 'system'), '暂停后不再显示「已暂停。点「继续执行」…」')

  // 父对话结束时一起结束、而这一轮没答完：是真的中断，要说清是谁结束的
  const byParent = await stoppedChatTurn({ answered: false, reason: 'parent' })
  assert.equal(byParent.turns.at(-1)?.status, 'stopped')
  assert.equal(byParent.status, 'stopped')
  assert.equal(byParent.stopReason, 'parent')
  assert.ok(
    byParent.messages.some(
      (m) =>
        m.text ===
        t('这一轮被中断：{reason}。{next}从中断的地方接着做，或者在下面输入新的要求。', {
          reason: stopReasonText('parent'),
          next: t('点「继续执行」'),
        }),
    ),
    '原因写成「父对话结束时一起结束」，用户看得出是谁结束的',
  )
})

test('彻底完成后面板收掉进程（finish）：CLI 没来得及报完成也是正常结束，不写「这一轮被中断」', async () => {
  // 用户截图：子对话收尾时显示「这一轮被中断：做完后收尾」。finish 只在子对话彻底完成后才会发，活已经干完了
  const finished = await stoppedChatTurn({ answered: false, reason: 'finish' })
  assert.equal(finished.turns.at(-1)?.status, 'done')
  assert.equal(finished.status, 'done')
  assert.equal(finished.stopReason, undefined)
  assert.ok(!finished.messages.some((m) => m.role === 'system'), '没有任何中断说明')
})

test('子任务：resume 接着之前那个子任务的会话，复看的评审不用从头再读（ADR 0009）', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  const errors: (string | undefined)[] = []
  const { task, log, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const o = call.orch!
      const first = o.spawn([{ title: '评审', instructions: '看全量 diff', agent: '验收' }]).ids
      await o.wait(first, 1000)
      // 换了角色不能接；不存在的 id 也不能接
      errors.push(o.spawn([{ title: '复看', instructions: '增量', agent: '开发', resume: first[0] }]).error)
      errors.push(o.spawn([{ title: '复看', instructions: '增量', resume: 'nope' }]).error)
      const again = o.spawn([{ title: '复看', instructions: '只看增量', resume: first[0] }]).ids
      await o.wait(again, 1000)
      return '一步结果'
    }
    return '验收结论：通过'
  })
  await runEngineTurn(host)
  const subs = task.steps.filter((s) => s.slot === 'sub')
  assert.equal(subs.length, 2)
  assert.equal(subs[1].session, subs[0].id, '复看记下接着的是哪个会话')
  assert.equal(subs[1].agentId, 'v', '不写 agent 时沿用上一次的角色')
  const calls = log.filter((c) => c.step?.slot === 'sub')
  assert.deepEqual(
    calls.map((c) => c.sessionKey),
    [subs[0].id, subs[0].id],
  )
  assert.match(calls[1].prompt, /之前那个会话的延续/)
  assert.match(errors[0] ?? '', /另一个角色/)
  assert.match(errors[1] ?? '', /不是你派过的子任务/)
})

test('子任务：resume 少写了前缀时按 id 结尾唯一匹配，接着原来的会话跑', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  const { task, log, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const o = call.orch!
      const first = o.spawn([{ title: '查资料', instructions: '查一下' }]).ids
      await o.wait(first, 1000)
      // 模型常把「a/step/s1/sub/h1」写成「sub/h1」：唯一命中就照常接着跑，不该整批失败
      const again = o.spawn([{ title: '复看', instructions: '再看一次', resume: 'sub/h1' }]).ids
      assert.equal(again.length, 1, '唯一后缀命中的那条照常派出去')
      await o.wait(again, 1000)
      return '一步结果'
    }
    return '查到了'
  })
  await runEngineTurn(host)
  const subs = task.steps.filter((s) => s.slot === 'sub')
  assert.equal(subs.length, 2)
  assert.equal(subs[1].session, subs[0].id, '接着的是原来那条子任务的会话')
  const calls = log.filter((c) => c.step?.slot === 'sub')
  assert.deepEqual(
    calls.map((c) => c.sessionKey),
    [subs[0].id, subs[0].id],
  )
})

test('子任务：resume 的后缀能命中多个会话时拒绝，并列出候选', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  let error = ''
  const { task, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const o = call.orch!
      const first = o.spawn([
        { title: '查资料', instructions: '查一下' },
        { title: '查规范', instructions: '查规范' },
      ]).ids
      await o.wait(first, 1000)
      // 两条记录的 id 都以「/sub/h1」结尾（旧数据里层级不同）：不猜，报错列出候选
      task.steps.find((s) => s.id === first[1])!.id = 'old/a/step/s1/sub/h1'
      error = o.spawn([{ title: '接着做', instructions: '继续', resume: 'sub/h1' }]).error ?? ''
      return '一步结果'
    }
    return '查到了'
  })
  await runEngineTurn(host)
  assert.match(error, /多个/)
  assert.match(error, /a\/step\/s1\/sub\/h1/, '报错里列出第一个候选的 id')
  assert.match(error, /old\/a\/step\/s1\/sub\/h1/, '报错里列出第二个候选的 id')
  assert.match(error, /查资料/)
  assert.match(error, /查规范/)
})

test('子任务：resume 的后缀不跨路径段匹配（xsub/h1 不算 sub/h1）', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  let error = ''
  const { task, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const o = call.orch!
      const first = o.spawn([{ title: '查资料', instructions: '查一下' }]).ids
      await o.wait(first, 1000)
      // 只有段边界上的结尾才算：「a/xsub/h1」不是「sub/h1」
      task.steps.find((s) => s.id === first[0])!.id = 'a/xsub/h1'
      error = o.spawn([{ title: '接着做', instructions: '继续', resume: 'sub/h1' }]).error ?? ''
      return '一步结果'
    }
    return '查到了'
  })
  await runEngineTurn(host)
  assert.match(error, /不是你派过的子任务/)
  assert.match(error, /a\/xsub\/h1/, '列表里给的是它真实的 id')
})

test('子任务：resume 找不到时，报错里列出你实际派过的子任务', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  let error = ''
  const { host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const o = call.orch!
      const first = o.spawn([{ title: '查资料', instructions: '查一下' }]).ids
      await o.wait(first, 1000)
      error = o.spawn([{ title: '复看', instructions: '继续', resume: 'sub/h9' }]).error ?? ''
      return '一步结果'
    }
    return '查到了'
  })
  await runEngineTurn(host)
  assert.match(error, /不是你派过的子任务/)
  assert.match(error, /用 spawn_agents 返回的 id/)
  assert.match(error, /a\/step\/s1\/sub\/h1/, '给出实际派过的 id，模型下一轮能直接改正')
  assert.match(error, /查资料/, '带上标题，方便对上哪一条')
})

test('子任务：失败后 resume 写它的 id，就在原来那个子任务里重试，不另起一个（用户 2026-10-25）', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  let tries = 0
  let firstWait: unknown
  const { task, log, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const o = call.orch!
      const first = o.spawn([{ title: '查资料', instructions: '查一下' }]).ids
      firstWait = await o.wait(first, 1000)
      const again = o.spawn([{ title: '查资料', instructions: '再查一次', resume: first[0] }]).ids
      assert.deepEqual(again, first, '重试返回的还是原来的 id')
      await o.wait(again, 1000)
      return '一步结果'
    }
    if (call.step?.slot === 'sub') {
      tries++
      if (tries === 1) return { ok: false, error: '连接断开' }
      return '查到了'
    }
    return '验收结论：通过'
  })
  await runEngineTurn(host)
  const subs = task.steps.filter((s) => s.slot === 'sub')
  assert.equal(subs.length, 1, '只有一条子任务记录')
  assert.equal(subs[0].status, 'done')
  assert.equal(subs[0].output, '查到了')
  assert.equal(subs[0].reruns, 1)
  assert.match(subs[0].brief, /再查一次/)
  const calls = log.filter((c) => c.step?.slot === 'sub')
  assert.deepEqual(
    calls.map((c) => c.sessionKey),
    [subs[0].id, subs[0].id],
    '用的是原来那个会话',
  )
  assert.match(calls[1].prompt, /这是重试[\s\S]*连接断开/)
  assert.match(JSON.stringify(firstWait), /failed/)
})

test('子对话重试标记：去掉「（重试）」这类标记后和原标题一样', () => {
  assert.equal(retryBase('子对话子任务挪到总结下面（重试）'), '子对话子任务挪到总结下面')
  assert.equal(retryBase('修登录 (retry 2)'), '修登录')
  assert.equal(retryBase('修登录 - 重试'), '修登录')
  assert.equal(retryBase('修登录'), '修登录')
})

test('子任务：输出超过交接上限时完整内容存成文件，不再只截开头', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  const long = `验收结论：不通过\n${'🛑 R1 一条很长的意见。'.repeat(500)}\n🛑 R9 最后一条`
  const saved: string[] = []
  const { task, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const ids = call.orch!.spawn([{ title: '评审', instructions: '看 diff' }]).ids
      await call.orch!.wait(ids, 1000)
      return '一步结果'
    }
    return long
  })
  host.saveHandoff = async (_step, text) => {
    saved.push(text)
    return '/tmp/handoff/h1.md'
  }
  await runEngineTurn(host)
  const sub = task.steps.find((s) => s.slot === 'sub')!
  assert.equal(saved[0], long, '完整输出交给 saveHandoff')
  assert.match(sub.output, /完整内容在文件 \/tmp\/handoff\/h1\.md/)
  assert.ok(sub.output.startsWith('验收结论：不通过'))
})

test('子任务：被停止时标成打断，不像没开始过', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  const { task, host } = makeHost(w, (call) => {
    if (call.step?.id === 'a/step/s1') {
      const ids = call.orch!.spawn([{ title: '评审', instructions: '看 diff' }]).ids
      return call.orch!.wait(ids, 1000).then(() => '一步结果')
    }
    return { ok: false as const, stopped: true, error: '' }
  })
  await runEngineTurn(host)
  const sub = task.steps.find((s) => s.slot === 'sub')!
  assert.equal(sub.status, 'pending')
  assert.equal(sub.interrupted, true)
})

test('子任务：派「评审」时面板把改动附进提示词，复看只附上一轮之后的增量', async () => {
  const w = workflow([{ id: 's1', title: '一步', instructions: '一。' }])
  const since: (string | undefined)[] = []
  const { task, log, host } = makeHost(w, async (call) => {
    if (call.step?.id === 'a/step/s1') {
      const o = call.orch!
      const bare = o.spawn([{ title: '评审', instructions: '看改动', agent: '评审' }])
      assert.equal(bare.ids.length, 0, '第一次评审没带交接单要拒绝')
      assert.match(bare.error!, /goal（需求和验收标准）、checks/)
      const first = o.spawn([
        {
          title: '评审',
          instructions: '看改动',
          agent: '评审',
          review: { goal: '按钮改成蓝色', checks: 'npm run typecheck：通过', focus: '暗色主题', files: ['a.ts'] },
        },
      ]).ids
      await o.wait(first, 1000)
      const again = o.spawn([{ title: '复看', instructions: '处置：R1 已修', resume: first[0] }]).ids
      await o.wait(again, 1000)
      return '一步结果'
    }
    return '验收结论：通过\n必须处置：无'
  })
  host.agents = [...agents, { ...agent('r', '评审'), origin: 'builtin:reviewer' }]
  let n = 0
  const scoped: (string[] | undefined)[] = []
  host.reviewDiff = async (s, files) => {
    since.push(s)
    scoped.push(files)
    n++
    return { snapshot: `tree${n}`, stat: ' a.ts | 2 +-', diff: `@@ 第 ${n} 次的差异 @@` }
  }
  await runEngineTurn(host)
  assert.deepEqual(since, [undefined, 'tree1'], '复看和上一轮的快照比')
  assert.deepEqual(scoped, [['a.ts'], undefined], '交接单点名的文件只取它们的差异')
  const calls = log.filter((c) => c.step?.slot === 'sub')
  assert.match(calls[0].prompt, /这次的全部改动/)
  // ADR 0013：对话整理的交接单写进评审的提示词；只评 + / - 的行；动手角色的段落不给评审
  assert.match(calls[0].prompt, /## 评审交接单（派你的对话整理）/)
  assert.match(calls[0].prompt, /### 要达成什么、验收标准\n按钮改成蓝色/)
  assert.match(calls[0].prompt, /### 已经跑过的检查\nnpm run typecheck：通过/)
  assert.match(calls[0].prompt, /只评以 \+ \/ - 开头的行/)
  assert.doesNotMatch(calls[0].prompt, /## 通用要求/, '评审不带写给动手角色的通用要求')
  assert.match(calls[0].prompt, /第 1 次的差异/)
  assert.match(calls[1].prompt, /上一轮评审之后的增量/)
  assert.match(calls[1].prompt, /第 2 次的差异/)
  assert.deepEqual(
    task.steps.filter((s) => s.slot === 'sub').map((s) => s.snapshot),
    ['tree1', 'tree2'],
  )
})
