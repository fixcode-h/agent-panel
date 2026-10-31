import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handoffInput, handoffMissing, handoffTemplate, handoffText } from './handoff.ts'

const facts = {
  title: '修登录',
  request: '登录按钮在 Safari 上没反应',
  note: '改了点击事件',
  tests: 'npm test 通过',
  branch: 'agent/abc',
  base: 'dev',
  commits: ['1234567 Agent 面板：修登录'],
  changed: { 'web/src/Login.tsx': '3/1' },
}

test('关键信息：只认模板字段，数组按行拼，空白丢掉；必填的 files 没写要报出来', () => {
  const h = handoffInput({ files: ['a.ts — 入口', 'b.ts — 工具'], docs: '  ', other: 'x', decisions: 1 })
  assert.deepEqual(h, { files: 'a.ts — 入口\nb.ts — 工具' })
  assert.deepEqual(handoffMissing({}), ['关键文件和模块'])
  assert.deepEqual(handoffMissing(h), [])
  assert.deepEqual(handoffInput(undefined), {})
  assert.match(handoffTemplate(), /files（关键文件和模块）[\s\S]*followups（遗留和后续）/)
})

test('交接摘要：子对话写的在前，面板补的需求、验证、提交和改动文件在后，没写的段落不出现', () => {
  const text = handoffText({ files: 'web/src/Login.tsx — 点击事件', pitfalls: 'Safari 不认 onPointerUp' }, facts)
  assert.match(text, /已经做完一次并合回了「dev」/)
  const order = ['## 原始需求', '## 关键文件和模块', '## 试过不行的和要注意的', '## 当时的验证', '## 合回的改动']
  const at = order.map((h) => text.indexOf(h))
  assert.ok(
    at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])),
    at.join(','),
  )
  assert.ok(!text.includes('## 相关文档'), '没写的段落不出现')
  assert.match(text, /1234567 Agent 面板：修登录/)
  assert.match(text, /web\/src\/Login\.tsx（3\/1）/)
})
