import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from './schema.ts'
import {
  activePlan,
  applyPlan,
  bindRun,
  bindWait,
  childTurnSettle,
  endRun,
  finishPlan,
  holdWait,
  openPlan,
  planProgress,
  settleWait,
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

test('子步骤都完成，主步骤跟着完成；全部完成后要先写总结才能开新计划', () => {
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
  assert.match(r.info, /finish_plan/)
  assert.equal(activePlan(task), undefined)
  assert.ok(unsummarized(task))
  assert.equal(applyPlan(task, { steps: [{ title: 'B' }] }).ok, false)
  assert.ok(finishPlan(task, '做完了 A').ok)
  assert.equal(unsummarized(task), undefined)
  // 新内容开一份新计划，旧的留着
  applyPlan(task, { steps: [{ title: 'A' }] })
  assert.equal(task.plans.length, 2)
  assert.equal(activePlan(task)!.steps[0].status, 'pending')
})

test('还有没完成的步骤时不收总结', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: 'A', status: 'done' }, { title: 'B' }] })
  const r = finishPlan(task, '总结')
  assert.equal(r.ok, false)
  assert.match(r.info, /「B」/)
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
      ...extra,
    }) as unknown as Pick<Task, 'status' | 'working' | 'requests' | 'plans'>
  /** 子对话自己的计划：做完了的收起（doneAt），没做完的还挡着收口 */
  const childPlan = (done: boolean) => {
    const tk = fresh() as unknown as Task
    applyPlan(tk, { steps: [{ title: '改文件', status: done ? 'done' : 'running' }] })
    return tk.plans
  }

  // 跑完一轮、计划做完了、没有后台命令和提问：算交付完成
  const ok = childTurnSettle(child({ plans: childPlan(true) }))
  assert.equal(ok.over, true)
  assert.equal(ok.ok, true)
  const okTask = waiting()
  assert.deepEqual(settleWait(okTask, 'child', 'kid', ok.ok), [{ title: '改文件', done: true }])
  assert.equal(okTask.plans![0].steps[0].status, 'done')
  assert.ok(okTask.plans![0].doneAt)

  // 这一轮结束了，但子对话的计划还没做完：继续等，父计划那一步不能标完成
  const planLeft = childTurnSettle(child({ plans: childPlan(false) }))
  assert.equal(planLeft.over, false)
  assert.equal(planLeft.ok, false)
  assert.match(planLeft.why, /计划还没做完.*改文件/)
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

  // 还有后台命令在跑：继续等，note 里点名是哪条命令
  const bgLeft = childTurnSettle(child(), { background: ['后端单测'] })
  assert.equal(bgLeft.over, false)
  assert.match(bgLeft.why, /后台命令在跑.*后端单测/)
  const bgTask = waiting()
  holdWait(bgTask, 'child', 'kid', bgLeft.why)
  assert.match(activePlan(bgTask)!.steps[0].children[0].note, /后端单测/)

  // 这一轮结束后还要接着处理排队的消息：还没交付完
  assert.equal(childTurnSettle(child(), { more: true }).over, false)

  // 还在跑：不能当成完成
  assert.equal(childTurnSettle(child({ working: true })).over, false)

  // 有没答的提问：子对话是停下来等用户，不收口，步骤继续挂着等
  const request = [{}] as unknown as Task['requests']
  const ask = childTurnSettle(child({ requests: request }), { background: ['不该看到这个'] })
  assert.equal(ask.over, false)
  assert.match(ask.why, /没答的提问/)
  const askTask = waiting()
  holdWait(askTask, 'child', 'kid', ask.why)
  assert.equal(activePlan(askTask)!.steps[0].status, 'waiting')

  // 执行失败、被停止：退回进行中，note 里看得出是等谁失败了；有未完成计划也算结束
  for (const status of ['failed', 'stopped'] as const) {
    const r = childTurnSettle(child({ status, plans: childPlan(false) }))
    assert.equal(r.over, true)
    assert.equal(r.ok, false)
    assert.match(r.why, status === 'failed' ? /执行失败/ : /被停止/)
    const badTask = waiting()
    assert.deepEqual(settleWait(badTask, 'child', 'kid', r.ok), [{ title: '改文件', done: false }])
    const item = activePlan(badTask)!.steps[0].children[0]
    assert.equal(item.status, 'running')
    assert.match(item.note, /改文件/)
  }
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
    const r = childTurnSettle(
      { status: 'running', working: false, requests: [], plans: child.plans },
      { background: ['端到端测试'] },
    )
    assert.equal(r.over, false)
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
  assert.ok(unsummarized(task))
  // 没有计划时启动工作流：开一份计划，工作流是第一步
  const other = fresh()
  bindRun(other, '', 1, '工作流「默认」')
  assert.equal(activePlan(other)!.steps[0].title, '工作流「默认」')
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
