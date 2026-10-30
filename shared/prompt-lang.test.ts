import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promptUserNameRules } from './prompt-lang.ts'

test('设置里的称呼写进提示词，没填就不加这一节', () => {
  assert.equal(promptUserNameRules(''), '')
  assert.equal(promptUserNameRules('   '), '')
  assert.equal(promptUserNameRules(undefined), '')
  assert.match(promptUserNameRules(' 老板 ', 'zh'), /称呼为「老板」/)
  assert.match(promptUserNameRules('Boss', 'en'), /called "Boss"/)
})
