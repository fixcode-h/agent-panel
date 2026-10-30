import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskMessage } from './schema.ts'
import { parseReport, peerOfMessage, sentToOther, subjectLine } from './peer-message.ts'

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

test('sentToOther：同一段话已经交给了别的子对话时返回它；同一个子对话、失败的那次、别的话都不算', () => {
  const send = (id: string, message: string, failed = false) => ({
    kind: 'other' as const,
    name: 'MCP',
    label: 'panel · send_to_conversation',
    detail: '',
    input: JSON.stringify({ id, message }),
    ...(failed && { failed: true }),
  })
  const task = { messages: [msg({ role: 'agent', tools: [send('c1', '硬规则 A'), send('c3', '硬规则 B', true)] })] }
  assert.equal(sentToOther(task, 'c2', ' 硬规则 A '), 'c1')
  assert.equal(sentToOther(task, 'c1', '硬规则 A'), undefined)
  assert.equal(sentToOther(task, 'c2', '硬规则 B'), undefined)
  assert.equal(sentToOther(task, 'c2', '别的事'), undefined)
})

test('parseReport：汇报拆成状态、子对话、计划步骤、下一步、最近的结果，旧数据和认不出的兜底', () => {
  const r = parseReport(
    '（计划步骤「排查 401」、「补翻译」等的结果到了：先处理这一步，再接着按计划做。）\n' +
      '【子对话状态】「401 排查」（id c1）已中断：父对话结束时一起结束\n' +
      '下一步：要重试就用 send_to_conversation 交回这个子对话（id c1），它在原来的会话里接着做。\n' +
      '最近的结果：跑了解析测试\n第二行',
  )
  assert.deepEqual(r, {
    steps: ['排查 401', '补翻译'],
    stepsDone: false,
    child: '401 排查',
    state: '已中断',
    reason: '父对话结束时一起结束',
    next: ['要重试就用 send_to_conversation 交回这个子对话，它在原来的会话里接着做。'],
    result: '跑了解析测试\n第二行',
    rest: '',
  })
  // 计划步骤那句不当标题
  assert.equal(
    subjectLine('（计划步骤「a」等的结果到了：先处理这一步。）\n【子对话状态】「x」已完成：合回'),
    '「x」已完成：合回',
  )
})

test('parseReport：旧数据下一步没写前缀也归到下一步；只有计划步骤那句时后面原样保留；都认不出返回 null', () => {
  const old = parseReport('【子对话状态】「x」（id c1）失败：报错\n要重试就交回这个子对话。')
  assert.deepEqual([old?.state, old?.reason, old?.next], ['失败', '报错', ['要重试就交回这个子对话。']])
  const job = parseReport('（计划步骤「编译」等的结果到了，已标为完成：先看一眼结果。）\n命令输出\n\n第二段')
  assert.deepEqual([job?.steps, job?.stepsDone, job?.child, job?.rest], [['编译'], true, '', '命令输出\n\n第二段'])
  assert.equal(parseReport('普通的一段话'), null)
})
