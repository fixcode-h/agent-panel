import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task, TaskMessage, ToolUse } from '../../shared/schema.ts'
import { commandNeedle, recordGrant } from './record.ts'

const agent = (tools: Partial<ToolUse>[], step = ''): TaskMessage => ({
  id: `a${Math.random()}`,
  role: 'agent',
  agentId: 'a',
  step,
  text: '',
  tools: tools.map((t) => ({ kind: 'run', label: '', detail: '', ...t })),
  at: '',
})
const ctx = (messages: TaskMessage[]) => {
  let n = 0
  return { task: { messages } as unknown as Task, newId: () => `n${++n}`, changed: () => {} }
}

test('命令按开头认到工具行，挂上小标，系统消息照样留着', () => {
  const row = agent([{ kind: 'run', label: 'git status --short', input: 'git status --short' }])
  const c = ctx([row])
  const n = recordGrant(c, {
    agentId: 'a',
    step: '',
    text: '整条都是只读命令，自动允许：git status --short',
    grant: { via: 'readonly', label: '', title: 'git status --short' },
    match: { kinds: ['run'], needle: commandNeedle('git  status --short') },
  })
  assert.equal(c.task.messages.at(-1), n)
  assert.deepEqual(row.tools[0].grant, { via: 'readonly', label: '', note: n.id })
})

test('只认还在执行的同名面板工具、同一节点，已经挂过的不再挂', () => {
  const done = agent([{ kind: 'other', label: 'panel · custom_tool' }])
  const other = agent([{ kind: 'other', label: 'panel · custom_tool', running: true }], 'n1')
  const live = agent([
    { kind: 'other', label: 'panel · custom_tool', running: true, grant: { via: 'rule', label: '', note: 'old' } },
    { kind: 'other', label: 'panel · custom_tool', running: true },
  ])
  const c = ctx([done, live, other])
  const n = recordGrant(
    c,
    {
      agentId: '',
      step: '',
      text: '按这个对话的放行规则自动允许',
      grant: { via: 'rule', rule: 'ctool:project:x', label: '自建工具「x」', title: 'python x.py' },
      match: { kinds: ['other'], label: /custom_tool/, running: true },
    },
    10_000,
  )
  assert.equal(live.tools[1].grant?.note, n.id)
  assert.equal(live.tools[0].grant?.note, 'old')
  assert.equal(done.tools[0].grant, undefined)
  assert.equal(other.tools[0].grant, undefined)
})
