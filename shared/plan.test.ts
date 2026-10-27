import { childReport } from './task.ts'
import { makeAlert } from './alerts.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlanStep, Task, TaskMessage, TaskPlan } from './schema.ts'
import {
  activePlan,
  applyPlan,
  bindRun,
  bindWait,
  endRun,
  finishPlan,
  holdWait,
  inputUnhandled,
  isSettled,
  itemUpdatedAt,
  leftSteps,
  markWrapUp,
  openPlan,
  planChildren,
  planHeadline,
  planNotice,
  planNowText,
  planProgress,
  planRebuilt,
  planUpdatedAt,
  PLAN_STALE_MS,
  staleStep,
  unfinishedSteps,
  planSpan,
  refreshChildWait,
  runningStepId,
  childStepId,
  ensureChildStep,
  settlePlan,
  settleWait,
  syncKids,
  unsummarized,
  WRAP_UP,
  wrapUpKind,
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

test('提前结束还有没做完的步骤：doneAt 写上、步骤状态原样留着，leftSteps 报得出来', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [{ title: 'A', status: 'done' }, { title: 'B' }, { title: 'C', status: 'running' }],
  })
  // 真在等结果的一步：挂着等待，applyPlan 不会把它当成「写着等待中却什么也没等」改成进行中
  bindWait(task, '2', { kind: 'background', ref: 'job-b', label: 'e2e' })
  finishPlan(task)
  const plan = task.plans![0]
  assert.notEqual(plan.doneAt, '', '计划确实结束了')
  // 数据语义不改：那一步是真的还在等 / 在做，状态留原样，不能改写成完成或跳过
  assert.deepEqual(
    plan.steps.map((s) => s.status),
    ['done', 'waiting', 'running'],
  )
  // 界面靠 leftSteps 区分「全部做完」和「提前结束」：只看 doneAt 会把提前结束也报成已完成
  assert.deepEqual(
    leftSteps(plan).map((s) => s.title),
    ['B', 'C'],
  )
  assert.equal(planProgress(task, plan).done, 1)
  assert.equal(planProgress(task, plan).total, 3)
})

test('折叠头说的「几项没做完」和进度是同一套计数：带子步骤时不打架', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: 'A', status: 'done' },
      { title: 'B', status: 'waiting', children: [{ title: 'B1' }, { title: 'B2' }] },
    ],
  })
  finishPlan(task)
  const plan = task.plans![0]
  const { done, total } = planProgress(task, plan)
  // 折叠头只数主步骤（和 total - done 恒等）：以前直接拿 leftSteps 的条目数套「步」字文案，
  // 会同时出现「3 步没做完」和「1/2」，用户看不出到底还剩几步
  assert.equal(unfinishedSteps(plan), total - done)
  // leftSteps 仍然算上子步骤：它是「还剩哪些条目」，给列表和计划文案用
  assert.equal(leftSteps(plan).length, 3)
})

test('全部做完收起后 leftSteps 是空的：这种情况下才该说「计划已完成」', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: 'A', status: 'done' },
      { title: 'B', status: 'done' },
    ],
  })
  const plan = task.plans!.at(-1)!
  assert.notEqual(plan.doneAt, '', '前提：全部完成时计划收起')
  assert.deepEqual(leftSteps(plan), [])
})

test('折叠头该说哪件事：还在做 / 全部做完 / 提前结束但还有没做完的步骤', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: 'A', status: 'done' },
      { title: 'B', status: 'running' },
    ],
  })
  assert.equal(planHeadline(task.plans![0]), 'open', '还没结束：只说进度')
  finishPlan(task)
  // 提前结束还有遗留：不能写「计划已完成」，界面上还有一步是等待中 / 进行中
  assert.equal(planHeadline(task.plans![0]), 'closed')
  const doneTask = fresh()
  applyPlan(doneTask, { steps: [{ title: 'A', status: 'done' }] })
  assert.equal(planHeadline(doneTask.plans![0]), 'done', '全部做完收起才说已完成')
})

test('等待：挂上后台命令，成功自动完成；失败标失败（需要处理）', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }, { title: '端到端测试' }, { title: '写文档' }] })
  assert.match(bindWait(task, '2', { kind: 'background', ref: 'job1', label: 'e2e' }), /等待中/)
  assert.equal(activePlan(task)!.steps[1].status, 'waiting')
  // 别的结果不影响它
  assert.deepEqual(settleWait(task, 'background', 'other', true), [])
  const hit = settleWait(task, 'background', 'job1', false)
  assert.deepEqual(hit, [{ title: '端到端测试', done: false }])
  // 失败不退回进行中：那是「对话正在做」的意思；标成失败等对话重做或放弃
  assert.equal(activePlan(task)!.steps[1].status, 'failed')
  assert.match(activePlan(task)!.steps[1].note, /e2e/)
  bindWait(task, '2', { kind: 'background', ref: 'job2', label: 'e2e' })
  assert.deepEqual(settleWait(task, 'background', 'job2', true), [{ title: '端到端测试', done: true }])
  assert.equal(activePlan(task)!.steps[1].status, 'done')
  // 完成的步骤不能再挂等待
  assert.match(bindWait(task, '2', { kind: 'child', ref: 'c', label: 'x' }), /已经结束/)
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

test('子对话这一轮结束：交付完了标完成、没交付完继续等、失败标失败', () => {
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
    assert.equal(item.status, 'failed')
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

/** 父对话（明确授权推送）的计划：最后一步是推送收尾 */
const pushTask = () => fresh()

test('父对话的推送收尾：计划最后一步，删掉、挪到中间都放回最后', () => {
  const task = pushTask()
  applyPlan(task, { steps: [{ title: '改代码', status: 'running' }, { title: '跑测试' }] }, undefined, 'push')
  let plan = activePlan(task)!
  assert.deepEqual(
    plan.steps.map((s) => [s.id, s.wrapUp ?? '']),
    [
      ['1', ''],
      ['2', ''],
      ['3', 'push'],
    ],
  )
  assert.equal(plan.steps[2].title, '收尾：推送到远端')
  assert.match(plan.steps[2].note, /推成功后把这步标完成/, '推送由 Agent 自己标完成，备注里要写清')
  // Agent 交的列表里没写收尾：原样放回，id 不变
  applyPlan(
    task,
    { steps: [{ id: '1', title: '改代码', status: 'done' }, { id: '2', title: '跑测试' }, { title: '补文档' }] },
    undefined,
    'push',
  )
  plan = activePlan(task)!
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ['1', '2', '4', '3'],
  )
  assert.equal(plan.steps.at(-1)!.wrapUp, 'push')
  // 挪到中间也放回最后
  applyPlan(
    task,
    {
      steps: [
        { id: '1', title: '改代码', status: 'done' },
        { id: '3', title: plan.steps.at(-1)!.title },
        { id: '2', title: '跑测试', status: 'done' },
        { id: '4', title: '补文档', status: 'done' },
      ],
    },
    undefined,
    'push',
  )
  plan = activePlan(task)!
  assert.equal(plan.steps.at(-1)!.wrapUp, 'push')
  assert.equal(plan.doneAt, '', '推送没做完，计划不收起')
  // 推送由 Agent 自己标完成（不像合回那样被面板退回）
  applyPlan(task, { steps: [{ id: '3', title: WRAP_UP.push.title, status: 'done' }] }, undefined, 'push')
  assert.notEqual(task.plans!.at(-1)!.doneAt, '', '推完计划结束')
})

test('父对话的推送收尾做完后又有新步骤：重新打开挪到最后，不另加一条', () => {
  const task = pushTask()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }, { title: '补测试' }] }, undefined, 'push')
  const plan = activePlan(task)!
  const wrap = plan.steps.at(-1)!
  applyPlan(task, { partial: true, steps: [{ id: wrap.id, title: wrap.title, status: 'done' }] }, undefined, 'push')
  applyPlan(task, { partial: true, steps: [{ title: '补文档' }] }, undefined, 'push')
  const steps = activePlan(task)!.steps
  assert.equal(steps.filter((s) => s.wrapUp).length, 1, '计划里只有一条收尾')
  assert.equal(steps.at(-1)!.id, wrap.id)
  assert.equal(steps.at(-1)!.status, 'pending')
})

test('父对话开第二份计划：推送收尾照样加在最后（一轮就做完的改动也要推）', () => {
  const task = pushTask()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }] }, undefined, 'push')
  applyPlan(task, { partial: true, steps: [{ title: WRAP_UP.push.title, status: 'done' }] }, undefined, 'push')
  assert.equal(activePlan(task), undefined, '前提：第一份计划做完收起')
  // 第二份计划有新做的事：推送收尾还是最后一步
  applyPlan(task, { title: '修评审意见', steps: [{ title: '改代码' }] }, undefined, 'push')
  let plan = activePlan(task)!
  assert.equal(plan.steps.at(-1)!.wrapUp, 'push')
  assert.equal(plan.steps.filter((s) => s.wrapUp).length, 1)
  // 一轮就做完的改动（交上来的步骤全是 done）：照样要推，收尾还在最后一步。
  // 看 first 会漏掉——新开的计划 first 一定是 false，那一轮的改动就永远不推
  applyPlan(
    task,
    {
      partial: true,
      steps: [
        { title: '改代码', status: 'done' },
        { title: plan.steps.at(-1)!.title, status: 'done' },
      ],
    },
    undefined,
    'push',
  )
  applyPlan(task, { title: '小修', steps: [{ title: '改这处', status: 'done' }] }, undefined, 'push')
  plan = task.plans!.at(-1)!
  assert.equal(plan.steps.at(-1)!.wrapUp, 'push', '一轮改完也要到推送这一步')
  assert.equal(plan.doneAt, '', '推送没做完，计划不收起')
})

test('父对话的推送收尾只在这个对话明确授权时才有', () => {
  // 项目设置「允许直接推送」、Git 仓库有远端
  assert.equal(wrapUpKind({ child: false, git: true, push: 'allow' }), 'push')
  // 这个对话里用户已经同意推送，口径和提示词的授权段一致
  assert.equal(wrapUpKind({ child: false, git: true, push: 'ask', answered: 'allowed' }), 'push')
  // 不推送、用户拒绝过：都不加
  assert.equal(wrapUpKind({ child: false, git: true, push: 'deny' }), undefined)
  assert.equal(wrapUpKind({ child: false, git: true, push: 'ask', answered: 'denied' }), undefined)
  assert.equal(wrapUpKind({ child: false, git: true, push: 'allow', answered: 'denied' }), undefined)
  // 「第一次问一次」还没回答：等回答完、下一轮再加
  assert.equal(wrapUpKind({ child: false, git: true, push: 'ask' }), undefined)
  // 不是 Git 仓库 / 没有远端：推送这一步永远做不了，不加
  assert.equal(wrapUpKind({ child: false, git: false, push: 'allow' }), undefined)
  // P4 工作区走 changelist，不推 git（工作区建在 git 仓库目录下时也会认到 .git）
  assert.equal(wrapUpKind({ child: false, p4: true, git: true, push: 'allow' }), undefined)
  // 子对话保持不碰远端：还是合并回父对话分支或分 changelist
  assert.equal(wrapUpKind({ child: true, isolated: true, git: true, push: 'allow' }), 'merge')
  assert.equal(wrapUpKind({ child: true, p4: true, git: true, push: 'allow' }), 'p4')
  assert.equal(wrapUpKind({ child: true, git: true, push: 'allow' }), undefined)
  // 项目设置「不推送」不影响子对话：它的收尾是合回分支 / 分 changelist，不推送也要照做
  assert.equal(wrapUpKind({ child: true, isolated: true, git: true, push: 'deny' }), 'merge')
  assert.equal(wrapUpKind({ child: true, p4: true, git: true, push: 'deny' }), 'p4')
  assert.equal(wrapUpKind({ child: true, isolated: true, git: true, push: 'ask', answered: 'denied' }), 'merge')
})

test('Agent 自己又写了一条推送收尾：认成面板的那一条，计划里只有一条', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码' }, { title: '收尾：推送到远端' }] }, undefined, 'push')
  const steps = activePlan(task)!.steps
  assert.equal(steps.filter((x) => x.wrapUp).length, 1, '只有面板的一条推送收尾')
  assert.equal(steps.at(-1)!.wrapUp, 'push')
  assert.equal(steps.at(-1)!.title, WRAP_UP.push.title)
})

test('明确不推送后，计划里挂着的推送收尾被去掉（Agent 自己抄的那条也一起）', () => {
  const task = pushTask()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }] }, undefined, 'push')
  assert.equal(activePlan(task)!.steps.at(-1)!.wrapUp, 'push')
  // 用户拒绝推送后再刷新计划：还挂着一步永远做不了的收尾，计划就永远算没做完
  const r = applyPlan(task, { partial: true, steps: [{ title: '补文档' }] }, undefined, 'none')
  const plan = activePlan(task)!
  assert.equal(
    plan.steps.some((s) => s.wrapUp),
    false,
  )
  assert.match(r.info, /推送收尾已去掉/)
  // Agent 把面板那条删掉、自己写了一条同标题（没有 wrapUp 字段）的普通步骤：也认出来删掉，
  // 不然计划里还剩一步「收尾：推送到远端」永远做不完
  const again = pushTask()
  applyPlan(again, { steps: [{ title: '改代码', status: 'done' }, { title: '收尾: 推送到远端' }] }, undefined, 'push')
  assert.equal(
    activePlan(again)!.steps.filter((x) => x.title.includes('远程') || x.title.includes('远端')).length <= 2,
    true,
  )
  applyPlan(again, { partial: true, steps: [{ title: '补文档' }] }, undefined, 'none')
  assert.equal(
    activePlan(again)!.steps.filter((x) => x.wrapUp || x.title.includes('推送到远端')).length,
    0,
    '标题是收尾的普通步骤也一起去掉',
  )
})

test('收尾这一轮算不出来时不删已有的推送收尾（只有明确不推才删）', () => {
  const task = pushTask()
  applyPlan(task, { steps: [{ title: '改代码', status: 'done' }] }, undefined, 'push')
  const wrap = activePlan(task)!.steps.at(-1)!
  // 这一轮没算出收尾（项目目录没取到）：收尾保持原样，id 不变，下一轮算出来接着用
  // （这一轮新加的步骤会临时排在它后面，下一轮 ensureWrapUp 会把它挪回最后）
  applyPlan(task, { partial: true, steps: [{ title: '补文档' }] }, undefined, undefined)
  const plan = activePlan(task)!
  const kept = plan.steps.find((s) => s.wrapUp === 'push')!
  assert.ok(kept, '收尾没被删掉')
  assert.equal(kept.id, wrap.id)
  applyPlan(task, { partial: true, steps: [{ title: '补文档' }] }, undefined, 'push')
  assert.equal(activePlan(task)!.steps.at(-1)!.id, wrap.id, '下一轮挪回最后')
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
  // 失败标失败（需要处理）
  const other = fresh()
  applyPlan(other, { steps: [{ title: 'A', status: 'running' }] })
  bindWait(other, '1', { kind: 'child', ref: 'kid', label: 'A' })
  refreshChildWait(other, kid, { settle: 'fail', why: '执行失败了' })
  assert.equal(activePlan(other)!.steps[0].status, 'failed')
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
  assert.match(r.info, /这些还没做完的主步骤这次没交上来[\s\S]*修 e2e 失败/)
  // 只差标点、全半角、大小的改写（归一化后一样）也算同一个步骤，不会多出一条
  const t2 = fresh()
  applyPlan(t2, { steps: [{ title: '修 e2e 失败：subagents 等 merged 超时', status: 'running' }] })
  const r2 = applyPlan(t2, {
    partial: true,
    steps: [{ title: '修 e2e 失败: subagents 等 merged 超时', status: 'running' }],
  })
  assert.equal(activePlan(t2)!.steps.length, 1, '只差标点不算新步骤')
  // 它确实被这条更新过（归一化匹配），就不能同时报「没交上来」——两句话会让模型又交一次
  assert.doesNotMatch(r2.info, /这些还没做完的主步骤这次没交上来/)
  // 只差空格的同一条（标题归一化后相同）：算交上来了，不新建
  const t3 = fresh()
  applyPlan(t3, { steps: [{ title: '跑 e2e 并核实  CI', status: 'running' }, { title: '写文档' }] })
  const r3 = applyPlan(t3, { partial: true, steps: [{ title: '跑 e2e 并核实 CI', status: 'running' }] })
  assert.equal(activePlan(t3)!.steps.length, 2, '归一化后一样的标题算同一步骤，不新建')
  // 这条被归一化匹配更新过，不能说它「没交上来」；真没交上来的「写文档」照常点名
  assert.doesNotMatch(r3.info, /没交上来[\s\S]*跑 e2e/)
  assert.match(r3.info, /没交上来[\s\S]*写文档/)
  assert.equal(other.status, 'running', '没交上来的步骤状态不动，并在回复里点名')
  // 还在等结果的步骤不算「没交上来」：它由面板在结果回来后标完成，让模型去「标完成」只会被 held 退回，
  // 同一个回复里就出现「做完了就标完成」和「还在等结果不能自己标」两句互相矛盾的话
  const t5 = fresh()
  applyPlan(t5, { steps: [{ title: '推 dev 并核实 CI 变绿', status: 'running' }, { title: '写文档' }] })
  bindWait(t5, '1', { kind: 'background', ref: 'job1', label: 'CI' })
  const r5 = applyPlan(t5, { partial: true, steps: [{ id: '2', status: 'done' }] })
  assert.equal(activePlan(t5)!.steps[0].status, 'waiting', '还在等结果，状态不变')
  assert.doesNotMatch(r5.info, /没交上来[\s\S]*推 dev/, '等结果的步骤不该被点名去「标完成」')
  assert.match(r5.info, /不用交|等结果/, '要说明这类步骤不用交、结果回来面板会标完成')
  assert.doesNotMatch(r5.info, /还在等结果，不能自己标完成/, '没去标它就不会触发 held 的退回提示')
  // 等待挂在子步骤上时同样不能点名：主步骤标完成会级联把子步骤一起标完成（update 里的 want === 'done'），
  // 然后被 held 按 [s, ...s.children] 递归退回。left 和 held 必须覆盖同一个区间，不然主步骤照样白跑一轮
  const t6 = fresh()
  applyPlan(t6, {
    steps: [
      { title: '跑端到端', status: 'running', children: [{ title: '跑 local 分片', status: 'running' }] },
      { title: '写文档' },
    ],
  })
  bindWait(t6, '1.1', { kind: 'background', ref: 'job2', label: 'local 分片' })
  const r6 = applyPlan(t6, { partial: true, steps: [{ id: '2', status: 'done' }] })
  assert.doesNotMatch(r6.info, /没交上来[\s\S]*跑端到端/, '子步骤在等结果时，主步骤也不该被点名去「标完成」')
  assert.match(r6.info, /不用交/, '要说明这类步骤不用交')
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
  assert.equal(activePlan(bad)!.steps[0].status, 'failed')
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

test('等子任务的步骤：子任务成功了才标完成，失败或被终止标失败并写清原因', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '派版本控制收尾', status: 'running' }, { title: '汇总' }] })
  assert.match(bindWait(task, '1', { kind: 'helper', ref: 'chat/sub/h1', label: '版本控制' }), /等待中/)
  assert.equal(settleWait(task, 'helper', 'chat/sub/h1', false).length, 1)
  assert.equal(activePlan(task)!.steps[0].status, 'failed')
  assert.match(activePlan(task)!.steps[0].note, /版本控制/)
  bindWait(task, '1', { kind: 'helper', ref: 'chat/sub/h2', label: '版本控制' })
  settleWait(task, 'helper', 'chat/sub/h2', true)
  assert.equal(activePlan(task)!.steps[0].status, 'done')
})

/**
 * 回归（用户 2026-10-25 报）：上一份计划已经结束，父对话接着派了 6 个子对话，
 * 计划面板还停在上次「已完成」，子对话在父对话的计划里完全看不见。
 * 现在派子对话一定挂上一步：计划结束了就重开它、补一步（标 auto），标题用子对话的标题。
 */
test('计划结束后派子对话：重开那份计划并补一步，子对话挂上去看得见', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面', status: 'done' }] })
  assert.equal(activePlan(task), undefined, '计划已经结束')
  const at = ensureChildStep(task, 'kid-1', '设计页 AI 对话复用 Chat 样式')
  const plan = activePlan(task)!
  assert.ok(plan, '计划被重新打开')
  assert.equal(plan.steps.find((s) => s.id === at)?.title, '子对话：设计页 AI 对话复用 Chat 样式')
  assert.equal(plan.steps.find((s) => s.id === at)?.auto, true, '标成面板自动加的')
  assert.match(bindWait(task, at, { kind: 'child', ref: 'kid-1', label: '设计页 AI 对话复用 Chat 样式' }), /等待中/)
  assert.equal(plan.steps.find((s) => s.id === at)?.status, 'waiting')
  // 同一份计划，不新开：用户要看的是同一个对话的计划列表
  assert.equal(task.plans.length, 1)
})

test('多个子对话同时派出去：全进同一份计划，各自一步', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面', status: 'done' }] })
  const ids = ['子对话甲', '子对话乙', '子对话丙'].map((t, i) => ensureChildStep(task, `kid-${i}`, t))
  assert.equal(task.plans.length, 1, '只重开一份计划')
  const plan = activePlan(task)!
  assert.equal(plan.steps.filter((s) => s.auto).length, 3, '三个子对话各一步')
  assert.equal(new Set(ids).size, 3, '各挂各的步骤')
})

test('有进行中的计划但对不上某一步：补一步，不另开计划', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面', status: 'running' }] })
  const at = ensureChildStep(task, 'kid-1', '另外一件事')
  assert.equal(task.plans.length, 1)
  const plan = activePlan(task)!
  assert.equal(plan.steps.length, 2)
  assert.equal(plan.steps.find((s) => s.id === at)?.auto, true)
})

test('能对上已有的那一步就不用补：标题说的是同一件事时挂到那一步', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '设计页 AI 对话复用 Chat 样式' }, { title: '功能面板默认对半' }] })
  assert.equal(ensureChildStep(task, 'kid-1', '设计页 AI 对话复用 Chat 样式'), '1')
  assert.equal(activePlan(task)!.steps.length, 2, '没有多出步骤')
})

test('已结束计划重开时补的步骤排在收尾前面，收尾仍在最后', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改界面' }] }, undefined, 'push')
  const plan = activePlan(task)!
  assert.equal(plan.steps.at(-1)?.wrapUp, 'push')
  finishPlan(task)
  const at = ensureChildStep(task, 'kid-1', '收尾后又派的子对话')
  const reopened = activePlan(task)!
  assert.equal(reopened.steps.at(-1)?.wrapUp, 'push', '收尾还是最后一步')
  assert.equal(reopened.steps.at(-2)?.id, at)
})

/**
 * 自动补的步骤不能被 Agent 下一次 set_plan 抹掉：Agent 不知道有这一步，交整份计划时不会写它。
 * 以前没写到的未完成步骤算「不做了」，自动步骤会当场被删，等于白挂。
 */
test('Agent 交整份计划：自动补的步骤没写也不会被删，原位保留', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A' }, { title: 'B' }] })
  const at = ensureChildStep(task, 'kid-1', '子对话甲')
  bindWait(task, at, { kind: 'child', ref: 'kid-1', label: '子对话甲' })
  // Agent 交整份计划，只写自己那两步（不知道有自动那一步）
  const r = applyPlan(task, {
    steps: [
      { id: '1', title: 'A', status: 'done' },
      { id: '2', title: 'B' },
    ],
  })
  const plan = activePlan(task)!
  assert.ok(
    plan.steps.some((s) => s.id === at && s.auto),
    '自动步骤还在',
  )
  assert.equal(plan.steps.find((s) => s.id === at)?.status, 'waiting', '它等的东西也还在')
  assert.doesNotMatch(r.info, /已从计划里去掉：.*子对话甲/, '不提示它被去掉')
  // 也不点名让 Agent 交（它不是 Agent 写的）
  const r2 = applyPlan(task, { partial: true, steps: [{ id: '1', title: 'A' }] })
  assert.doesNotMatch(r2.info, /没交上来.*子对话甲/)
})

test('Agent 自己写了同标题的步骤：对上自动那一步，不出现两条一样的', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A' }] })
  const at = ensureChildStep(task, 'kid-1', '子对话甲')
  applyPlan(task, {
    steps: [
      { id: '1', title: 'A' },
      { title: '子对话：子对话甲', status: 'done' },
    ],
  })
  const plan = activePlan(task)!
  assert.equal(plan.steps.filter((s) => s.title === '子对话：子对话甲').length, 1, '只有一条')
  assert.equal(plan.steps.find((s) => s.id === at)?.status, 'done', '标的是自动那一步')
})

/** finish_plan 说清在跑的子对话：计划一结束它们就挂不上了，用户看到的就是「已完成 + 一堆子对话在跑」 */
test('finish_plan：子对话还没合回时点名提醒', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A' }] })
  const kids = [
    { id: 'kid-1', title: '修登录', createdAt: '2026-10-25T00:00:00.000Z', done: false },
    { id: 'kid-2', title: '改样式', createdAt: '2026-10-25T00:00:00.000Z', done: true, endedAt: '' },
  ]
  const r = finishPlan(task, undefined, undefined, kids)
  assert.match(r.info, /这些子对话还没合回：「修登录」/)
  assert.doesNotMatch(r.info, /改样式/, '已经合回的不点名')
  // 没有没合回的子对话时不多说
  const clean = finishPlan(fresh2(), undefined, undefined, [kids[1]])
  assert.doesNotMatch(clean.info, /还没合回/)
})

const fresh2 = () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A' }] })
  return task
}

test('从来没过计划就派子对话：开一份新计划并补一步', () => {
  const task = fresh()
  const at = ensureChildStep(task, 'kid-1', '第一件事')
  const plan = activePlan(task)!
  assert.ok(plan)
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].id, at)
  assert.equal(plan.steps[0].title, '子对话：第一件事')
  assert.equal(plan.steps[0].auto, true)
})

/** 回归（评审 R1）：重开已结束的计划后，总用时不能把上一轮的历史时长并进这一轮 */
test('重开已结束的计划：总用时从重开时刻算，不把上一轮那段并进来', () => {
  const base = Date.parse('2026-10-25T10:00:00.000Z')
  const iso = (ms: number) => new Date(ms).toISOString()
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A' }] }, iso(base))
  // 10 分钟后提前结束
  finishPlan(task, undefined, iso(base + 600_000))
  assert.equal(planSpan(task.plans[0], base + 600_000), 600_000, '结束时是 10 分钟')
  // 11:00 才派子对话：重开这份计划
  const at = ensureChildStep(task, 'kid-1', '新派的事', iso(base + 3_600_000))
  const plan = activePlan(task)!
  assert.equal(plan.id, task.plans[0].id, '重开的是同一份')
  assert.equal(plan.reopenedAt, iso(base + 3_600_000))
  // 重开后刚开始：用时是 0，不是 1 小时
  assert.equal(planSpan(plan, base + 3_600_000), 0)
  assert.equal(planSpan(plan, base + 3_660_000), 60_000, '只算重开之后的那一分钟')
  assert.equal(plan.steps.find((s) => s.id === at)?.auto, true)
})

/** 回归（评审 R2）：给已完成的子对话再发消息，复用原来那一步，不补一条「子对话：<id>」 */
test('给已做完的子对话再发消息：重新打开原来那一步，不靠 id 当标题另开一格', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A' }, { title: 'B' }] })
  const at = ensureChildStep(task, 'kid-1', '子对话甲')
  bindWait(task, at, { kind: 'child', ref: 'kid-1', label: '子对话甲' })
  settleWait(task, 'child', 'kid-1', true)
  assert.equal(activePlan(task)!.steps.find((s) => s.id === at)?.status, 'done')
  // 又交给它一件新事（send_to_conversation 没有 title）
  const again = ensureChildStep(task, 'kid-1', '')
  assert.equal(again, at, '还是原来那一步')
  const plan = activePlan(task)!
  assert.equal(plan.steps.filter((s) => s.title.includes('kid-1')).length, 0, '没有出现用 id 当标题的步骤')
  assert.equal(plan.steps.filter((s) => s.auto).length, 1, '没有多出一步')
  assert.equal(plan.steps.find((s) => s.id === at)?.title, '子对话：子对话甲', '标题还是原来那个')
})

test('用户点「解决」：没做完的步骤连同子步骤一起收口成完成，计划落到 done', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: 'A', status: 'done' },
      { title: 'B', status: 'running', children: [{ title: 'B1' }, { title: 'B2', status: 'done' }] },
      { title: 'C', status: 'waiting' },
    ],
  })
  // 还在等后台命令的那一步：收口时面板写的「还在等它」说明和等待状态一起清掉
  bindWait(task, '3', { kind: 'background', ref: 'job1', label: 'e2e' })
  holdWait(task, 'background', 'job1', '端到端测试')
  const plan = activePlan(task)!
  assert.equal(settlePlan(task), 3, '收口了 B、B1、C 三项（已完成的 A、B2 不算）')
  assert.deepEqual(
    plan.steps.map((s) => s.status),
    ['done', 'done', 'done'],
    '进行中、等待中的都收口，不能留一个「执行中」挂在已解决的对话上',
  )
  assert.deepEqual(
    plan.steps[1].children.map((c) => c.status),
    ['done', 'done'],
    '子步骤递归收口',
  )
  assert.equal(
    plan.steps[2].waits.every((w) => w.state !== 'waiting'),
    true,
    '不再挂着等待',
  )
  assert.equal(plan.steps[2].note, '', '面板写的「还在等它：…」跟着清掉')
  // 折叠头、进度、列表三处读到同一个结论：全部做完
  assert.equal(planHeadline(plan), 'done')
  assert.deepEqual(leftSteps(plan), [])
  assert.equal(unfinishedSteps(plan), 0)
  assert.equal(openPlan(task), undefined, '不再显示「计划 n/m」')
})

test('收口已经「提前结束」的计划：closed 变 done；没有计划或已经全部完成时什么都不动', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [{ title: 'A', status: 'done' }, { title: 'B' }],
  })
  finishPlan(task)
  const plan = task.plans![0]
  assert.equal(planHeadline(plan), 'closed', '前提：finish_plan 结束的计划还留着没做完的步骤')
  assert.equal(settlePlan(task), 1, '提前结束的计划也要能收口')
  assert.equal(planHeadline(plan), 'done')
  assert.equal(settlePlan(task), 0, '再收一次没东西可收')
  assert.equal(settlePlan(fresh()), 0, '没有计划时不动')
  const done = fresh()
  applyPlan(done, { steps: [{ title: 'A', status: 'done' }] })
  assert.equal(settlePlan(done), 0, '已经全部做完的计划不动')
  assert.equal(activePlan(done), undefined, '收口不会重新打开一份已经结束的计划')
})

/**
 * 回归（评审 R1）：工作流步骤的子项不是 `children`，而是那次运行的节点（见 planChildren）。
 * 只收口主步骤的话，折叠头说「计划已完成」，展开却还挂着失败的节点
 */
test('工作流没跑完的节点跟着收口成「跳过」：折叠头和展开的节点都说完成', () => {
  const node = (id: string, title: string, status: string) => ({
    id,
    parentId: '',
    slot: '',
    kind: 'agent',
    title,
    status,
    startedAt: '2026-10-24T10:00:00.000Z',
    endedAt: status === 'done' ? '2026-10-24T10:01:00.000Z' : '',
  })
  const task = {
    plans: [],
    steps: [node('r3/n1', '分析', 'done'), node('r3/n2', '实现', 'failed'), node('r3/n3', '测试', 'pending')],
  } as unknown as Pick<Task, 'plans' | 'steps'>
  bindRun(task, '', 3, '工作流「开发」')
  // 运行失败结束：主步骤还在进行中，备注写着「工作流没走完」
  endRun(task, 3, false, '实现 失败')
  const plan = activePlan(task)!
  assert.match(plan.steps[0].note, /^工作流没走完：/)
  assert.deepEqual(
    planChildren(task, plan.steps[0]).map((c) => c.status),
    ['done', 'pending', 'pending'],
    '前提：失败 / 没跑的节点在计划里算未完成',
  )
  // 主步骤 + 两个没跑完的节点
  assert.equal(settlePlan(task), 3)
  assert.equal(planHeadline(plan), 'done')
  assert.deepEqual(
    planChildren(task, plan.steps[0]).map((c) => c.status),
    ['done', 'done', 'done'],
    '展开的节点也全是完成，不能头部说完成、展开还有「未完成」',
  )
  assert.equal(plan.steps[0].note, '', '「工作流没走完」的备注跟着清掉')
  // 不谎称做完了：没跑完的节点标的是跳过，运行记录本身不动
  assert.deepEqual(
    task.steps.map((s) => s.status),
    ['done', 'skipped', 'skipped'],
  )
  assert.notEqual(task.steps[2].endedAt, '', '跳过时补上结束时间')
})

/**
 * ADR 0020：状态机、时间戳与检测。
 * 失败不是终态（还要重做或明确跳过），跳过是终态；running 唯一；没有等的东西的 waiting 按进行中算；
 * 计划滞后与新输入检测都只此一处实现。
 */
const T0 = '2026-10-28T10:00:00.000Z'
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString()

test('失败不是终态：计划不收起；明确跳过是终态：计划跟着收起', () => {
  const task = fresh()
  applyPlan(task, {
    steps: [
      { title: 'A', status: 'done' },
      { title: 'B', status: 'failed' },
    ],
  })
  const plan = activePlan(task)!
  assert.equal(plan.doneAt, '', '还有一步失败需要处理，计划不能收起')
  assert.equal(planHeadline(plan), 'open')
  assert.equal(unfinishedSteps(plan), 1, '失败算没做完，会挡住收尾')
  assert.equal(openPlan(task)?.done, 1)
  // 放弃这一步：标跳过、计划全部终态，收起
  applyPlan(task, { partial: true, steps: [{ id: '2', title: 'B', status: 'skipped' }] })
  const closed = task.plans![0]
  assert.notEqual(closed.doneAt, '')
  assert.equal(planHeadline(closed), 'done', '跳过算处理过了，不能一直说还有遗留')
  assert.deepEqual(leftSteps(closed), [])
  assert.equal(isSettled('skipped'), true)
  assert.equal(isSettled('failed'), false)
})

test('一份计划里同一层只能有一个进行中：同一批标了多个，只留最后一个并说明', () => {
  const task = fresh()
  const r = applyPlan(task, {
    steps: [{ title: 'A', status: 'running' }, { title: 'B', status: 'running' }, { title: 'C' }],
  })
  assert.deepEqual(
    activePlan(task)!.steps.map((s) => s.status),
    ['pending', 'running', 'pending'],
    '留下的是最后标的那个（对话刚转向的一步）',
  )
  assert.match(r.info, /同时只能有一个/)
  // 子步骤层同样唯一：主步骤进行中、子步骤里留下最后一个
  const kids = fresh()
  applyPlan(kids, {
    steps: [
      {
        title: 'A',
        children: [
          { title: 'A1', status: 'running' },
          { title: 'A2', status: 'running' },
        ],
      },
    ],
  })
  assert.deepEqual(
    activePlan(kids)!.steps[0].children.map((c) => c.status),
    ['pending', 'running'],
  )
})

test('写着等待中却没有在等的东西：按进行中算，并说明原因', () => {
  const task = fresh()
  const r = applyPlan(task, { steps: [{ title: 'A', status: 'waiting' }] })
  assert.equal(activePlan(task)!.steps[0].status, 'running')
  assert.match(r.info, /没有在等的东西/)
  // 真挂着等待的不动
  const real = fresh()
  applyPlan(real, { steps: [{ title: 'B' }] })
  bindWait(real, '1', { kind: 'background', ref: 'job1', label: 'e2e' })
  applyPlan(real, { partial: true, steps: [{ id: '1', title: 'B', status: 'waiting' }] })
  assert.equal(activePlan(real)!.steps[0].status, 'waiting')
})

test('计划内容真变了才推进「最后变化时间」：原样重交不算更新', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A' }, { title: 'B' }] }, at(0))
  const plan = activePlan(task)!
  assert.equal(plan.updatedAt, at(0))
  // 原样重交：不动时间，否则每轮重交一遍就能把「多久没更新」洗掉
  applyPlan(
    task,
    {
      steps: [
        { id: '1', title: 'A', status: 'pending' },
        { id: '2', title: 'B' },
      ],
    },
    at(5),
  )
  assert.equal(plan.updatedAt, at(0))
  // 真改了状态：推进
  applyPlan(task, { partial: true, steps: [{ id: '1', title: 'A', status: 'running' }] }, at(6))
  assert.equal(plan.updatedAt, at(6))
  // 步骤自己也有最后变化时间（滞后检测按它算）
  assert.equal(itemUpdatedAt(plan.steps[0]), Date.parse(at(6)))
})

test('滞后检测：running 超过阈值才提醒，waiting / failed 不算；差 1 毫秒不提醒', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '接线', status: 'running' }, { title: '跑测试' }] }, T0)
  const t0 = Date.parse(T0)
  assert.equal(staleStep(task, t0 + PLAN_STALE_MS - 1), undefined, '刚好没到阈值不提醒')
  const hit = staleStep(task, t0 + PLAN_STALE_MS)!
  assert.equal(hit.item.title, '接线')
  assert.match(planNotice(task, t0 + PLAN_STALE_MS), /计划还停在「接线」/)
  // 等待中的不提醒：跑 10 分钟 e2e 是正常的
  const waiting = fresh()
  applyPlan(waiting, { steps: [{ title: '跑 e2e' }] }, T0)
  bindWait(waiting, '1', { kind: 'background', ref: 'job1', label: 'e2e' }, T0)
  assert.equal(staleStep(waiting, t0 + 10 * 60_000), undefined)
  assert.equal(planNotice(waiting, t0 + 10 * 60_000), '')
  // 失败也不提醒：它已经是一个要处理的状态
  const failed = fresh()
  applyPlan(failed, { steps: [{ title: '跑 e2e' }] }, T0)
  bindWait(failed, '1', { kind: 'background', ref: 'job2', label: 'e2e' }, T0)
  settleWait(failed, 'background', 'job2', false, at(1))
  assert.equal(staleStep(failed, t0 + 10 * 60_000), undefined)
})

test('新输入之后计划没动过：提醒一次；改了计划、或已经提醒过那一次就不再提', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A' }, { title: 'B' }] }, T0)
  const plan = activePlan(task)!
  plan.lastInputAt = at(1)
  assert.equal(inputUnhandled(plan, Date.parse(at(2))), 60_000)
  assert.match(planNotice(task, Date.parse(at(2))), /进来了新要求/)
  // 改了计划：不再提醒
  applyPlan(task, { partial: true, steps: [{ id: '1', title: 'A', status: 'running' }] }, at(3))
  assert.equal(inputUnhandled(activePlan(task)!, Date.parse(at(4))), undefined)
  assert.doesNotMatch(planNotice(task, Date.parse(at(4))), /进来了新要求/)
  // 已经提醒过的那一次不重复追（对话选择「不改计划、说明一句」时不能被每轮追问）
  const noted = activePlan(task)!
  noted.lastInputAt = at(5)
  noted.updatedAt = at(4)
  noted.inputNotedAt = at(5)
  assert.equal(inputUnhandled(noted, Date.parse(at(6))), undefined)
})

test('计划重建：上一份没做完就结束（换方向）算重建，正常做完之后开的不算', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A', status: 'running' }, { title: 'B' }] })
  finishPlan(task)
  applyPlan(task, { title: '换个做法', steps: [{ title: 'C' }] })
  assert.equal(planRebuilt(task), true)
  const ok = fresh()
  applyPlan(ok, { steps: [{ title: 'A', status: 'done' }] })
  applyPlan(ok, { title: '下一件事', steps: [{ title: 'B' }] })
  assert.equal(planRebuilt(ok), false)
})

test('没有 updatedAt 的旧计划：最后变化时间退回开始时间，解析不出来的返回 undefined', () => {
  const old = {
    id: '1',
    title: 'A',
    status: 'running' as const,
    note: '',
    waits: [],
    startedAt: T0,
    endedAt: '',
  }
  assert.equal(itemUpdatedAt(old), Date.parse(T0))
  const plan = { id: 'p1', title: '', steps: [], createdAt: T0, doneAt: '', summary: '', autoSummary: false }
  assert.equal(planUpdatedAt(plan), Date.parse(T0))
  assert.equal(planUpdatedAt({ ...plan, createdAt: '不是时间' }), undefined)
  assert.equal(itemUpdatedAt({ ...old, startedAt: '' }), undefined)
})

test('每轮正面提示：第几步、这一步已多久、下一步是什么', () => {
  const task = fresh()
  applyPlan(
    task,
    { steps: [{ title: 'A', status: 'done' }, { title: '接线', status: 'running' }, { title: '跑测试' }] },
    T0,
  )
  const text = planNowText(task, Date.parse(at(6)))
  assert.match(text, /现在：第 2 步「接线」进行中（已 6 分钟）/)
  assert.match(text, /下一步是「跑测试」/)
  // 刚开始：不说成「已 1 分钟」
  assert.match(planNowText(task, Date.parse(at(0))), /刚开始/)
  // 没有进行中的步骤：指出下一步是第几步
  const idle = fresh()
  applyPlan(idle, { steps: [{ title: 'A' }, { title: 'B' }] }, T0)
  assert.match(planNowText(idle, Date.parse(T0)), /没有进行中的步骤，下一步是第 1 步「A」/)
  assert.equal(planNowText(fresh(), Date.parse(T0)), '', '没有计划时不出这段')
})

test('刚重建的计划又在整份改：提示先在原计划上增量，不要反复重建', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A', status: 'running' }, { title: 'B' }] }, at(0))
  finishPlan(task, undefined, at(1))
  // 上一份没做完就结束了（重建），新计划刚开 2 分钟又整份换
  const r = applyPlan(task, { title: '换个方向', steps: [{ title: 'C' }, { title: 'D' }] }, at(2))
  assert.match(r.info, /刚重建的/)
  // 正常做完之后开的新计划不算重建，不提示
  const ok = fresh()
  applyPlan(ok, { steps: [{ title: 'A', status: 'done' }] }, at(0))
  const r2 = applyPlan(ok, { title: '下一件事', steps: [{ title: 'B', status: 'running' }] }, at(1))
  assert.doesNotMatch(r2.info, /刚重建的/)
})

test('原样重交整份计划不刷新步骤的最后变化时间（滞后检测不会被洗掉）', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A', status: 'running' }, { title: 'B' }] }, at(0))
  const step = activePlan(task)!.steps[0]
  assert.equal(itemUpdatedAt(step), Date.parse(at(0)))
  // Agent 按「每次交整份」的习惯把同一份重交一遍：这一步没变，计时不能被刷新
  applyPlan(
    task,
    {
      steps: [
        { id: '1', title: 'A', status: 'running' },
        { id: '2', title: 'B' },
      ],
    },
    at(5),
  )
  assert.equal(itemUpdatedAt(step), Date.parse(at(0)), '原样重交不刷新')
  // 计时仍是第 0 分钟：第 2 分钟没到阈值、第 4 分钟就命中（原样重交没有把计时洗到第 5 分钟）
  assert.equal(staleStep(task, Date.parse(at(2))), undefined)
  assert.notEqual(staleStep(task, Date.parse(at(4))), undefined)
  // 内容真变了才刷新
  applyPlan(task, { partial: true, steps: [{ id: '1', title: 'A', status: 'running', note: '改了备注' }] }, at(6))
  assert.equal(itemUpdatedAt(step), Date.parse(at(6)))
})

test('同批多个进行中：还挂着结果的退回等待中（不是待做），结果回来照样收口', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '等端到端', status: 'running' }, { title: '写文档' }] }, at(0))
  bindWait(task, '1', { kind: 'background', ref: 'job1', label: '端到端测试' }, at(0))
  // Agent 一次整份提交里把两步都写成进行中
  const r = applyPlan(
    task,
    {
      steps: [
        { id: '1', title: '等端到端', status: 'running' },
        { id: '2', title: '写文档', status: 'running' },
      ],
    },
    at(1),
  )
  const plan = activePlan(task)!
  assert.equal(plan.steps[0].status, 'waiting', '还挂着等待的退回等待中，保住收口入口')
  assert.equal(plan.steps[0].waits[0]?.state, 'waiting')
  assert.equal(plan.steps[1].status, 'running')
  assert.match(r.info, /等待中（它还在等结果/)
  // 结果回来照样能收口，不会永远停在待做
  settleWait(task, 'background', 'job1', true, at(2))
  assert.equal(activePlan(task)!.steps[0].status, 'done')
})

test('只改步骤名也刷新这一项的最后变化时间（改标题不能算没变化）', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '跑端到端测试', status: 'running' }, { title: 'B' }] }, at(0))
  const step = activePlan(task)!.steps[0]
  assert.equal(itemUpdatedAt(step), Date.parse(at(0)))
  // 只改名字（提示词规则里「改步骤名」明确算增量更新）：这一步确实变过，滞后计时要从现在重新算
  applyPlan(task, { partial: true, steps: [{ id: '1', title: '跑端到端测试（WSL）', status: 'running' }] }, at(4))
  assert.equal(itemUpdatedAt(step), Date.parse(at(4)), '只改标题也要刷新')
  assert.equal(staleStep(task, Date.parse(at(4))), undefined, '刚改过名字，不该马上被判滞后')
})

test('子对话执行失败：上报带上这次失败的原因，父对话不用去翻', () => {
  const child = (messages: TaskMessage[]) =>
    ({ status: 'failed', working: false, requests: [], plans: [], steps: [], messages }) as unknown as Task
  // 重试耗尽：上游报错原文跟着上报，而不是只有一句「执行失败了」
  const retry: TaskMessage = {
    id: 'm1',
    role: 'system',
    agentId: '',
    step: '',
    text: '',
    at: '',
    tools: [
      {
        kind: 'other',
        name: '提示',
        label: '自动重试 3 次后仍然失败：502 Bad Gateway',
        detail: '',
        failed: true,
        alert: makeAlert('error', '自动重试 3 次后仍然失败：502 Bad Gateway'),
      },
    ],
  }
  const r = childReport(child([retry]))
  assert.equal(r.state, 'failed')
  assert.match(r.why, /执行失败了/)
  assert.match(r.why, /自动重试 3 次后仍然失败/)
  assert.match(r.why, /502 Bad Gateway/)

  // 面板写的失败消息（进程被回收、面板出错）也要能说清
  const killed: TaskMessage = {
    id: 'm2',
    role: 'system',
    agentId: '',
    step: '',
    text: '',
    at: '',
    tools: [],
    error: true,
    alert: makeAlert('error', '面板回收了这个对话的进程：空闲超过 30 分钟'),
  }
  assert.match(childReport(child([killed])).why, /面板回收了这个对话的进程/)

  // 实际撞上的主因：面板工具没接上（握手 / 列工具超时），子对话这一轮跑挂
  const tools: TaskMessage = {
    id: 'm4',
    role: 'system',
    agentId: '',
    step: '',
    text: '',
    at: '',
    tools: [],
    alert: makeAlert('error', '面板的工具没接上（握手等了 4 秒还没回应）：这一轮所有面板工具都不可用'),
  }
  assert.match(childReport(child([tools])).why, /面板的工具没接上.*握手等了 4 秒/)

  // 已经恢复的报错不是这次失败的原因
  const resolved: TaskMessage = { ...killed, id: 'm3', alert: { ...killed.alert!, resolved: '已恢复' } }
  assert.equal(childReport(child([resolved])).why, '失败：执行失败了')

  // 没有任何报错时只说失败，不编原因
  assert.equal(childReport(child([])).why, '失败：执行失败了')
})
