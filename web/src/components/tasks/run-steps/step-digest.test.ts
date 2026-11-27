/** 工作流节点卡片的摘要：结论取哪一份、在跑节点列哪几次工具、改过的文件怎么合并 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskMessage, TaskStep } from '@shared/schema'
import { latestText, liveTools, stepFiles, stepMessages, stepReportCount, stepSummary } from './step-digest'

const step = (o: Record<string, unknown>) => TaskStep.parse({ id: 'r1/a', title: '节点', ...o })
const msg = (o: Record<string, unknown>) =>
  TaskMessage.parse({
    id: Math.random().toString(36),
    role: 'agent',
    agentId: '',
    step: 'r1/a',
    text: '',
    at: '',
    ...o,
  })

test('节点消息：含下层节点，不含名字相近的别的节点', () => {
  const task = { messages: [msg({ step: 'r1/a' }), msg({ step: 'r1/a/review' }), msg({ step: 'r1/ab' })] }
  assert.equal(stepMessages(task, 'r1/a').length, 2)
})

test('结论：先用交的总结，再用节点输出，最后用 Agent 最后一句话；失败时写还差什么', () => {
  const said = [msg({ text: '先看看。\n\n**跑完了**，7 步都过了。' })]
  assert.equal(stepSummary(step({ status: 'done', output: '## 结果\n\n定了 7 个测试点' }), said), '结果')
  assert.equal(
    stepSummary(
      step({ status: 'done', output: '输出', submitted: { summary: '- 地图用 TourTest\n- 入口找到了' } }),
      said,
    ),
    '地图用 TourTest 入口找到了',
  )
  assert.equal(stepSummary(step({ status: 'done' }), said), '跑完了，7 步都过了。')
  assert.equal(
    stepSummary(step({ status: 'failed', submitted: { summary: '做了一半', left: '缺地图权限' } }), said),
    '缺地图权限',
  )
  assert.equal(latestText([msg({ text: 'x'.repeat(300) })]).length, 160)
})

test('在跑节点：只列最近几次能显示的工具调用', () => {
  const tools = ['a', 'b', 'c', 'd'].map((label) => ({ kind: 'read', label }))
  const got = liveTools([
    msg({ tools: tools.slice(0, 2) }),
    msg({ role: 'user', tools: [] }),
    msg({ tools: tools.slice(2) }),
  ])
  assert.deepEqual(
    got.map((x) => x.label),
    ['b', 'c', 'd'],
  )
})

test('产出：同一个文件的改动合并，报告按版本数相加', () => {
  const root = step({ changes: [{ path: 'a.lua', add: 2, del: 1 }], submitted: { reports: [] } })
  const kid = TaskStep.parse({
    id: 'r1/a/review',
    parentId: 'r1/a',
    title: '验收',
    changes: [
      { path: 'a.lua', add: 3, del: 0 },
      { path: 'b.lua', add: 1, del: 1 },
    ],
  })
  const task = { steps: [root, kid] }
  assert.deepEqual(stepFiles(task, root), [
    { path: 'a.lua', add: 5, del: 1 },
    { path: 'b.lua', add: 1, del: 1 },
  ])
  assert.equal(stepReportCount(task, root), 0)
})
