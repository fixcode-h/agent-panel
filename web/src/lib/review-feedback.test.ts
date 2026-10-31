/**
 * 审阅弹窗「修改」交给 Agent 的意见：逐条带原文和意见，没写意见的标注也要带上，长原文截断。
 * 界面检查 02d 只验一条标注能退回，空意见、整体意见和截断的拼法在这里钉住
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewFeedback } from './review-feedback'

test('标注逐条带原文和意见，整体意见放最后', () => {
  const s = reviewFeedback(
    [
      { quote: '第一段\n  换行了', comment: ' 改成表格 ' },
      { quote: '第二段', comment: '' },
    ],
    '整体再精简',
  )
  assert.equal(
    s,
    [
      '请按下面的标注修改：',
      '',
      '1. 原文：「第一段 换行了」',
      '   意见：改成表格',
      '2. 原文：「第二段」',
      '   意见：（标注了这里，没写具体意见，请重新斟酌这一处）',
      '',
      '整体意见：整体再精简',
    ].join('\n'),
  )
})

test('只有整体意见、长原文截断', () => {
  assert.equal(reviewFeedback([], ' 方向不对 '), '整体意见：方向不对')
  const s = reviewFeedback([{ quote: 'x'.repeat(400), comment: 'a' }], '')
  assert.ok(s.includes('x'.repeat(300) + '…」'))
  assert.ok(!s.includes('x'.repeat(301)))
})
