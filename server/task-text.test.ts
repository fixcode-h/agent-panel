import assert from 'node:assert/strict'
import test from 'node:test'
import { dropEndNotes, questionAnswers, stripToolMarkup } from '../shared/task.ts'
import type { TaskMessage } from '../shared/schema.ts'

test('模型当成文字说出来的工具调用写法不进正文', () => {
  // 半截的参数（截图里的样子）：去掉到结尾
  assert.equal(
    stripToolMarkup('先问一下风格。\nparameter name="questions" string="false">[{"question": "整体风格？"}]'),
    '先问一下风格。',
  )
  // 完整的调用：前后的话留着
  assert.equal(
    stripToolMarkup('好的 <invoke name="ask_user"><parameter name="q">x</parameter></invoke> 后面'),
    '好的\n\n后面',
  )
  assert.equal(stripToolMarkup('我来问 <function_calls>\n<invoke name="x">\n<parameter name="a">1'), '我来问')
  // 普通文字、代码里讲 XML 的不动
  const plain = '提到 parameter 和 invoke 两个词，name="x" 也没事'
  assert.equal(stripToolMarkup(plain), plain)
  const code = '配置写成 `<parameter name="a">` 就行\n```xml\n<parameter name="b">1</parameter>\n```'
  assert.equal(stripToolMarkup(code), code)
})

test('继续执行前去掉结束时写的临时说明，已经接上正常消息的不动', () => {
  const note = (id: string, extra: Partial<TaskMessage> = {}): TaskMessage => ({
    id,
    role: 'system',
    agentId: '',
    step: '',
    text: id,
    tools: [],
    at: '',
    ...extra,
  })
  const task = {
    messages: [note('a'), note('pause', { transient: true }), note('error', { transient: true, error: true })],
  }
  dropEndNotes(task)
  assert.deepEqual(
    task.messages.map((m) => m.id),
    ['a'],
    '结尾的暂停 / 失败说明都去掉',
  )
  const after = { messages: [note('pause', { transient: true }), { ...note('u'), role: 'user' as const }] }
  dropEndNotes(after)
  assert.equal(after.messages.length, 2, '后面已经有新要求时不动')
})

test('回答的问题和答案一一对应，没回答时没有', () => {
  assert.deepEqual(
    questionAnswers(
      { title: '风格？', questions: [{ question: '风格？' }, { question: '题材？' }] as never },
      { allow: true, answers: ['深色', '机械'] },
    ),
    [
      { question: '风格？', answer: '深色' },
      { question: '题材？', answer: '机械' },
    ],
  )
  assert.deepEqual(questionAnswers({ title: '做什么？' }, { allow: true, answer: '改按钮' }), [
    { question: '做什么？', answer: '改按钮' },
  ])
  assert.equal(questionAnswers({ title: '做什么？' }, { allow: false }), undefined)
})
