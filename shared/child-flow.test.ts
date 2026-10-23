import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import type { Task } from './schema.ts'
import {
  advanceChild,
  childComplete,
  childFlowAt,
  childFlowOf,
  childFlowSteps,
  childHolds,
  childHoldText,
  childHoldsOf,
  childStage,
  type ChildEntry,
  type ChildFlowState,
  type ChildFlowStep,
  type ChildHold,
} from './task.ts'

// 文案断言按中文：跟着系统语言跑会让结果不稳定
setLang('zh')

/** 列表里那一行：状态和图标都读这一份（见 TaskView 的 childGroups / childStage） */
const row = (x: ChildFlowState): ChildEntry => ({
  id: 'c',
  title: '子对话',
  status: 'running',
  working: !!x.working,
  cliAlive: false,
  startedAt: '',
  plan: x.plan,
  background: x.background,
  workflow: x.workflow,
  helpers: x.helpers,
  asking: x.asking,
  requests: x.requests,
  unmerged: x.unmerged,
  resolved: x.completed,
})

/** 记下三次回调的先后：子对话置完成 → 上报父对话 → 父对话列表重取 */
function recorder() {
  const calls: ChildFlowStep[] = []
  const host = {
    complete: () => void calls.push('complete'),
    report: () => void calls.push('report'),
    list: () => void calls.push('list'),
  }
  return { calls, host }
}

test('子对话完成按 wrapup → plan → pending → complete → report → list 单向走，不能跳步', () => {
  assert.deepEqual(
    [...childFlowSteps],
    ['wrapup', 'plan', 'pending', 'complete', 'report', 'list'],
    '顺序写死在这一处，别处按它走',
  )
})

test('计划没做完：父对话点标记完成不置完成、状态不前进，列表仍显示未完成', async () => {
  const { calls, host } = recorder()
  const state: ChildFlowState = { working: false, plan: { done: 5, total: 7 } }
  const run = await advanceChild(state, host)
  assert.deepEqual(calls, [], '一步都没走：既没置完成，也没上报父对话')
  assert.deepEqual(run.steps, [])
  assert.deepEqual(run.holds, ['plan'], '卡在计划那一步')
  assert.deepEqual(run.left, ['plan', 'pending', 'complete', 'report', 'list'], '剩下的步骤一步都没动')
  assert.equal(run.info, childHoldText(['plan']), '把卡在哪一项说清楚，界面直接显示这句')
  // 父对话列表按子对话自己的状态算：没置完成就还是「未完成」，转圈照旧
  assert.equal(childStage(row(state)), 'unfinished')
})

test('后台命令还在跑：父对话点标记完成同样不置完成、不前进，列表显示执行中', async () => {
  const { calls, host } = recorder()
  const state: ChildFlowState = { working: false, plan: { done: 7, total: 7 }, background: 2 }
  const run = await advanceChild(state, host)
  assert.deepEqual(calls, [])
  assert.deepEqual(run.holds, ['background'])
  assert.deepEqual(run.left, ['pending', 'complete', 'report', 'list'])
  assert.equal(run.info, childHoldText(['background']))
  assert.equal(childStage(row(state)), 'running', '后台命令没跑完就是还在执行')
})

test('这一轮还在跑 / 独立分支没合回：卡在前两步，父对话的标记完成被拒绝', async () => {
  // 这一轮还在跑：卡在第 1 步
  const workingRun = await advanceChild({ working: true }, recorder().host)
  assert.deepEqual(workingRun.holds, ['working'])
  assert.deepEqual(workingRun.left, [...childFlowSteps])
  // 这一轮收尾了，但独立分支还有没合回去的改动：卡在第 3 步
  const unmergedRun = await advanceChild({ working: false, unmerged: true }, recorder().host)
  assert.deepEqual(unmergedRun.holds, ['unmerged'])
  assert.deepEqual(unmergedRun.left, ['pending', 'complete', 'report', 'list'])
  // 卡住的原因是「没合回父对话所在的分支」这一件本地的事，不扯推送
  assert.equal(unmergedRun.info, childHoldText(['unmerged']))
  assert.doesNotMatch(unmergedRun.info, /推送|远端|push|remote|origin/i)
})

test('子分支都合进父分支就算完成：推送、远端、父分支上的其他提交都不参与', () => {
  // ChildFlowState 里根本没有与推送相关的字段：unmerged 只来自「子分支还有没合回父分支的提交」
  const idle = { working: false, plan: { done: 3, total: 3 }, background: 0, asking: 0, requests: 0, unmerged: false }
  assert.deepEqual(childHolds(idle), [], '合回父分支就是做完了，没有别的条件')
  assert.equal(childComplete(idle), true)
  assert.equal(childFlowAt(idle), 'complete', '流转也直接走到置完成')
  // 反例：只差合并这一条
  assert.deepEqual(childHolds({ ...idle, unmerged: true }), ['unmerged'])
  assert.equal(childComplete({ ...idle, unmerged: true }), false)
})

test('卡住的原因只说本地合并：所有文案里都没有推送、远端字样', () => {
  const all: ChildHold[] = ['working', 'background', 'workflow', 'helpers', 'plan', 'asking', 'requests', 'unmerged']
  for (const h of all) assert.doesNotMatch(childHoldText([h]), /推送|远端|push|remote|origin|其他分支/i)
  assert.match(childHoldText(['unmerged']), /独立分支还没合回原分支/)
  // 组合起来也不带：界面把整串直接显示给用户
  assert.doesNotMatch(childHoldText(['plan', 'unmerged', 'requests']), /推送|远端|push|remote|origin/i)
})

test('全部收口：子对话先置完成，再上报父对话，父对话列表最后才变', async () => {
  const order: string[] = []
  // 跟着回调往后走的状态：用来断言每一步之前走到了哪
  const live: ChildFlowState = {
    working: false,
    plan: { done: 7, total: 7 },
    background: 0,
    asking: 0,
    requests: 0,
  }
  const run = await advanceChild(live, {
    complete() {
      assert.equal(childFlowAt(live), 'complete', '前三步先过了才走到置完成')
      live.completed = true
      order.push('complete')
    },
    report() {
      assert.equal(live.completed, true, '子对话自己先置完成，才轮到上报')
      assert.equal(childFlowAt(live), 'report', '上报是第 5 步')
      live.reported = true
      order.push('report')
    },
    list() {
      assert.equal(live.reported, true, '父对话收到上报之后，列表才刷新')
      order.push('list')
    },
  })
  assert.deepEqual(run.steps, ['complete', 'report', 'list'], '这次做了后三步，按这个先后')
  assert.deepEqual(order, ['complete', 'report', 'list'])
  assert.deepEqual(run.left, [], '整条链走完了')
  assert.deepEqual(run.holds, [])
  // 列表最后变：上报之前这一行还没标记「已解决」，上报之后才标记上
  assert.equal(row({ ...live, completed: false, reported: false }).resolved, false)
  assert.equal(row(live).resolved, true)
  assert.equal(childStage(row(live)), 'done')
})

test('幂等：全部走完再调一次什么都不做，只差上报时只补上报、不重复置完成', async () => {
  const { calls, host } = recorder()
  const doneRun = await advanceChild({ completed: true, reported: true, plan: { done: 3, total: 3 } }, host)
  assert.deepEqual(doneRun.steps, [], '重复调用不跳步、不重做')
  assert.deepEqual(calls, [])
  // 置完成成功、上报还没成功（比如进程刚好重启）：只补第 5 步，不会再置一次完成
  const halfway = await advanceChild({ completed: true, reported: false }, host)
  assert.deepEqual(halfway.steps, ['report', 'list'])
  assert.deepEqual(calls, ['report', 'list'])
})

test('置完成那一步交回原因（独立分支回收失败）就停在原地，不上报也不让列表变', async () => {
  const calls: ChildFlowStep[] = []
  const run = await advanceChild(
    { completed: false, reported: false },
    {
      complete: () => {
        calls.push('complete')
        return { holds: ['unmerged'], info: '分支没删掉' }
      },
      report: () => void calls.push('report'),
      list: () => void calls.push('list'),
    },
  )
  assert.deepEqual(calls, ['complete'], '只试了置完成')
  assert.deepEqual(run.steps, [], '这一次不算走完任何一步')
  assert.deepEqual(run.holds, ['unmerged'])
  assert.deepEqual(run.left, ['complete', 'report', 'list'])
  assert.equal(run.info, '分支没删掉')
})

test('childFlowOf：和 childHoldsOf 用同一套判定，另外带出完成 / 上报走到哪一步', () => {
  const task = (over: Partial<Task> = {}) =>
    ({
      status: 'running',
      working: false,
      requests: [],
      parentAsks: [],
      plans: [],
      steps: [],
      resolved: false,
      ...over,
    }) as Task
  // 同一份任务：两套口子必须说一样的话，不能各判一套
  for (const t of [
    task(),
    task({ working: true }),
    task({ resolved: true }),
    task({ parentAsks: [{ id: 'a' }] as Task['parentAsks'] }),
  ]) {
    for (const extra of [{}, { background: 1 }, { merged: false }]) {
      assert.deepEqual(
        childHoldsOf(t, extra),
        childHolds(childFlowOf(t, extra)),
        'childHoldsOf 走 childFlowOf，不再自己拼一份',
      )
    }
  }
  assert.equal(childFlowOf(task({ resolved: true })).completed, true)
  assert.equal(childFlowOf(task(), { reported: true }).reported, true)
  assert.equal(childFlowOf(task()).completed, false)
  assert.deepEqual(childHoldsOf(task({ parentAsks: [{ id: 'a' }] as Task['parentAsks'] }), { merged: false }), [
    'asking',
    'unmerged',
  ])
})
