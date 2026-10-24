import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskMessage } from './schema.ts'
import { peerOfMessage, subjectLine } from './peer-message.ts'

const msg = (over: Partial<TaskMessage>): TaskMessage => ({
  id: 'm1',
  role: 'system',
  agentId: '',
  step: '',
  text: '',
  tools: [],
  at: '2026-10-24T00:00:00.000Z',
  ...over,
})

test('subjectLine：去掉开头的【标签】，取第一行非空的话，太长截断', () => {
  assert.equal(subjectLine('【父对话收尾】没能合回原分支：冲突\n详细'), '没能合回原分支：冲突')
  assert.equal(subjectLine('\n\n  第二行  \n'), '第二行')
  assert.equal(subjectLine('一'.repeat(200), 10), `${'一'.repeat(9)}…`)
})

test('peerOfMessage：新数据直接用 peer；旧数据的子对话上报、收尾请求、编译申请按 panel 补上', () => {
  const peer = { id: 'p', title: '父', name: '统筹', rel: 'parent' as const, kind: 'task' as const, subject: '' }
  assert.equal(peerOfMessage(msg({ role: 'user', peer })), peer)
  const child = { id: 'c', title: '修侧栏', state: 'failed' }
  assert.deepEqual(peerOfMessage(msg({ panel: 'child', child, text: '【子对话状态】失败' })), {
    id: 'c',
    title: '修侧栏',
    name: '修侧栏',
    rel: 'child',
    kind: 'report',
    subject: '',
    failed: true,
  })
  assert.equal(peerOfMessage(msg({ panel: 'wrapup', child, text: '【收尾请求】x' }))?.kind, 'wrapup')
  assert.equal(peerOfMessage(msg({ panel: 'wrapup', child, text: '【编译申请】x' }))?.kind, 'build')
  // 认不出是谁发的（面板替用户说的话、后台命令结果）不算对话之间的消息
  assert.equal(peerOfMessage(msg({ panel: 'child', text: '用户已经直接回答了' })), undefined)
  assert.equal(peerOfMessage(msg({ panel: 'background', text: '后台命令跑完了' })), undefined)
})
