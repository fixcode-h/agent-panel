/**
 * 运行区那行「工作流」：哪种任务、什么时候会列出来。
 *
 * 这里测的是界面上的口径——工作流任务自己跑的时候也要列（以前只认 `mode === 'chat'`），
 * 完成后那一行消失（运行区不画、不留空横线），失败 / 被停止留一行说明，而且只挂在最新的一轮上。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Task, TaskMessage, TaskRun, TaskStep } from '@shared/schema'
import { runRow, workflowRunState } from './run-row.ts'

const at = '2026-01-01T00:00:00.000Z'

function step(id: string, status: TaskStep['status'], runId = 1): TaskStep {
  return {
    id,
    parentId: '',
    slot: '',
    round: 0,
    workflowId: '',
    flowId: '',
    nodeId: '',
    kind: 'agent',
    title: id,
    agentId: '',
    status,
    startedAt: at,
    endedAt: status === 'running' ? '' : at,
    spentMs: 0,
    waitMs: 0,
    waitStartedAt: '',
    output: '',
    runId,
  } as TaskStep
}

function msg(id: string, stepId = ''): TaskMessage {
  return { id, role: 'agent', agentId: '', step: stepId, text: id, tools: [], at }
}

/** 用户提的要求：没有节点，单独成一段（见 TaskView 的 toBlocks） */
const userMsg = (id: string): TaskMessage => ({ ...msg(id), role: 'user' })

function run(status: TaskRun['status'], overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 1,
    workflowId: '',
    workflowName: 'Web 功能开发',
    workflows: [],
    skillSlots: {},
    status,
    startedAt: at,
    endedAt: status === 'running' ? '' : at,
    state: {},
    messages: [],
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    mode: 'workflow',
    status: 'running',
    workflowName: '',
    messages: [],
    steps: [],
    runs: [],
    ...overrides,
  } as Task
}

test('工作流任务自己跑的时候也列：进度、名字、运行号都按那次运行算', () => {
  const t = task({
    steps: [step('a', 'done'), step('b', 'running'), step('c', 'pending')],
    runs: [run('running')],
  })
  const info = workflowRunState(t)
  assert.equal(info?.status, 'running')
  assert.equal(info?.run, 1)
  assert.equal(info?.name, 'Web 功能开发')
  assert.deepEqual([info?.done, info?.total], [1, 3])
  assert.equal(info?.startedAt, at)
})

test('对话里计划触发的那次运行同样列（两种任务共用一套判定）', () => {
  const t = task({
    mode: 'chat',
    steps: [step('计划 1', 'done'), step('计划 2', 'running')],
    runs: [run('running')],
  })
  assert.equal(workflowRunState(t)?.status, 'running')
  assert.deepEqual([workflowRunState(t)?.done, workflowRunState(t)?.total], [1, 2])
})

test('还没到失败节点、也没跑起来时，只看 runRunning：进度按顶层节点数', () => {
  const t = task({ steps: [step('a', 'done'), step('b', 'done')], runs: [run('running')] })
  const info = workflowRunState(t)
  assert.equal(info?.status, 'running')
  assert.equal(info?.total, 2)
  assert.equal(info?.done, 2)
})

test('子节点不算进进度（只数顶层节点）', () => {
  const child = { ...step('a/子', 'running'), parentId: 'a' }
  const t = task({ steps: [step('a', 'running'), child], runs: [run('running')] })
  assert.deepEqual([workflowRunState(t)?.done, workflowRunState(t)?.total], [0, 1])
})

test('跑完了就从运行区消失（完成不返回数据）', () => {
  const t = task({ status: 'done', steps: [step('a', 'done')], runs: [run('done')] })
  assert.equal(workflowRunState(t), undefined)
})

test('失败留一行，并带上失败的顶层节点', () => {
  const t = task({ status: 'done', steps: [step('a', 'done'), step('b', 'failed')], runs: [run('failed')] })
  const info = workflowRunState(t)
  assert.equal(info?.status, 'failed')
  assert.deepEqual(
    info?.failed.map((s) => s.id),
    ['b'],
  )
})

test('被停止留一行，没有失败节点可展开', () => {
  // 节点状态里没有「停止」：停下时还没跑完的节点留在 pending
  const t = task({ status: 'stopped', steps: [step('a', 'done'), step('b', 'pending')], runs: [run('stopped')] })
  const info = workflowRunState(t)
  assert.equal(info?.status, 'stopped')
  assert.equal(info?.failed.length, 0)
})

test('旧任务没有运行记录：有没在跑的顶层节点也算在跑（和 runRunning 的回退一致）', () => {
  const t = task({ runs: [], steps: [step('a', 'done'), step('b', 'running')] })
  const info = workflowRunState(t)
  assert.equal(info?.status, 'running')
  assert.equal(info?.run, 1)
})

test('不是最新的一轮不列：这一轮里没有最后一条对话消息时不画', () => {
  // 工作流任务的追加要求回复没有 step（server/exec/runner.ts 的 runAgent 不传 step），
  // 它在主 Agent 那一轮里；另一轮（旧的一轮）里没有它，就不该再列一次
  const reply = msg('reply')
  const t = task({
    steps: [step('a', 'running')],
    runs: [run('running')],
    messages: [msg('prompt'), reply],
  })
  assert.deepEqual(runRow(t, [reply]), workflowRunState(t))
  assert.equal(runRow(t, []), undefined)
  assert.equal(runRow(t, [], true)?.status, 'running')
})

test('旧任务的编排器消息都带 @main 时，lastChatId 落到最后一条没有节点的消息上', () => {
  // 这条测的是 lastChatId 的取值：它跳过带 step 的消息，落到更早那条没有节点的消息（用户提的要求）。
  // 真实分段（TaskView 的 toBlocks）里无 step 的用户消息单独成一段，不在主 Agent 那一轮的 msgs 里，
  // 所以这个形态在界面上不靠兜底命中：由运行卡片承担显示（见下一条和交接的已知问题）
  const t = task({
    steps: [step('@main', 'running')],
    runs: [run('running')],
    messages: [userMsg('ask'), msg('main', '@main'), msg('node', 'a')],
  })
  assert.equal(runRow(t, [userMsg('ask'), msg('main', '@main')])?.status, 'running')
})

test('旧任务只有 @main 消息、这一轮没有追问回复时不列（由运行卡片承担）', () => {
  // 和真实分段对齐：无 step 的用户消息不进主 Agent 那一轮，所以这一轮里没有最后一条对话消息
  const t = task({
    steps: [step('@main', 'running')],
    runs: [run('running')],
    messages: [userMsg('ask'), msg('main', '@main')],
  })
  assert.equal(runRow(t, [msg('main', '@main')]), undefined)
})

test('没有任务、没有运行时都是空的（运行区判空据此不画分隔线）', () => {
  assert.equal(runRow(undefined, []), undefined)
  assert.equal(runRow(task(), []), undefined)
})
