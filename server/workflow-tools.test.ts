import assert from 'node:assert/strict'
import test from 'node:test'
import type { Orchestra } from '../shared/engine.ts'
import { pickFlow, type WorkflowEntry } from '../shared/flow-run.ts'
import { callOrchTool, orchTools } from './orch-mcp.ts'

const LIST: WorkflowEntry[] = [
  { id: 'g', name: '通用项目', description: '默认', steps: [], kind: 'change' },
  { id: 'r', name: '代码评审', description: '只读评审', steps: [], kind: 'readonly' },
]

/** 父对话操作工作流运行的面板工具（server/workflow-tools.ts）：参数检查、交给 Orchestra.runs */
function orch() {
  const calls: unknown[][] = []
  const rec =
    (name: string) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a])
      return { ok: true, id: 'r1', info: `${name} 好了` }
    }
  const o = {
    self: 'chat',
    common: [],
    hasMain: false,
    canSpawn: true,
    team: true,
    planning: true,
    pickWorkflow: (k: string) => pickFlow(LIST, k),
    runs: {
      startWorkflow: rec('start'),
      listWorkflows: async () => '- 工作流「通用项目」（id r1）：1/3',
      messageWorkflow: rec('message'),
      reviseWorkflow: rec('revise'),
      answerWorkflow: rec('answer'),
      stopWorkflow: rec('stop'),
      finishWorkflow: rec('finish'),
    },
  } as unknown as Orchestra
  return { o, calls }
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text

test('工作流工具：只给能启动工作流的父对话；子对话、普通对话看不到', () => {
  const { o } = orch()
  const names = (orchTools(o) as { name: string }[]).map((x) => x.name)
  for (const n of [
    'start_workflow',
    'list_workflows',
    'message_workflow',
    'revise_workflow',
    'answer_workflow',
    'stop_workflow',
    'finish_workflow',
  ])
    assert.ok(names.includes(n), n)
  assert.ok(!names.includes('run_workflow') && !names.includes('close_run') && !names.includes('ask_main'))
  const none = (orchTools({ ...o, planning: false } as Orchestra) as { name: string }[]).map((x) => x.name)
  assert.ok(!none.some((n) => n.endsWith('_workflow') || n === 'list_workflows'))
})

test('start_workflow：认出工作流再起运行；认不出、input 空、老的 again 都不起', async () => {
  const { o, calls } = orch()
  assert.match(text(await callOrchTool(o, 'start_workflow', { input: '' })), /input 是空的/)
  assert.match(
    text(await callOrchTool(o, 'start_workflow', { workflow: '不存在', input: '做' })),
    /没有「不存在」这个工作流/,
  )
  assert.match(text(await callOrchTool(o, 'start_workflow', { again: 'k1', input: '再来' })), /revise_workflow/)
  assert.equal(calls.length, 0)
  assert.match(
    text(await callOrchTool(o, 'start_workflow', { workflow: 'g', input: '做登录', step: '2' })),
    /（id: r1）/,
  )
  const [, picked, input, title, , step] = calls[0] as [string, { workflowId: string }, string, string, unknown, string]
  assert.equal(picked.workflowId, 'g')
  assert.equal(input, '做登录')
  assert.match(title, /^通用项目：做登录/, '没给标题时用工作流名字加要做的事')
  assert.equal(step, '2')
})

test('其余工作流工具：参数照原样交给运行；decision、action 写错直接拒绝', async () => {
  const { o, calls } = orch()
  assert.match(text(await callOrchTool(o, 'list_workflows', {})), /id r1/)
  await callOrchTool(o, 'message_workflow', { id: 'r1', text: '日志用英文', to: 'later' })
  await callOrchTool(o, 'message_workflow', { id: 'r1', text: '快点' })
  await callOrchTool(o, 'revise_workflow', { id: 'r1', node: '方案', text: '加回滚' })
  await callOrchTool(o, 'answer_workflow', { id: 'r1', decision: 'confirm' })
  assert.match(text(await callOrchTool(o, 'answer_workflow', { id: 'r1', decision: 'ok' })), /confirm 或 revise/)
  await callOrchTool(o, 'stop_workflow', { id: 'r1', reason: '不要了' })
  assert.match(text(await callOrchTool(o, 'finish_workflow', { id: 'r1', action: 'keep' })), /merge 或 discard/)
  await callOrchTool(o, 'finish_workflow', { id: 'r1', action: 'merge' })
  assert.deepEqual(calls, [
    ['message', 'r1', '日志用英文', 'later'],
    ['message', 'r1', '快点', 'current'],
    ['revise', 'r1', '方案', '加回滚'],
    ['answer', 'r1', true, ''],
    ['stop', 'r1', '不要了'],
    ['finish', 'r1', 'merge'],
  ])
})
