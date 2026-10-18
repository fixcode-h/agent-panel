import assert from 'node:assert/strict'
import test from 'node:test'
import { toQuestions } from './ask-mcp.ts'

test('模型传来的问题整理成面板的问题，也认只问一个的简单写法', () => {
  const q = toQuestions({
    questions: [
      { header: '方向', question: '做什么？', options: ['a', { label: 'b', description: 'x' }, {}], multiSelect: 1 },
    ],
  })
  assert.deepEqual(q[0].options, [
    { label: 'a', description: '' },
    { label: 'b', description: 'x' },
  ])
  assert.equal(q[0].multiSelect, true)
  assert.equal(toQuestions({ question: '单个问题', options: ['x'] })[0].question, '单个问题')
  assert.deepEqual(toQuestions({ questions: [{ header: '没有问题文字' }] }), [])
})
