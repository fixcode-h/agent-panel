import assert from 'node:assert/strict'
import test from 'node:test'
import { BUG_ASK_REDIRECT, bugAskRedirect } from './no-ask.ts'

/** 用户 2026-11-13 报的：诊断停在论证第 1 轮，Agent 弹提问窗口问用哪个方案，而不是把方案写进报告 */
test('用户报的 Bug（子对话）：提问改道成交诊断报告，说清选方案写进修复方案', () => {
  assert.equal(bugAskRedirect({ bug: { kind: 'report' }, parentTaskId: 'p' }), BUG_ASK_REDIRECT)
  assert.match(BUG_ASK_REDIRECT, /不用提问工具/)
  assert.match(BUG_ASK_REDIRECT, /phase: plan/)
  assert.match(BUG_ASK_REDIRECT, /改用方案 X/)
})

test('普通对话、直接修的 Bug：照常提问', () => {
  assert.equal(bugAskRedirect({ parentTaskId: '' }), undefined)
  assert.equal(bugAskRedirect({ bug: { kind: 'fix' }, parentTaskId: 'p' }), undefined)
})

test('普通对话里就地查的 Bug：修完之后恢复正常提问；还没修完时改道', () => {
  assert.equal(bugAskRedirect({ bug: { kind: 'report' }, parentTaskId: '' }), BUG_ASK_REDIRECT)
  assert.equal(bugAskRedirect({ bug: { kind: 'report' }, parentTaskId: '', resolved: true }), undefined)
})
