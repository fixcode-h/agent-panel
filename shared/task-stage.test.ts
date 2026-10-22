import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskStage } from './task.ts'

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

test('taskStage：已解决的子对话归已完成，还在跑也一样', () => {
  assert.equal(taskStage({ status: 'running', working: true, resolved: true }), 'done')
  assert.equal(taskStage({ status: 'failed', resolved: true }), 'done')
  assert.equal(taskStage({ status: 'stopped', resolved: true }), 'done')
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
