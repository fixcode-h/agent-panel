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
  markWrapUp,
  openPlan,
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

test('子对话这一轮结束：成功标完成、失败退回进行中、有提问不算结束', () => {
  // 父对话列好计划，带 step 把子对话挂成等待中
  const waiting = () => {
    const task = fresh()
    applyPlan(task, { steps: [{ title: '派子对话改文件', children: [{ title: '改文件' }] }] })
    bindWait(task, '1.1', { kind: 'child', ref: 'kid', label: '改文件' })
    assert.equal(activePlan(task)!.steps[0].status, 'waiting')
    return task
  }
  const request = [{}] as unknown as Task['requests']

  // 跑完一轮：status 还是 running、只是没在跑（进程留着等下一句），算结束也算成功
  assert.deepEqual(childTurnSettle({ status: 'running', working: false, requests: [] }), { over: true, ok: true })
  const okTask = waiting()
  const ok = childTurnSettle({ status: 'running', working: false, requests: [] })
  assert.deepEqual(settleWait(okTask, 'child', 'kid', ok.ok), [{ title: '改文件', done: true }])
  assert.equal(okTask.plans![0].steps[0].status, 'done')
  assert.ok(okTask.plans![0].doneAt)

  // 还在跑：不能当成完成
  assert.equal(childTurnSettle({ status: 'running', working: true, requests: [] }).over, false)

  // 有没答的提问：子对话是停下来等用户，不收口，步骤继续挂着等
  const askTask = waiting()
  assert.deepEqual(childTurnSettle({ status: 'running', working: false, requests: request }), {
    over: false,
    ok: false,
  })
  assert.equal(activePlan(askTask)!.steps[0].status, 'waiting')

  // 执行失败、被停止：退回进行中，note 里看得出是等谁失败了
  for (const status of ['failed', 'stopped'] as const) {
    assert.deepEqual(childTurnSettle({ status, working: false, requests: [] }), { over: true, ok: false })
    const badTask = waiting()
    const bad = childTurnSettle({ status, working: false, requests: [] })
    assert.deepEqual(settleWait(badTask, 'child', 'kid', bad.ok), [{ title: '改文件', done: false }])
    const item = activePlan(badTask)!.steps[0].children[0]
    assert.equal(item.status, 'running')
    assert.match(item.note, /改文件/)
  }
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

test('不用收尾的对话（父对话、共用目录的 Git 子对话）计划里没有收尾步骤', () => {
  const task = fresh()
  applyPlan(task, { steps: [{ title: '改代码' }] })
  assert.equal(
    activePlan(task)!.steps.some((s) => s.wrapUp),
    false,
  )
  assert.equal(markWrapUp(task, 'merge', 'done'), false)
})
