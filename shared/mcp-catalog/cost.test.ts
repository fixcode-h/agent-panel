import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateTokens, sourceCost } from './cost.ts'

test('tokens 估算：英文按 4 个字符一个，中文按一个字 0.7 个', () => {
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('读写配置表'), 4)
})

test('收进 more_tools 的工具不算进交给 Agent 的', () => {
  const tool = { name: 'a', title: 'a', effects: [], description: 'abc', params: [] }
  const cost = sourceCost({
    servers: [{ name: 's', summary: '', attach: '', tools: [tool, { ...tool, deferred: true }] }],
  })
  assert.equal(cost.tools, 1)
})
