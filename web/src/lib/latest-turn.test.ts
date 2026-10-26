/**
 * 「最新的一轮回复」是哪一段：运行区（子对话、子任务、后台命令、工作流运行）挂在它下面。
 * 这里测的就是界面上的口径——用户点发送后那条消息自己成一段，原来那轮回复仍算最新，
 * 运行区不会在 AI 说出第一句话之前整块消失。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestTurnIndex } from './latest-turn.ts'

const turn = { kind: 'turn' }
const msg = { kind: 'msg' }
const steps = { kind: 'steps' }
const run = { kind: 'run' }

test('最后一段就是那一轮回复：直接指向它', () => {
  assert.equal(latestTurnIndex([msg, turn]), 1)
})

test('尾部是刚发出的用户消息：仍然指向前面那一轮回复（发送瞬间的运行区靠它不消失）', () => {
  assert.equal(latestTurnIndex([msg, turn, msg]), 1)
})

test('尾部连着几条用户消息：跳过它们，仍然指向那一轮回复', () => {
  assert.equal(latestTurnIndex([turn, msg, msg]), 0)
})

test('AI 开始输出后新的一轮成为最新', () => {
  assert.equal(latestTurnIndex([msg, turn, msg, turn]), 3)
})

test('尾部是节点输出段：不往前挂到旧的一轮上（避免运行区挂在早就结束的回复下面）', () => {
  assert.equal(latestTurnIndex([msg, turn, steps]), -1)
})

test('尾部是工作流运行卡片：同样不往前挂', () => {
  assert.equal(latestTurnIndex([turn, run]), -1)
})

test('只有用户消息、还没有任何一轮回复：没有最新的一轮', () => {
  assert.equal(latestTurnIndex([msg]), -1)
})

test('空对话：没有最新的一轮', () => {
  assert.equal(latestTurnIndex([]), -1)
})
