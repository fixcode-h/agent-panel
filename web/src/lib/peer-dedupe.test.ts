/**
 * 旧数据里重复写入的子对话汇报在界面上的收拢口径：
 * 同来源、同标题、同正文、10 秒内且相邻才合并，别的都不能少、不能并。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PeerFrom, TaskMessage } from '@shared/schema'
import { dedupePeerReports } from './peer-dedupe.ts'

const peer = (id: string, subject = '已完成'): PeerFrom => ({
  id,
  title: `子对话 ${id}`,
  name: '执行',
  rel: 'child',
  kind: 'report',
  subject,
})

const report = (id: string, from: PeerFrom, text: string, at: string): TaskMessage => ({
  id,
  role: 'system',
  agentId: '',
  step: '',
  text,
  tools: [],
  at,
  panel: 'child',
  child: { id: from.id, title: from.title, state: 'done' },
  peer: from,
})

const user: TaskMessage = {
  id: 'u1',
  role: 'user',
  agentId: '',
  step: '',
  text: '做这个',
  tools: [],
  at: '2026-10-24T07:25:20.000Z',
}

const ids = (list: TaskMessage[]) => list.map((m) => m.id)

test('同子对话、同标题、同正文、相差不到 10 秒的两条只留一条', () => {
  const a = peer('45258768')
  const msgs = [
    user,
    report('r1', a, '【子对话状态】「执行」已完成：交付完了', '2026-10-24T07:25:20.760Z'),
    report('r2', a, '【子对话状态】「执行」已完成：交付完了', '2026-10-24T07:25:21.081Z'),
  ]
  assert.deepEqual(ids(dedupePeerReports(msgs)), ['u1', 'r1'])
})

test('不同子对话的汇报文案一样也不合并', () => {
  const a = peer('45258768')
  const b = peer('e07f1e5a')
  const text = '【子对话状态】「执行」已完成：交付完了'
  const msgs = [report('r1', a, text, '2026-10-24T07:25:20.760Z'), report('r2', b, text, '2026-10-24T07:25:20.900Z')]
  assert.deepEqual(ids(dedupePeerReports(msgs)), ['r1', 'r2'])
})

test('同一个子对话隔了一阵真的又报了一轮，两条都留着', () => {
  const a = peer('45258768')
  const msgs = [
    report('r1', a, '【子对话状态】这一轮结束了', '2026-10-24T07:25:20.760Z'),
    report('r2', a, '【子对话状态】这一轮结束了', '2026-10-24T07:30:20.760Z'),
  ]
  assert.deepEqual(ids(dedupePeerReports(msgs)), ['r1', 'r2'])
})

test('中间隔了别的消息就不算相邻：连续同文案的汇报不并掉', () => {
  const a = peer('45258768')
  const sys: TaskMessage = {
    id: 'sys1',
    role: 'system',
    agentId: '',
    step: '',
    text: '继续',
    tools: [],
    at: '2026-10-24T07:25:20.900Z',
  }
  const msgs = [
    report('r1', a, '【子对话状态】这一轮结束了', '2026-10-24T07:25:20.760Z'),
    sys,
    report('r2', a, '【子对话状态】这一轮结束了', '2026-10-24T07:25:21.000Z'),
  ]
  assert.deepEqual(ids(dedupePeerReports(msgs)), ['r1', 'sys1', 'r2'])
})

test('同子对话、同标题、相邻、时间也近，只有正文不同：不合并', () => {
  const a = peer('45258768')
  const msgs = [
    report('r1', a, '【子对话状态】第一段', '2026-10-24T07:25:20.760Z'),
    report('r2', a, '【子对话状态】第二段', '2026-10-24T07:25:20.800Z'),
  ]
  assert.deepEqual(ids(dedupePeerReports(msgs)), ['r1', 'r2'])
})

test('标题或正文变了、不是汇报的消息、时间解析不了：照旧显示', () => {
  const a = peer('45258768')
  const msgs = [
    report('r1', a, '【子对话状态】第一段', '2026-10-24T07:25:20.760Z'),
    report('r2', peer('45258768', '又做了一步'), '【子对话状态】第一段', '2026-10-24T07:25:20.800Z'),
    report('r3', a, '【子对话状态】第二段', '2026-10-24T07:25:20.840Z'),
    {
      ...report('r4', a, '【子对话状态】第二段', ''),
      at: '不是时间',
    },
  ]
  assert.deepEqual(ids(dedupePeerReports(msgs)), ['r1', 'r2', 'r3', 'r4'])
})

test('别的类型的对话消息（交代任务、传话、请求收尾）不参与去重', () => {
  const task: PeerFrom = { ...peer('p1'), rel: 'parent', kind: 'task', subject: '做这个' }
  const chat: PeerFrom = { ...peer('p2'), rel: 'peer', kind: 'chat', subject: '传话' }
  const text = '同一句'
  const msgs = [
    report('t1', task, text, '2026-10-24T07:25:20.760Z'),
    report('t2', task, text, '2026-10-24T07:25:20.800Z'),
    report('c1', chat, text, '2026-10-24T07:25:20.840Z'),
    report('c2', chat, text, '2026-10-24T07:25:20.880Z'),
  ]
  assert.deepEqual(ids(dedupePeerReports(msgs)), ['t1', 't2', 'c1', 'c2'])
})
