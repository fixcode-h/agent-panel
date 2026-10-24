/**
 * 执行中收到消息后的落脚点：这一轮里交不出去的消息记下来、这一轮结束后接着处理；
 * 能用面板工具取补充的调用登记后取走，取过的不再给。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import type { Task, TaskMessage } from '../../shared/schema.ts'
import { addNoteTaker, dropHeld, hasHeld, holdForNextTurn, removeHeld, removeNoteTaker, takeHeld } from './delivery.ts'
import { steerTask } from './runner.ts'

setLang('zh')

const msg = (id: string, text: string): TaskMessage => ({
  id,
  role: 'user',
  agentId: '',
  step: '',
  text,
  tools: [],
  at: '2026-10-21T00:00:00.000Z',
})

const chat = (id: string) => ({ id, mode: 'chat', messages: [], steps: [] }) as unknown as Task

test('交不出去的消息记在这一轮之后处理：按顺序取，取完就没有了', () => {
  const id = 'task-held'
  assert.equal(hasHeld(id), false)
  holdForNextTurn(id, { ...msg('m1', '先改配置'), attachments: [] })
  holdForNextTurn(id, { ...msg('m2', '再跑测试'), attachments: [] })
  assert.equal(hasHeld(id), true)
  assert.deepEqual(takeHeld(id), { id: 'm1', text: '先改配置', attachments: [] })
  // 还剩一条：这一轮结束后还要再接着处理
  assert.equal(hasHeld(id), true)
  assert.equal(takeHeld(id)?.text, '再跑测试')
  assert.equal(hasHeld(id), false)
  assert.equal(takeHeld(id), undefined)
})

test('这一轮失败或暂停：不再自动接着跑，消息留在对话里', () => {
  const id = 'task-drop'
  holdForNextTurn(id, { ...msg('m1', '算了'), attachments: [] })
  dropHeld(id)
  assert.equal(hasHeld(id), false)
})

test('撤掉一条自动询问时，用户的消息保持原来的顺序', () => {
  const id = 'task-remove'
  holdForNextTurn(id, { ...msg('ask', '【状态询问】'), attachments: [] })
  holdForNextTurn(id, { ...msg('user', '用户的新消息'), attachments: [] })
  removeHeld(id, 'ask')
  assert.equal(hasHeld(id), true)
  assert.deepEqual(takeHeld(id), { id: 'user', text: '用户的新消息', attachments: [] })
  assert.equal(hasHeld(id), false)
})

test('撤掉不存在的 id 不影响队列；全撤完就清掉', () => {
  const id = 'task-remove-missing'
  holdForNextTurn(id, { ...msg('a', 'a'), attachments: [] })
  removeHeld(id, 'nope')
  assert.equal(hasHeld(id), true)
  assert.equal(takeHeld(id)?.id, 'a')
  removeHeld(id, 'a')
  assert.equal(hasHeld(id), false)
})

test('能用面板工具取补充的 CLI：登记后取走，取过的不会再给；没取走的这一轮结束后接着处理', async () => {
  const task = chat('task-notes')
  const pending = new Set<TaskMessage>()
  const taker = { add: (m: TaskMessage) => pending.add(m), read: () => [] }
  addNoteTaker(task.id, taker)
  try {
    const first = msg('m1', '接口要兼容旧版')
    assert.equal(await steerTask(task, '接口要兼容旧版', first), 'notes', '没有插话协议时登记给取补充的通道')
    assert.deepEqual(
      task.messages.map((m) => m.text),
      ['接口要兼容旧版'],
      '消息立刻出现在对话里，不用等 CLI 取走',
    )
    assert.deepEqual([...pending], [first])
    // 模型调用 read_user_notes：取到的交给它，之后的输出另起一条（由 runner 处理）
    pending.clear()
    assert.equal(await steerTask(task, '第二个补充', msg('m2', '第二个补充')), 'notes')
    assert.deepEqual(
      [...pending].map((m) => m.text),
      ['第二个补充'],
      '取过的不会再给',
    )
  } finally {
    removeNoteTaker(task.id, taker)
  }
  // 通道没了：消息交给调用方，由它记进对话并等这一轮结束后接着处理
  assert.equal(await steerTask(task, '通道已经关了', msg('m3', '通道已经关了')), false)
})
