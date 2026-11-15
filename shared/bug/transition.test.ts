import assert from 'node:assert/strict'
import test from 'node:test'
import { Diagnosis } from './diagnosis-schema.ts'
import { canMoveDiagnosis, decisionEffects, moveDiagnosis } from './transition.ts'

/** 诊断报告的状态表（复查报告 A4）：状态只走表里有的路，决定之后的动作由 decisionEffects 列出 */
const diag = (over: Record<string, unknown> = {}) => Diagnosis.parse({ version: 1, at: '', ...over })

test('状态表：等用户的能被决定、取消、顶掉；终点不能再变；不合法的转换直接报错', () => {
  assert.equal(canMoveDiagnosis('pending', 'approved'), true)
  assert.equal(canMoveDiagnosis('questioned', 'superseded'), true)
  assert.equal(canMoveDiagnosis('approved', 'pending'), true, '请用户复现、撤回对话里的确认')
  for (const end of ['answered', 'superseded', 'cancelled'] as const)
    assert.equal(canMoveDiagnosis(end, 'pending'), false, `${end} 是终点`)
  const d = diag({ status: 'cancelled' })
  assert.throws(() => moveDiagnosis(d, 'approved'), /不能从 cancelled 变成 approved/)
  assert.equal(d.status, 'cancelled', '报错时不改')
})

test('决定之后的动作：有话交子对话、同意日志计划拍快照、当场取消且有父对话时上报（摸底第 4 条）', () => {
  const evidence = diag({ phase: 'evidence' })
  assert.deepEqual(decisionEffects(evidence, { approve: true }, '按计划加日志', false), [
    { kind: 'wake', message: '按计划加日志' },
    { kind: 'snapshot-log-base' },
  ])
  assert.deepEqual(decisionEffects(diag({ phase: 'plan' }), { approve: false, cancel: true }, '', true), [
    { kind: 'report-parent' },
  ])
  // 取消时要它先删临时日志：报告等核对完才关，上报留给那一轮的收口
  assert.deepEqual(decisionEffects(diag({ phase: 'plan' }), { approve: false, cancel: true }, '删掉日志', true), [
    { kind: 'wake', message: '删掉日志' },
  ])
})
