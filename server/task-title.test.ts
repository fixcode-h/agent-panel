import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanTitle, titleInput, titlePrompt } from './task-title.ts'

test('从 CLI 回复里取标题：去掉引号、Markdown、前缀和结尾标点', () => {
  assert.equal(cleanTitle('「修复登录页闪退」'), '修复登录页闪退')
  assert.equal(cleanTitle('\n# 标题：重构任务列表。\n解释……'), '重构任务列表')
  assert.equal(cleanTitle('**"Fix login crash"**'), 'Fix login crash')
  assert.equal(cleanTitle(''), '')
  assert.ok(cleanTitle('很'.repeat(60)).endsWith('…'))
})

test('起标题要有用户消息和 AI 回复', () => {
  const m = (role: 'user' | 'agent', text: string) => ({ role, text, step: '' }) as never
  assert.equal(titleInput({ messages: [m('user', '你好')] }), null)
  const got = titleInput({ messages: [m('user', '做个登录页'), m('agent', '好的，先看看结构')] })
  assert.deepEqual(got, { user: '做个登录页', reply: '好的，先看看结构' })
  assert.match(titlePrompt(got!), /## 用户\n做个登录页/)
})
