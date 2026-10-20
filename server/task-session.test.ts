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
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: [] }, 'claude', 'x'), true)
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: [] }, 'codex', 'x'), false)
})

test('会话：换了模型都开新会话', () => {
  const codex = [msg({ cli: 'codex', model: 'gpt-6-astra', effort: '' })]
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: codex }, 'codex', 'deepseek'), true)
  const claude = [msg({ cli: 'claude', model: 'sonnet', effort: '' })]
  assert.equal(sessionChanged({ sessionCli: 'claude', messages: claude }, 'claude', 'other'), true)
})

test('会话：不支持中途换强度的 CLI，换了强度也开新会话', () => {
  const messages = [msg({ cli: 'commandcode', model: 'fake/pro', effort: 'high' })]
  assert.equal(sessionChanged({ sessionCli: 'commandcode', messages }, 'commandcode', 'fake/pro', 'low', true), true)
  assert.equal(sessionChanged({ sessionCli: 'commandcode', messages }, 'commandcode', 'fake/pro', 'low', false), false)
})

test('会话：模型和强度没变、或者最后一条回复是别的 CLI 的，不用重开', () => {
  const same = [msg({ cli: 'codex', model: 'gpt-6-astra', effort: 'high' })]
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: same }, 'codex', 'gpt-6-astra', 'high', true), false)

  const other = [msg({ cli: 'claude', model: 'opus', effort: '' })]
  assert.equal(sessionChanged({ sessionCli: 'codex', messages: other }, 'codex', 'deepseek'), false)
  assert.equal(sessionChanged({ messages: [] }, 'codex', 'deepseek'), false)
})
