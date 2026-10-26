import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeTarget } from './api-probe.ts'

test('测试连接用哪个模型：没有模型时退回只验证连接', () => {
  assert.equal(probeTarget([], ''), '')
  assert.equal(probeTarget([], 'gpt-5'), '')
})

test('测试连接用哪个模型：没选时用第一个（默认模型）', () => {
  assert.equal(probeTarget(['claude-opus', 'claude-sonnet'], ''), 'claude-opus')
})

test('测试连接用哪个模型：选中的在列表里就用它', () => {
  assert.equal(probeTarget(['claude-opus', 'claude-sonnet'], 'claude-sonnet'), 'claude-sonnet')
})

test('测试连接用哪个模型：选过的模型被移除或换了协议后回到第一个', () => {
  assert.equal(probeTarget(['claude-opus'], 'claude-sonnet'), 'claude-opus')
})
