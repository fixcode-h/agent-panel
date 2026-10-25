import { childReport } from './task.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlanStep, Task, TaskPlan } from './schema.ts'
import {
  activePlan,
  applyPlan,
  bindRun,
  bindWait,
  endRun,
  finishPlan,
  holdWait,
  markWrapUp,
  openPlan,
  planProgress,
  planSpan,
  refreshChildWait,
  runningStepId,
  childStepId,
  settleWait,
  syncKids,
  unsummarized,
} from './plan.ts'

const fresh = () => ({ plans: [], steps: [] }) as unknown as Pick<Task, 'plans' | 'steps'>

test('列计划：两层、自动编号，返回带 id 的计划', () => {
  const task = fresh()
  const r = applyPlan(task, {
    title: '登录页改版',
    steps: [
      { title: '改界面', status: 'running', children: [{ title: '改布局' }, { title: '改文案' }] },
      { title: '跑测试' },
    ],
  })
  assert.ok(r.ok)
  const plan = activePlan(task)!
  assert.equal(plan.title, '登录页改版')
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ['1', '2'],
  )
  assert.deepEqual(
    plan.steps[0].children.map((c) => c.id),
    ['1.1', '1.2'],
  )
  assert.match(r.info, /1\.2 改文案/)
})

test('完成的步骤锁死：改它、删它都无效，放回原位', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A', status: 'done' }, { title: 'B' }, { title: 'C' }] })
  const r = applyPlan(task, {
    steps: [
      { id: '2', title: 'B', status: 'running' },
      { id: '1', title: 'A', status: 'pending' },
    ],
  })
  const plan = activePlan(task)!
  assert.deepEqual(
    plan.steps.map((s) => [s.title, s.status]),
    [
      ['B', 'running'],
      ['A', 'done'],
    ],
  )
  assert.match(r.info, /已经完成，不再改动：「A」/)
  assert.match(r.info, /已从计划里去掉：「C」/)
  // 漏写的完成项也留着
  applyPlan(task, { steps: [{ id: '2', title: 'B' }] })
  assert.ok(activePlan(task)!.steps.some((s) => s.title === 'A' && s.status === 'done'))
})

test('只交变更步骤（partial）：没写到的未完成步骤留在计划里，顺序不变', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: '改代码', status: 'running', children: [{ title: '改前端' }, { title: '改后端' }] },
      { title: '跑测试' },
      { title: '写文档' },
    ],
  })
  // 只更新第二步：其余步骤留在原位，也不提示「已从计划里去掉」
  const r = applyPlan(task, { partial: true, steps: [{ id: '2', title: '跑测试', status: 'done' }] })
  assert.ok(r.ok)
  assert.doesNotMatch(r.info, /已从计划里去掉/)
  assert.deepEqual(
    activePlan(task)!.steps.map((s) => [s.id, s.title, s.status]),
    [
      ['1', '改代码', 'running'],
      ['2', '跑测试', 'done'],
      ['3', '写文档', 'pending'],
    ],
  )
  // 子步骤同样：只交一个子步骤，另一个留着
  applyPlan(task, {
    partial: true,
    steps: [{ id: '1', title: '改代码', children: [{ id: '1.1', title: '改前端', status: 'done' }] }],
  })
  assert.deepEqual(
    activePlan(task)!.steps[0].children.map((c) => [c.id, c.status]),
    [
      ['1.1', 'done'],
      ['1.2', 'pending'],
    ],
  )
  // 新加的步骤照常追加在最后
  applyPlan(task, { partial: true, steps: [{ title: '补 e2e' }] })
  assert.deepEqual(
    activePlan(task)!.steps.map((s) => s.title),
    ['改代码', '跑测试', '写文档', '补 e2e'],
  )
  // 不带 partial 时照旧：没写到的未完成步骤算删掉
  const r2 = applyPlan(task, { steps: [{ id: '2', title: '跑测试', status: 'done' }] })
  assert.match(r2.info, /已从计划里去掉：「改代码」、「写文档」、「补 e2e」/)
})

test('子步骤都完成，主步骤跟着完成；全部完成后计划结束，可以直接开新计划', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A', children: [{ title: 'a1' }, { title: 'a2' }] }] })
  const r = applyPlan(task, {
    steps: [
      {
        id: '1',
        title: 'A',
        children: [
          { id: '1.1', title: 'a1', status: 'done' },
          { id: '1.2', title: 'a2', status: 'done' },
        ],
      },
    ],
  })
  assert.match(r.info, /计划的步骤全部完成了：这份计划结束/)
  assert.equal(activePlan(task), undefined)
  assert.equal(unsummarized(task), undefined, '不再欠总结')
  // 直接开一份新计划，旧的留着
  assert.equal(applyPlan(task, { steps: [{ title: 'A' }] }).ok, true)
  assert.equal(task.plans.length, 2)
  assert.equal(activePlan(task)!.steps[0].status, 'pending')
})

test('finish_plan 主动结束计划：不写总结也能结束，传了也不保存', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A', status: 'done' }, { title: 'B' }] })
  const r = finishPlan(task, '做完了 A')
  assert.equal(r.ok, true)
  assert.match(r.info, /这份计划结束/)
  assert.match(r.info, /「B」/, '说清楚哪些步骤还没完成')
  assert.equal(activePlan(task), undefined)
  assert.equal(task.plans[0].doneAt === '', false)
  assert.equal(task.plans[0].summary, '', '传了总结也不落盘')
  assert.match(finishPlan(task).info, /没有进行中的计划/)
})

test('等待：挂上后台命令，成功自动完成；失败退回进行中', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }, { title: '端到端测试' }, { title: '写文档' }] })
  assert.match(bindWait(task, '2', { kind: 'background', ref: 'job1', label: 'e2e' }), /等待中/)
  assert.equal(activePlan(task)!.steps[1].status, 'waiting')
  // 别的结果不影响它
  assert.deepEqual(settleWait(task, 'background', 'other', true), [])
  const hit = settleWait(task, 'background', 'job1', false)
  assert.deepEqual(hit, [{ title: '端到端测试', done: false }])
  assert.equal(activePlan(task)!.steps[1].status, 'running')
  assert.match(activePlan(task)!.steps[1].note, /e2e/)
  bindWait(task, '2', { kind: 'background', ref: 'job2', label: 'e2e' })
  assert.deepEqual(settleWait(task, 'background', 'job2', true), [{ title: '端到端测试', done: true }])
  assert.equal(activePlan(task)!.steps[1].status, 'done')
  // 完成的步骤不能再挂等待
  assert.match(bindWait(task, '2', { kind: 'child', ref: 'c', label: 'x' }), /已经完成/)
})

test('子步骤在等子对话：结果回来子步骤完成，主步骤跟着收', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '修 bug', children: [{ title: '定位' }] }] })
  bindWait(task, '1.1', { kind: 'child', ref: 'kid', label: '定位' })
  assert.equal(activePlan(task)!.steps[0].status, 'waiting')
  settleWait(task, 'child', 'kid', true)
  assert.equal(activePlan(task), undefined)
  assert.equal(task.plans[0].steps[0].status, 'done')
})

test('还在等子对话的步骤，Agent 自己标完成不算：退回等待中，父对话的计划不会先「已完成」', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: '派子对话修图', status: 'running' },
      { title: '汇总', children: [{ title: '查日志' }] },
    ],
  })
  // 开子对话时没写 step：挂在正在做的那一步
  assert.equal(runningStepId(task), '1')
  bindWait(task, runningStepId(task), { kind: 'child', ref: 'kid', label: '修图' })
  bindWait(task, '2.1', { kind: 'background', ref: 'job', label: '日志' })
  const r = applyPlan(task, {
    steps: [
      { id: '1', title: '派子对话修图', status: 'done' },
      { id: '2', title: '汇总', status: 'done' },
    ],
  })
  const plan = activePlan(task)!
  assert.ok(plan, '计划没有结束')
  assert.equal(plan.steps[0].status, 'waiting')
  assert.equal(plan.steps[1].children[0].status, 'waiting', '主步骤标完成也带不走在等的子步骤')
  assert.equal(plan.steps[1].status, 'waiting', '子步骤退回了，主步骤也不算完成')
  assert.match(r.info, /还在等结果，不能自己标完成：「派子对话修图」（等：修图）/)
  // 结果推回来才标完成
  settleWait(task, 'child', 'kid', true)
  settleWait(task, 'background', 'job', true)
  assert.equal(activePlan(task), undefined, '都回来了，计划结束')
  // 没有进行中的步骤就不挂
  assert.equal(runningStepId(fresh()), '')
})

test('子对话这一轮结束：交付完了标完成、没交付完继续等、失败退回进行中', () => {
  // 父对话列好计划，带 step 把子对话挂成等待中
  const waiting = () => {
    const task = fresh()
    applyPlan(task, { steps: [{ title: '派子对话改文件', children: [{ title: '改文件' }] }] })
    bindWait(task, '1.1', { kind: 'child', ref: 'kid', label: '改文件' })
    assert.equal(activePlan(task)!.steps[0].status, 'waiting')
    return task
  }
  const child = (extra: Partial<Task> = {}) =>
    ({
      status: 'running',
      working: false,
      requests: [],
      plans: [],
      steps: [],
      ...extra,
    }) as unknown as Task
  /** 子对话自己的计划：做完了的收起（doneAt），没做完的还挡着收口 */
  const childPlan = (done: boolean) => {
    const tk = fresh() as unknown as Task
    applyPlan(tk, { steps: [{ title: '改文件', status: done ? 'done' : 'running' }] })
    return tk.plans
  }

  // 跑完一轮、计划做完了、没有后台命令和提问：算交付完成
  const ok = childReport(child({ plans: childPlan(true) }))
  assert.equal(ok.state, 'done')
  assert.equal(ok.settle, 'ok')
  const okTask = waiting()
  assert.deepEqual(settleWait(okTask, 'child', 'kid', true), [{ title: '改文件', done: true }])
  assert.equal(okTask.plans![0].steps[0].status, 'done')
  assert.ok(okTask.plans![0].doneAt)

  // 这一轮结束了，但子对话的计划还没做完：未完成，继续等，父计划那一步不能标完成
  const planLeft = childReport(child({ plans: childPlan(false) }))
  assert.equal(planLeft.state, 'unfinished')
  assert.equal(planLeft.settle, 'hold')
  assert.ok(planLeft.notify, '未完成要告诉父对话')
  assert.match(planLeft.why, /未完成.*计划还没做完.*改文件/)
  const planTask = waiting()
  assert.deepEqual(holdWait(planTask, 'child', 'kid', planLeft.why), ['改文件'])
  const held = activePlan(planTask)!.steps[0].children[0]
  assert.equal(held.status, 'waiting')
  assert.match(held.note, /还在等它.*计划还没做完/)
  assert.equal(activePlan(planTask)!.steps[0].status, 'waiting')
  // 同样的原因再收一次：note 没变，不用落盘
  assert.deepEqual(holdWait(planTask, 'child', 'kid', planLeft.why), [])
  // 没在等它时不改任何东西
  assert.deepEqual(holdWait(planTask, 'child', 'other', '别的对话'), [])

  // 还有后台命令在跑：等结果，只改说明不发消息，note 里点名是哪条命令
  const bgLeft = childReport(child(), { background: ['后端单测'] })
  assert.equal(bgLeft.state, 'waiting')
  assert.equal(bgLeft.settle, 'hold')
  assert.equal(bgLeft.notify, false)
  assert.match(bgLeft.why, /后台命令还在跑.*后端单测/)
  const bgTask = waiting()
  holdWait(bgTask, 'child', 'kid', bgLeft.why)
  assert.match(activePlan(bgTask)!.steps[0].children[0].note, /后端单测/)

  // 这一轮结束后还要接着处理排队的消息：还在执行
  assert.equal(childReport(child(), { more: true }).state, 'running')

  // 还在跑：不能当成完成
  assert.equal(childReport(child({ working: true })).settle, 'hold')

  // 有没答的提问：子对话是停下来等用户，不收口，步骤继续挂着等（提问卡片另有一条路，不重复发状态）
  const request = [{}] as unknown as Task['requests']
  const ask = childReport(child({ requests: request }), { background: ['不该看到这个'] })
  assert.equal(ask.state, 'needs')
  assert.equal(ask.settle, 'hold')
  assert.match(ask.why, /没答的提问/)
  const askTask = waiting()
  holdWait(askTask, 'child', 'kid', ask.why)
  assert.equal(activePlan(askTask)!.steps[0].status, 'waiting')
  // 等父对话回答的提问也算（以前只看 requests，漏了 parentAsks）
  const parentAsk = [{ id: 'q', question: '?', options: [], kind: 'question' }] as Task['parentAsks']
  assert.equal(childReport(child({ parentAsks: parentAsk })).state, 'needs')

  // 执行失败、被停止：退回进行中，note 里看得出是等谁失败了；有未完成计划也算结束
  for (const status of ['failed', 'stopped'] as const) {
    const r = childReport(child({ status, stopReason: 'user', plans: childPlan(false) }))
    assert.equal(r.settle, 'fail')
    assert.match(r.why, status === 'failed' ? /执行失败/ : /已中断/)
    const badTask = waiting()
    assert.deepEqual(settleWait(badTask, 'child', 'kid', false), [{ title: '改文件', done: false }])
    const item = activePlan(badTask)!.steps[0].children[0]
    assert.equal(item.status, 'running')
    assert.match(item.note, /改文件/)
  }

  // 彻底完成后面板结束等下一句的进程（stopReason 为 finish）：是完成，不是中断
  const finished = childReport(child({ status: 'stopped', stopReason: 'finish', resolved: true }))
  assert.equal(finished.state, 'done')
  assert.equal(finished.settle, 'ok')

  // 只剩合回、已经请父对话收尾：待收尾，继续等父对话
  const wrap = childReport(
    child({ plans: childPlan(true), wrapRequest: { state: 'requested', at: 'x', note: '', tests: 't', info: '' } }),
    { unmerged: true },
  )
  assert.equal(wrap.state, 'wrapup')
  assert.equal(wrap.settle, 'hold')
  assert.match(wrap.why, /finish_child/)
  // 只剩合回但还没请：未完成，说清还没请收尾
  const notAsked = childReport(child({ plans: childPlan(true) }), { unmerged: true })
  assert.equal(notAsked.state, 'unfinished')
  assert.match(notAsked.why, /还没请你收尾/)
})

test('三个子对话都在跑：计划里三步都在等，计数不把它们算完成（重开后也不回退）', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [{ title: '子任务卡片' }, { title: '文件页拖拽' }, { title: 'P0 降占用' }],
  })
  const kids = ['改卡片', '拖拽排序', '降占用']
  kids.forEach((ref, i) => bindWait(task, String(i + 1), { kind: 'child', ref, label: ref }))
  // 三个子对话都只跑完了一轮、自己的活还没做完：父计划三步继续等，不标完成
  kids.forEach((ref, i) => {
    const child = fresh() as unknown as Task
    applyPlan(child, { steps: [{ title: ref, status: 'running' }] })
    const r = childReport(
      { status: 'running', working: false, requests: [], plans: child.plans, steps: [] } as unknown as Task,
      { background: ['端到端测试'] },
    )
    assert.equal(r.settle, 'hold')
    assert.deepEqual(holdWait(task, 'child', ref, r.why), [task.plans![0].steps[i].title])
  })
  const plan = activePlan(task)!
  assert.deepEqual(
    plan.steps.map((s) => s.status),
    ['waiting', 'waiting', 'waiting'],
  )
  assert.equal(planProgress(task, plan).waiting, 3)
  assert.equal(planProgress(task, plan).done, 0)
  assert.deepEqual(openPlan(task), { done: 0, total: 3 })
  // 面板重开、父对话重启从 JSON 读回来：计划状态和计数跟当时渲染的一致，不会回退成完成
  const reloaded = JSON.parse(JSON.stringify(task)) as Task
  assert.deepEqual(
    reloaded.plans![0].steps.map((s) => s.status),
    ['waiting', 'waiting', 'waiting'],
  )
  assert.deepEqual(openPlan(reloaded), { done: 0, total: 3 })
})

test('工作流做主步骤：没指定步骤就在末尾加一步，跑完标完成', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '分析', status: 'done' }, { title: '实现' }] })
  const id = bindRun(task, '2', 3, '工作流「开发」')
  assert.equal(id, '2')
  assert.equal(activePlan(task)!.steps[1].run, 3)
  assert.equal(activePlan(task)!.steps[1].status, 'running')
  endRun(task, 3, true)
  assert.equal(unsummarized(task), undefined, '做完就结束，不欠总结')
  // 没有计划时启动工作流：开一份计划，工作流是第一步
  const other = fresh()
  bindRun(other, '', 1, '工作流「默认」')
  assert.equal(activePlan(other)!.steps[0].title, '工作流「默认」')
})

test('计划用时：进行中会涨，完成后停在最晚的 endedAt，缺 createdAt 退到最早的 startedAt', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const base = Date.parse('2026-10-24T10:00:00.000Z')
  const item = (over: Partial<PlanStep>): PlanStep => ({
    id: '1',
    title: '步骤',
    status: 'pending',
    note: '',
    waits: [],
    startedAt: '',
    endedAt: '',
    children: [],
    ...over,
  })
  const plan = (steps: PlanStep[], over: Partial<TaskPlan> = {}): TaskPlan => ({
    id: 'p1',
    title: '',
    steps,
    createdAt: '',
    doneAt: '',
    summary: '',
    autoSummary: false,
    ...over,
  })

  // 进行中：从创建时间算到现在，now 走得越久数值越大
  const running = plan([item({ status: 'running', startedAt: iso(base) })], { createdAt: iso(base) })
  assert.equal(planSpan(running, base + 10_000), 10_000)
  assert.equal(planSpan(running, base + 25_000), 25_000)

  // 完成：取最晚一项的 endedAt（不是计划自己的 doneAt），两次不同 now 结果一样
  const done = plan(
    [
      item({ id: '1', status: 'done', startedAt: iso(base), endedAt: iso(base + 60_000) }),
      item({ id: '2', status: 'done', startedAt: iso(base + 60_000), endedAt: iso(base + 120_000) }),
    ],
    { createdAt: iso(base), doneAt: iso(base + 150_000) },
  )
  assert.equal(planSpan(done, base + 200_000), 120_000)
  assert.equal(planSpan(done, base + 900_000), 120_000, '完成后不再增长')

  // 提前结束（finish_plan）还有没做完的步骤：停在 doneAt，不能拿已完成项的 endedAt 当结束时间，
  // 否则总用时会比未完成项的单项用时还短
  const earlyTask = fresh()
  applyPlan(
    earlyTask,
    {
      steps: [{ title: 'A', status: 'done' }, { title: 'B' }],
    },
    iso(base),
  )
  finishPlan(earlyTask, undefined, iso(base + 600_000))
  assert.equal(planSpan(earlyTask.plans![0], base + 900_000), 600_000)
  assert.equal(planSpan(earlyTask.plans![0], base + 1_800_000), 600_000, '提前结束后也停住')

  // 没有 createdAt 的旧数据：退到最早一步（含子步骤）的 startedAt
  const legacy = plan([
    item({
      id: '1',
      status: 'running',
      startedAt: iso(base + 300_000),
      children: [
        {
          id: '1.1',
          title: '子步骤',
          status: 'done',
          note: '',
          waits: [],
          startedAt: iso(base + 180_000),
          endedAt: iso(base + 240_000),
        },
      ],
    }),
  ])
  assert.equal(planSpan(legacy, base + 600_000), 420_000, '最早一步是子步骤的 10:03')

  // 一个时间都没有：没有可显示的总用时
  assert.equal(planSpan(plan([item({ status: 'pending' })]), base), undefined)
})

test('没做完的计划给进度：列表里显示「计划 7/8」、不算已完成', () => {
  const task = fresh()
  assert.equal(openPlan(task), undefined, '没有计划时没有进度')
  applyPlan(task, { steps: [{ title: 'A', status: 'done' }, { title: 'B' }, { title: 'C' }] })
  assert.deepEqual(openPlan(task), { done: 1, total: 3 })
  // 步骤全做完时计划已经收起（doneAt），不算「没做完」
  applyPlan(task, {
    steps: [
      { title: 'A', status: 'done' },
      { title: 'B', status: 'done' },
      { title: 'C', status: 'done' },
    ],
  })
  assert.equal(task.plans!.at(-1)!.doneAt === '', false, '前提：全部完成时计划收起')
  assert.equal(openPlan(task), undefined)
})

test('子对话的收尾：面板加在计划最后，漏写、挪到前面都放回最后', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码', status: 'running' }, { title: '跑测试' }] }, undefined, 'p4')
  let plan = activePlan(task)!
  assert.deepEqual(
    plan.steps.map((s) => [s.id, s.wrapUp ?? '']),
    [
      ['1', ''],
      ['2', ''],
      ['3', 'p4'],
    ],
  )
  assert.match(plan.steps[2].title, /按文件类型/)
  // Agent 交的列表里没写收尾：原样放回，id 不变
  applyPlan(
    task,
    { steps: [{ id: '1', title: '改代码', status: 'done' }, { id: '2', title: '跑测试' }, { title: '补文档' }] },
    undefined,
    'p4',
  )
  plan = activePlan(task)!
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ['1', '2', '4', '3'],
  )
  // 挪到中间也放回最后
  applyPlan(
    task,
    {
      steps: [
        { id: '1', title: '改代码', status: 'done' },
        { id: '3', title: plan.steps[3].title },
        { id: '2', title: '跑测试', status: 'done' },
        { id: '4', title: '补文档', status: 'done' },
      ],
    },
    undefined,
    'p4',
  )
  plan = activePlan(task)!
  assert.equal(plan.steps.at(-1)!.wrapUp, 'p4')
  assert.equal(plan.doneAt, '', '收尾没做完，计划不收起')
  // P4 的收尾由 Agent 自己标完成
  applyPlan(task, { steps: [{ id: '3', title: plan.steps.at(-1)!.title, status: 'done' }] }, undefined, 'p4')
  assert.notEqual(task.plans!.at(-1)!.doneAt, '', '收尾做完，计划结束')
})

test('合回分支的收尾只由面板标完成，新加的工作流步骤插在它前面', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }] }, undefined, 'merge')
  const wrap = () => activePlan(task)!.steps.find((s) => s.wrapUp === 'merge')!
  assert.equal(wrap().id, '2')
  // Agent 自己标完成不算
  const r = applyPlan(
    task,
    {
      steps: [
        { id: '1', title: '改代码', status: 'done' },
        { id: '2', title: wrap().title, status: 'done' },
      ],
    },
    undefined,
    'merge',
  )
  assert.equal(wrap().status, 'pending')
  assert.match(r.info, /不要自己标/)
  // 工作流步骤不指定 step 时插在收尾前面
  bindRun(task, '', 1, '工作流「开发」')
  assert.deepEqual(
    activePlan(task)!.steps.map((s) => s.id),
    ['1', '3', '2'],
  )
  endRun(task, 1, true)
  assert.ok(markWrapUp(task, 'merge', 'running', '已提交合并'))
  assert.equal(wrap().status, 'running')
  assert.ok(markWrapUp(task, 'merge', 'done'))
  assert.notEqual(task.plans!.at(-1)!.doneAt, '', '合进去后计划做完')
  // 合进去后又加了要做的事：在最后再收一次尾
  applyPlan(task, { title: '补一处', steps: [{ title: '修评审意见' }] }, undefined, 'merge')
  assert.deepEqual(
    activePlan(task)!.steps.map((s) => s.wrapUp ?? ''),
    ['', 'merge'],
  )
})

test('新开计划时 Agent 把上一份的收尾也抄过来：认成面板的收尾，只有一条', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }] }, undefined, 'merge')
  assert.ok(markWrapUp(task, 'merge', 'done'))
  assert.equal(activePlan(task), undefined, '前提：上一份计划合进去后结束')
  // 新计划照抄了上一份的收尾、标了完成：不再另加一条没做完的收尾（合没合回以 git 为准）
  applyPlan(
    task,
    {
      steps: [
        { title: '加 OpenDesign 条目', status: 'done' },
        { title: '收尾：合回父对话所在的分支', status: 'done' },
      ],
    },
    undefined,
    'merge',
  )
  let plan = task.plans!.at(-1)!
  assert.deepEqual(
    plan.steps.map((s) => s.wrapUp ?? ''),
    ['', 'merge'],
  )
  assert.notEqual(plan.doneAt, '', '都做完了，计划收起')
  // 合回后回顾一下做了什么（全是做完的步骤）：不加收尾，不然永远「只剩合回」
  applyPlan(task, { steps: [{ title: '回顾', status: 'done' }] }, undefined, 'merge')
  plan = task.plans!.at(-1)!
  assert.equal(
    plan.steps.some((s) => s.wrapUp),
    false,
  )
  // 有要做的事、又抄了一条没做完的收尾：只有一条，放在最后
  applyPlan(task, { steps: [{ title: '收尾: 合回父对话所在的分支' }, { title: '修评审意见' }] }, undefined, 'merge')
  plan = activePlan(task)!
  assert.deepEqual(
    plan.steps.map((s) => [s.title, s.wrapUp ?? '']),
    [
      ['修评审意见', ''],
      ['收尾：合回父对话所在的分支', 'merge'],
    ],
  )
  // 计划里已经有面板的收尾，Agent 又写了一条同名的：去掉 Agent 那条
  applyPlan(
    task,
    { partial: true, steps: [{ title: '收尾：合回父对话所在的分支（自己写的）', status: 'done' }] },
    undefined,
    'merge',
  )
  assert.equal(activePlan(task)!.steps.filter((s) => s.title.startsWith('收尾')).length, 1)
})

test('同一份计划里做完的收尾之后又加了步骤：重新打开挪到最后，不另加一条', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }, { title: '补测试' }] }, undefined, 'p4')
  const plan = activePlan(task)!
  const wrap = plan.steps.at(-1)!
  // P4 收尾先做完了，「补测试」还没做，计划不收起
  applyPlan(task, { partial: true, steps: [{ id: wrap.id, title: wrap.title, status: 'done' }] }, undefined, 'p4')
  applyPlan(task, { partial: true, steps: [{ title: '补文档' }] }, undefined, 'p4')
  const steps = activePlan(task)!.steps
  assert.equal(steps.filter((s) => s.wrapUp).length, 1)
  assert.equal(steps.at(-1)!.id, wrap.id)
  assert.equal(steps.at(-1)!.status, 'pending')
})

test('不用收尾的对话（父对话、共用目录的 Git 子对话）计划里没有收尾步骤', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码' }] })
  assert.equal(
    activePlan(task)!.steps.some((s) => s.wrapUp),
    false,
  )
  assert.equal(markWrapUp(task, 'merge', 'done'), false)
})

test('父对话收尾子对话后刷新计划：合进去还没收口继续等，收口了才标完成，每次都给出计划', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改登录页', status: 'running' }, { title: '发版' }] })
  bindWait(task, '1', { kind: 'child', ref: 'kid', label: '登录页' })
  const kid = { id: 'kid', title: '登录页' }
  // 合进去了但子对话这一轮还没结束：不能先把父计划标完成（用户见过父计划已完成、子对话却没完）
  const held = refreshChildWait(task, kid, { settle: 'hold', why: '计划 3/4' })
  assert.equal(activePlan(task)!.steps[0].status, 'waiting')
  assert.match(held, /收尾后的计划/)
  assert.match(held, /还在等它：计划 3\/4/)
  assert.doesNotMatch(held, /没有步骤在等/)
  // 收口了：标完成，计划文字跟着变
  const done = refreshChildWait(task, kid, { settle: 'ok', why: '' })
  assert.equal(activePlan(task)!.steps[0].status, 'done')
  assert.match(done, /\[x\] 1 改登录页/)
  // 失败退回进行中
  const other = fresh()
  applyPlan(other, { steps: [{ title: 'A', status: 'running' }] })
  bindWait(other, '1', { kind: 'child', ref: 'kid', label: 'A' })
  refreshChildWait(other, kid, { settle: 'fail', why: '执行失败了' })
  assert.equal(activePlan(other)!.steps[0].status, 'running')
})

test('父对话收尾子对话后刷新计划：计划里没挂它时点明要 Agent 自己标，没有计划时不出', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改登录页', status: 'running' }] })
  const text = refreshChildWait(task, { id: 'kid', title: '登录页' }, { settle: 'ok', why: '' })
  assert.match(text, /没有步骤在等子对话「登录页」/)
  assert.equal(activePlan(task)!.steps[0].status, 'running', '没挂等待的步骤不替 Agent 乱标')
  assert.equal(refreshChildWait(fresh(), { id: 'kid', title: 'x' }, { settle: 'ok', why: '' }), '')
})

test('子对话没指定步骤：按标题对上说它的那一步，给它发消息还挂原来那一步', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: '把 OpenDesign 加进内置厂家列表与协议地址', status: 'running' },
      { title: '默认代理地址改为 127.0.0.1:10808 并让自动探测优先用它' },
      { title: '子任务弹窗加 AI 分析，复用现有分析窗口' },
    ],
  })
  assert.equal(childStepId(task, 'a', '内置 OpenDesign API 厂家'), '1')
  bindWait(task, '1', { kind: 'child', ref: 'a', label: '内置 OpenDesign API 厂家' })
  assert.equal(childStepId(task, 'b', '默认代理地址改为 127.0.0.1:10808'), '2')
  bindWait(task, '2', { kind: 'child', ref: 'b', label: '代理' })
  assert.equal(childStepId(task, 'c', '子任务弹窗加 AI 分析'), '3')
  // 给 b 发后续消息：还挂第 2 步
  assert.equal(childStepId(task, 'b'), '2')
  // 对不上的挂在正在做的那一步
  assert.equal(childStepId(task, 'd', '整理文档'), '1')
})

test('一次把几个没开始的步骤直接标完成：按顺序摊开上次记时间到现在这段，不记成 0 秒', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const base = Date.parse('2026-10-25T01:00:00.000Z')
  const task = fresh()
  applyPlan(
    task,
    { steps: [{ title: 'A' }, { title: 'B' }, { title: 'C', children: [{ title: 'C1' }, { title: 'C2' }] }] },
    iso(base),
  )
  applyPlan(
    task,
    {
      steps: [
        { id: '1', title: 'A', status: 'done' },
        { id: '2', title: 'B', status: 'done' },
      ],
      partial: true,
    },
    iso(base + 60_000),
  )
  const [a, b, c] = task.plans[0].steps
  assert.deepEqual([a.startedAt, a.endedAt], [iso(base), iso(base + 30_000)])
  assert.deepEqual([b.startedAt, b.endedAt], [iso(base + 30_000), iso(base + 60_000)])
  // 子步骤直接标完成：主步骤跟着收，时间取子步骤最早开工、最晚做完
  applyPlan(
    task,
    {
      steps: [
        {
          id: '3',
          title: 'C',
          children: [
            { title: 'C1', status: 'done' },
            { title: 'C2', status: 'done' },
          ],
        },
      ],
      partial: true,
    },
    iso(base + 120_000),
  )
  assert.equal(c.status, 'done')
  assert.deepEqual([c.children[0].startedAt, c.children[1].endedAt], [iso(base + 60_000), iso(base + 120_000)])
  assert.deepEqual([c.startedAt, c.endedAt], [iso(base + 60_000), iso(base + 120_000)])
  assert.equal(planSpan(task.plans[0], base + 999_000), 120_000, '总用时等于各步相加')
})

test('步骤只在备注里写了「等待 子对话 id」：自动挂上等待，用时从子对话创建算起，子对话完成就标完成', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  const base = Date.parse('2026-10-25T01:00:00.000Z')
  const kids = [
    {
      id: '1089f02e-aaaa-bbbb-cccc-000000000001',
      title: '默认代理改端口',
      createdAt: iso(base - 600_000),
      done: false,
    },
    {
      id: 'd3c7b6be-aaaa-bbbb-cccc-000000000002',
      title: '子任务弹窗加 AI 分析',
      createdAt: iso(base - 300_000),
      done: false,
    },
  ]
  const task = fresh()
  applyPlan(
    task,
    {
      steps: [
        { title: '默认代理改 127.0.0.1:10808', status: 'waiting', note: '等待 1089f02e 收尾回合并回' },
        { title: '子任务弹窗加 AI 分析' },
        { title: '汇总' },
      ],
    },
    iso(base),
    undefined,
    kids,
  )
  const [s1, s2, s3] = task.plans[0].steps
  assert.equal(s1.waits[0]?.ref, kids[0].id, '备注里的 id 缩写对上了子对话')
  assert.equal(s1.startedAt, iso(base - 600_000), '从子对话创建时算起')
  assert.equal(s2.status, 'waiting', '标题就是子对话的标题：挂上等待')
  assert.equal(s2.startedAt, iso(base - 300_000))
  assert.equal(s3.waits.length, 0)
  assert.equal(planSpan(task.plans[0], base), 600_000, '总用时不比单项短')
  // Agent 在子对话合回前标完成：退回等待
  applyPlan(
    task,
    { steps: [{ id: '1', title: s1.title, status: 'done' }], partial: true },
    iso(base + 1000),
    undefined,
    kids,
  )
  assert.equal(s1.status, 'waiting')
  // 子对话收尾完成：按它完成的时间标完成
  kids[0] = { ...kids[0], done: true, endedAt: iso(base + 120_000) } as (typeof kids)[0]
  assert.equal(syncKids(task, kids, iso(base + 180_000)), true)
  assert.equal(s1.status, 'done')
  assert.equal(s1.endedAt, iso(base + 120_000))
  assert.equal(syncKids(task, kids, iso(base + 190_000)), false, '没变化就不报变')
})

test('换了一份计划：上一份里还在等的子对话跟着同名步骤走，结果回来照样标完成', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '修登录' }, { title: '整理' }] })
  bindWait(task, '1', { kind: 'child', ref: 'kid-1', label: '修登录' })
  finishPlan(task)
  const kids = [{ id: 'kid-1', title: '修复登录误报', createdAt: '2026-10-25T00:00:00.000Z', done: false }]
  applyPlan(task, { steps: [{ title: '修登录', status: 'waiting' }, { title: '发版' }] }, undefined, undefined, kids)
  const plan = activePlan(task)!
  assert.equal(plan.steps[0].waits[0]?.ref, 'kid-1')
  settleWait(task, 'child', 'kid-1', true)
  assert.equal(plan.steps[0].status, 'done')
})

/**
 * 回归：父对话把一件事先写成一条步骤、后来又把标题改写了一遍（6 与 8 就是同一件事的两条），
 * 或者只交变更步骤却漏带了 id。以前按标题精确匹配对不上就新建一条，旧步永远停在原状态，
 * 计划里同一步出现两条、计数（8/13 与 9/11）来回变。
 */
test('改写过的标题对回原来那一步：不新建重复步骤，旧步按新的状态走', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: '修单测失败：登录失败文案在英文 locale 下变成英文', status: 'running' },
      { title: '修 e2e 失败：subagents 等 merged 超时', status: 'running' },
    ],
  })
  const [old, other] = activePlan(task)!.steps
  // 模型把旧步骤的标题改写了一遍（只差标点、空白、全半角），带上了 id
  const r = applyPlan(task, {
    partial: true,
    steps: [{ id: old.id, title: '修单测失败：登录失败文案 在英文 locale 下 变成英文', status: 'done' }],
  })
  const plan = activePlan(task)!
  assert.equal(plan.steps.length, 2, '不新建重复步骤')
  assert.equal(old.status, 'done')
  assert.match(r.info, /这些步骤这次没交上来[\s\S]*修 e2e 失败/)
  // 只差标点、全半角、大小的改写（归一化后一样）也算同一个步骤，不会多出一条
  const t2 = fresh()
  applyPlan(t2, { steps: [{ title: '修 e2e 失败：subagents 等 merged 超时', status: 'running' }] })
  const r2 = applyPlan(t2, {
    partial: true,
    steps: [{ title: '修 e2e 失败: subagents 等 merged 超时', status: 'running' }],
  })
  assert.equal(activePlan(t2)!.steps.length, 1, '只差标点不算新步骤')
  // 它确实被这条更新过（归一化匹配），就不能同时报「没交上来」——两句话会让模型又交一次
  assert.doesNotMatch(r2.info, /这些步骤这次没交上来/)
  // 只差空格的同一条（标题归一化后相同）：算交上来了，不新建
  const t3 = fresh()
  applyPlan(t3, { steps: [{ title: '跑 e2e 并核实  CI', status: 'running' }, { title: '写文档' }] })
  const r3 = applyPlan(t3, { partial: true, steps: [{ title: '跑 e2e 并核实 CI', status: 'running' }] })
  assert.equal(activePlan(t3)!.steps.length, 2, '归一化后一样的标题算同一步骤，不新建')
  // 这条被归一化匹配更新过，不能说它「没交上来」；真没交上来的「写文档」照常点名
  assert.doesNotMatch(r3.info, /没交上来[\s\S]*跑 e2e/)
  assert.match(r3.info, /没交上来[\s\S]*写文档/)
  assert.equal(other.status, 'running', '没交上来的步骤状态不动，并在回复里点名')
  // 只带 id 改备注、标题没重写（模型 partial 最常见的写法）：同样算交上来了，不能说它没交上来。
  // 这里「交上来了」的判定必须和 matchOld 同口径：另写一套精确标题比对，会把刚被 id 更新的步骤又报成漏写，
  // 模型看到「已经更新了」和「没交上来」两句互相矛盾的话，就会再交一遍
  const t4 = fresh()
  applyPlan(t4, { steps: [{ title: '修 e2e：subagents 超时', status: 'running' }, { title: '写文档' }] })
  const r4 = applyPlan(t4, { partial: true, steps: [{ id: '1', note: '跑了一遍', status: 'running' }] })
  assert.equal(activePlan(t4)!.steps[0].note, '跑了一遍', '按 id 更新的内容生效')
  assert.doesNotMatch(r4.info, /没交上来[\s\S]*修 e2e/, '按 id 更新的步骤不算没交上来')
  assert.match(r4.info, /没交上来[\s\S]*写文档/)
  // 真的改写成另一件事：宁可新加一步，也不能张冠李戴把别的步骤标完成
  const other2 = fresh()
  applyPlan(other2, { steps: [{ title: '跑端到端测试', status: 'running' }] })
  applyPlan(other2, { partial: true, steps: [{ title: '改前端界面布局', status: 'done' }] })
  assert.deepEqual(
    activePlan(other2)!.steps.map((s) => [s.title, s.status]),
    [
      ['跑端到端测试', 'running'],
      ['改前端界面布局', 'done'],
    ],
    '对不上就新加一步，原来的步骤状态不动',
  )
})

test('id 顺序和数组顺序不一致、又混着 partial：完成项留在原位，其余步骤不挪动', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: '修存储', status: 'done' },
      { title: '评审' },
      { title: '合并孤儿分支', status: 'done' },
      { title: '删空文件' },
      { title: '吸纳远端' },
    ],
  })
  // 只交三步，且交的顺序和数组顺序不一致：旧数据里 8 排在 7 前面的那种
  applyPlan(task, {
    partial: true,
    steps: [
      { id: '5', title: '吸纳远端', status: 'done' },
      { id: '2', title: '评审', status: 'running' },
      { id: '4', title: '删空文件', status: 'done' },
    ],
  })
  assert.deepEqual(
    activePlan(task)!.steps.map((s) => [s.id, s.status]),
    [
      ['1', 'done'],
      ['2', 'running'],
      ['3', 'done'],
      ['4', 'done'],
      ['5', 'done'],
    ],
    '顺序按计划原来的顺序，完成项不回退也不丢',
  )
})

test('等的结果成功回来了：把「还在等它」的备注清掉，不留一条已经过时的说明', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '推 dev 并核实 CI 变绿', status: 'running' }, { title: '收尾' }] })
  bindWait(task, '1', { kind: 'child', ref: 'kid', label: '版本控制' })
  holdWait(task, 'child', 'kid', '执行中：计划 9/11')
  assert.match(activePlan(task)!.steps[0].note, /还在等它/)
  settleWait(task, 'child', 'kid', true)
  const step = activePlan(task)!.steps[0]
  assert.equal(step.status, 'done')
  assert.equal(step.note, '', '成功回来后备注清空，计划面板不再显示「还在等它」')
  // 失败回来的：备注换成失败原因，留着给人看
  const bad = fresh()
  applyPlan(bad, { steps: [{ title: '推 dev', status: 'running' }] })
  bindWait(bad, '1', { kind: 'child', ref: 'kid2', label: '版本控制' })
  holdWait(bad, 'child', 'kid2', '执行中')
  settleWait(bad, 'child', 'kid2', false)
  assert.equal(activePlan(bad)!.steps[0].status, 'running')
  assert.match(activePlan(bad)!.steps[0].note, /没成功/)
})

test('同一步骤先失败后重跑成功：失败的备注不留下来，已经完成的不挂「等的结果没成功」', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '端到端测试', status: 'running' }, { title: '收尾' }] })
  // 第一次跑失败了：退回进行中并写清原因
  bindWait(task, '1', { kind: 'background', ref: 'job1', label: '端到端测试（WSL）' })
  settleWait(task, 'background', 'job1', false)
  assert.match(activePlan(task)!.steps[0].note, /没成功/)
  // 重跑一次成功了：那行失败说明已经过时，不能还挂在完成的步骤下面
  bindWait(task, '1', { kind: 'background', ref: 'job2', label: '端到端测试（WSL）' })
  settleWait(task, 'background', 'job2', true)
  const step = activePlan(task)!.steps[0]
  assert.equal(step.status, 'done')
  assert.equal(step.note, '', '重跑成功后清掉上一轮的失败说明')
})

test('子任务的等待项按子任务真实状态收口：已经取走过结果的也要标完成', () => {
  // 老会话调过 wait_agents 时子任务已被取走，settleHelpers 拿不到这一批；
  // 收口按「计划里还挂着的 helper 等待」遍历，不看这一批有没有交回
  const task = fresh()
  applyPlan(task, { steps: [{ title: '派版本控制收尾', status: 'running' }, { title: '汇总' }] })
  bindWait(task, '1', { kind: 'helper', ref: 'sub/h1', label: '版本控制' })
  bindWait(task, '2', { kind: 'helper', ref: 'sub/h2', label: '甲' })
  bindWait(task, '2', { kind: 'helper', ref: 'sub/h3', label: '乙' })
  assert.equal(activePlan(task)!.steps[1].status, 'waiting')
  // 子任务 h1 完成、h3 完成、h2 还没完成：第一步收口，第二步继续等
  settleWait(task, 'helper', 'sub/h1', true)
  settleWait(task, 'helper', 'sub/h3', true)
  assert.equal(activePlan(task)!.steps[0].status, 'done')
  assert.equal(activePlan(task)!.steps[1].status, 'waiting', '还有个子任务没结束，继续等')
  settleWait(task, 'helper', 'sub/h2', true)
  // 最后一步也完成：计划整份收起（activePlan 变成 undefined），所以看 plans[0]
  assert.equal(activePlan(task), undefined, '全部收口，计划结束')
  assert.equal(task.plans[0].steps[1].status, 'done', '最后一个子任务也完成了，这一步收口')
})

test('等子任务的步骤：子任务成功了才标完成，失败或被终止退回进行中并写清原因', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '派版本控制收尾', status: 'running' }, { title: '汇总' }] })
  assert.match(bindWait(task, '1', { kind: 'helper', ref: 'chat/sub/h1', label: '版本控制' }), /等待中/)
  assert.equal(settleWait(task, 'helper', 'chat/sub/h1', false).length, 1)
  assert.equal(activePlan(task)!.steps[0].status, 'running')
  assert.match(activePlan(task)!.steps[0].note, /版本控制/)
  bindWait(task, '1', { kind: 'helper', ref: 'chat/sub/h2', label: '版本控制' })
  settleWait(task, 'helper', 'chat/sub/h2', true)
  assert.equal(activePlan(task)!.steps[0].status, 'done')
})
