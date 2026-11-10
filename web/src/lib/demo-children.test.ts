import assert from 'node:assert/strict'
import test from 'node:test'
import { Task } from '../../../shared/schema.ts'
import { demoChildRows } from './demo-children.ts'

// 演示版子对话行要和正式后端同字段：孙对话在等你处理（childNeeds）、没有摘要时用最后一条回复兜底
const iso = new Date().toISOString()
const make = (id: string, parentTaskId?: string, extra: Record<string, unknown> = {}) =>
  Task.parse({
    id,
    createdAt: iso,
    updatedAt: iso,
    projectId: 'p',
    title: id,
    mode: 'chat',
    status: 'done',
    parentTaskId,
    ...extra,
  })

test('演示版子对话行：带 childNeeds，摘要为空时取最后一条回复', () => {
  const parent = make('p1')
  const child = make('c1', 'p1', {
    messages: [{ id: 'm1', role: 'agent', agentId: '', step: '', text: '  改好了\n两个文件 ', tools: [], at: iso }],
  })
  const grand = make('g1', 'c1', { parentAsks: [{ id: 'a1', question: '用哪个？', options: [] }] })
  const [row] = demoChildRows(parent, [parent, child, grand], () => false)
  assert.equal(row.childNeeds, 1, '孙对话在提问，子对话行也算等你处理')
  assert.equal(row.summary, '改好了 两个文件')
})
