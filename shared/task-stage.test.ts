import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import type { Task } from './schema.ts'
import { childComplete, childHolds, childHoldsOf, childHoldText, taskStage } from './task.ts'

// 文案断言按中文：跟着系统语言跑会让结果不稳定
setLang('zh')

test('taskStage：对话交付完一轮（running 但没在跑）算已完成，不是已停止', () => {
  // 子对话做完这一轮后 status 仍是 running、working 回到 false，CLI 在等下一句
  assert.equal(taskStage({ status: 'running', working: false }), 'done')
  assert.equal(taskStage({ status: 'running' }), 'done')
})

test('taskStage：只有 status 是 stopped 才算已停止', () => {
  assert.equal(taskStage({ status: 'stopped' }), 'stopped')
  assert.equal(taskStage({ status: 'stopped', working: true }), 'running')
  assert.equal(taskStage({ status: 'done' }), 'done')
})

test('taskStage：正在跑这一轮算执行中', () => {
  assert.equal(taskStage({ status: 'running', working: true }), 'running')
})

test('taskStage：有等用户确认的请求或没回答的提问，算需要你处理', () => {
  assert.equal(taskStage({ status: 'running', working: true, requests: 1 }), 'you')
  assert.equal(taskStage({ status: 'running', working: false, asking: 2 }), 'you')
  assert.equal(taskStage({ status: 'stopped', requests: 1 }), 'you')
  assert.equal(taskStage({ status: 'running', requests: 0, asking: 0 }), 'done')
})

test('taskStage：失败的任务算需要你处理', () => {
  assert.equal(taskStage({ status: 'failed' }), 'you')
  assert.equal(taskStage({ status: 'failed', working: true }), 'you')
})

test('taskStage：已标记解决但在跑的不算已完成，「已完成」不能盖住还在跑', () => {
  // 正常只在彻底完成时标记解决（见 childHolds）；标早了也不能隐藏还在执行、计划没做完这些事实
  assert.equal(taskStage({ status: 'running', working: true, resolved: true }), 'running')
  assert.equal(taskStage({ status: 'running', working: false, resolved: true }), 'done')
  assert.equal(taskStage({ status: 'stopped', resolved: true }), 'done')
  assert.equal(taskStage({ status: 'running', working: false, resolved: true, unfinished: true }), 'unfinished')
})

test('taskStage：后台命令还在跑就算执行中，不算已完成', () => {
  assert.equal(taskStage({ status: 'running', working: false, background: 2 }), 'running')
  assert.equal(taskStage({ status: 'running', working: false, background: 0 }), 'done')
  assert.equal(taskStage({ status: 'running', working: false, background: 1, resolved: true }), 'running')
})

test('childHolds：合并完成但计划没做完 / 有提问 / 后台命令在跑都不算彻底完成', () => {
  // 合并成功只是分支回去了：计划 5/7、后台还在跑、有待回答的提问时都还要接着做
  assert.deepEqual(childHolds({ plan: { done: 5, total: 7 } }), ['plan'])
  assert.deepEqual(childHolds({ background: 1 }), ['background'])
  assert.deepEqual(childHolds({ asking: 1 }), ['asking'])
  assert.deepEqual(childHolds({ requests: 1 }), ['requests'])
  assert.deepEqual(childHolds({ working: true }), ['working'])
  assert.deepEqual(childHolds({ unmerged: true }), ['unmerged'])
  // 每样都占一点时都列出来，界面按这些原因说明分支为什么还留着
  assert.deepEqual(childHolds({ working: true, background: 1, plan: { done: 1, total: 3 }, asking: 2 }), [
    'working',
    'background',
    'plan',
    'asking',
  ])
  assert.equal(childComplete({ plan: { done: 5, total: 7 } }), false)
  assert.equal(childComplete({ background: 1 }), false)
  assert.equal(childComplete({ asking: 1 }), false)
})

test('childHolds：计划做完、后台结束、没有问题、已经合回去才彻底完成', () => {
  assert.deepEqual(childHolds({}), [])
  assert.equal(childComplete({}), true)
  // 计划步骤都做完了（只是还在写总结）不算没做完
  assert.equal(childComplete({ plan: { done: 7, total: 7 }, background: 0, asking: 0, unmerged: false }), true)
})

test('childHoldsOf：从任务上取状态，后台命令数和合并状态由服务端补上', () => {
  const task = (over: Partial<Task> = {}) =>
    ({
      working: false,
      requests: [],
      parentAsks: [],
      plans: [],
      steps: [],
      ...over,
    }) as Task
  assert.deepEqual(childHoldsOf(task(), { merged: true }), [])
  assert.deepEqual(childHoldsOf(task(), { merged: false }), ['unmerged'])
  assert.deepEqual(childHoldsOf(task({ working: true }), { merged: true }), ['working'])
  assert.deepEqual(childHoldsOf(task(), { background: 2, merged: true }), ['background'])
  assert.deepEqual(childHoldsOf(task({ parentAsks: [{ id: 'a' }] as Task['parentAsks'] }), { merged: true }), [
    'asking',
  ])
  assert.deepEqual(childHoldsOf(task({ requests: [{ id: 'r' }] as Task['requests'] }), { merged: true }), ['requests'])
})

test('childHoldText：每条原因都说清楚，界面和标记完成的提示共用', () => {
  assert.equal(childHoldText(['plan']), '计划还没做完')
  assert.equal(childHoldText(['background', 'asking']), '后台命令还没跑完、还有等你回答的提问')
})

test('taskStage：计划没做完的不算已完成（等着下一句也一样）', () => {
  // 子对话页面底部显示「等待你的下一条消息」，但计划才 7/8
  assert.equal(taskStage({ status: 'running', working: false, unfinished: true }), 'unfinished')
  assert.equal(taskStage({ status: 'running', working: false, unfinished: false }), 'done')
  // 用户主动停下、失败、在等你处理都比「未完成」靠前：那几个已经说明了该怎么办
  assert.equal(taskStage({ status: 'stopped', unfinished: true }), 'stopped')
  assert.equal(taskStage({ status: 'failed', unfinished: true }), 'you')
  assert.equal(taskStage({ status: 'running', working: true, unfinished: true }), 'running', '还在执行就算执行中')
  assert.equal(taskStage({ status: 'running', working: false, unfinished: true, asking: 1 }), 'you')
})
