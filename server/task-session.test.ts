import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionChanged } from '../shared/task.ts'
import type { TaskMessage } from '../shared/schema.ts'

const msg = (run?: TaskMessage['run']): TaskMessage => ({
  id: 'm',
  role: 'agent',
  agentId: '',
  step: '',
  text: '',
  tools: [],
  at: '',
  ...(run ? { run } : {}),
})

test('会话：换了 CLI 必须开新会话', () => {
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: [] }, 'claude', 'x', true), true)
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: [] }, 'codex', 'x', true), false)
})

test('会话：换了模型时，只有和模型绑定的 CLI 要开新会话', () => {
  const messages = [msg({ cli: 'codex', model: 'gpt-6-astra', effort: '' })]
  // Codex 的线程里存着上一个模型的工具调用，换模型后不能再续接
  assert.equal(sessionChanged({ sessionCli: 'codex', messages }, 'codex', 'deepseek', true), true)
  // 其他 CLI 的会话不绑定模型，续接即可
  assert.equal(sessionChanged({ sessionCli: 'claude', messages }, 'claude', 'other', false), false)
})

test('会话：模型没变、或者最后一条回复是别的 CLI 的，不用重开', () => {
  const same = [msg({ cli: 'codex', model: 'gpt-6-astra', effort: '' })]
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: same }, 'codex', 'gpt-6-astra', true), false)

  const other = [msg({ cli: 'claude', model: 'opus', effort: '' })]
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: other }, 'codex', 'deepseek', true), false)
  assert.equal(sessionChanged({ messages: [] }, 'codex', 'deepseek', true), false)
})
