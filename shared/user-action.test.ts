/**
 * 等你操作（request_user_action）的登记、结束、撤掉，以及它怎么算进对话状态（见 shared/user-action.ts）。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionPrompt,
  cancelAction,
  pendingAction,
  requestAction,
  settleAction,
  waitedMinutes,
  type UserAction,
} from './user-action.ts'
import { convState, userWaiting } from './task.ts'

const input = {
  title: '跑一次 PIE，抓路牌的 Actor 路径',
  why: '确认偏移出在生成时还是加载后',
  collect: { steps: ['打开 L_Town 点运行', '走到路牌旁边停 2 秒'], filter: 'OnCreated hit', kind: 'result' },
  fallback: '先按加载后偏移查',
}
const T0 = '2026-11-05T10:00:00.000Z'

test('登记：写进对话、状态是在等；一次只挂一件', () => {
  const tk: { userActions?: UserAction[] } = {}
  const r = requestAction(tk, input, 'a1', T0)
  assert.equal(r.ok, true)
  assert.equal(pendingAction(tk)?.id, 'a1')
  assert.equal(pendingAction(tk)?.collect.filter, 'OnCreated hit')
  const again = requestAction(tk, input, 'a2', T0)
  assert.equal(again.ok, false)
  assert.equal(tk.userActions?.length, 1)
})

test('登记：缺标题、步骤、退路时拒绝并说清缺哪项；Bug 对话走诊断报告', () => {
  const miss = requestAction({}, { title: 'x' }, 'a1', T0)
  assert.equal(miss.ok, false)
  assert.match(miss.info, /collect\.steps/)
  assert.match(miss.info, /fallback/)
  const bug = requestAction({ bug: { kind: 'report' } }, input, 'a1', T0)
  assert.equal(bug.ok, false)
  assert.match(bug.info, /submit_diagnosis/)
})

test('结束：交回 / 完成 / 跳过各推回一句；做不了必须写原因；结束过的不能再结束', () => {
  const tk: { userActions?: UserAction[] } = {}
  requestAction(tk, input, 'a1', T0)
  const no = settleAction(tk, 'a1', 'cannot', { text: ' ' })
  assert.equal(no.ok, false)
  const r = settleAction(tk, 'a1', 'skipped', {}, '2026-11-05T10:12:30.000Z')
  assert.ok(r.ok)
  assert.match(r.prompt, /跳过/)
  assert.match(r.prompt, /先按加载后偏移查/)
  assert.equal(pendingAction(tk), undefined)
  assert.equal(waitedMinutes(r.action), 12)
  assert.equal(settleAction(tk, 'a1', 'done').ok, false)
  assert.equal(settleAction(tk, 'nope', 'done').ok, false)
})

test('交回：记下原文和附件路径，推回的话说清后面跟着的是交回的内容', () => {
  const tk: { userActions?: UserAction[] } = {}
  requestAction(tk, input, 'a1', T0)
  const r = settleAction(tk, 'a1', 'returned', { text: 'OnCreated hit BP_RoadSign_C', files: ['C:/log.txt'] })
  assert.ok(r.ok)
  assert.equal(r.action.reply?.files[0], 'C:/log.txt')
  assert.match(actionPrompt(r.action), /交回的内容/)
})

test('撤掉：停止对话时还在等的那件记成已撤掉', () => {
  const tk: { userActions?: UserAction[] } = {}
  requestAction(tk, input, 'a1', T0)
  assert.equal(cancelAction(tk, '对话被停止了')?.status, 'cancelled')
  assert.equal(pendingAction(tk), undefined)
  assert.equal(cancelAction(tk, 'x'), undefined)
})

test('状态：挂着等你操作算「等你处理」，并算进 userWaiting（结束前钩子、收尾都放行）', () => {
  const tk = { requests: [], userActions: [] as UserAction[] }
  assert.equal(userWaiting(tk), false)
  requestAction(tk, input, 'a1', T0)
  assert.equal(userWaiting(tk), true)
  assert.equal(convState({ status: 'done', working: false, action: true }), 'needs')
})
