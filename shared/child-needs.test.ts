import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import type { Task, TaskRequest } from './schema.ts'
import { descendantNeeds, pendingRequest } from './child-needs.ts'
import { childReport, childWait, childWaitText, convState, taskState } from './task.ts'
import { taskWaitText } from './task-word.ts'

setLang('zh')

const req = (over: Partial<TaskRequest> = {}): TaskRequest => ({
  id: 'r1',
  step: '',
  agentId: '',
  kind: 'command',
  title: '运行命令：npm test 2>&1 | tail -30',
  detail: 'npm test 2>&1 | tail -30',
  options: [],
  at: '2026-11-01T01:53:17.000Z',
  ...over,
})

type Row = Parameters<typeof descendantNeeds>[0][number]
const row = (id: string, parentTaskId = '', over: Partial<Row> = {}): Row => ({
  id,
  parentTaskId,
  requests: [],
  ...over,
})

test('后代在等确认时一路往上记：父对话、祖父对话都算，不在等的不算', () => {
  const m = descendantNeeds([
    row('top'),
    row('a', 'top'),
    row('b', 'top', { requests: [req()] }),
    row('a1', 'a', { parentAsks: [{ id: 'q', question: '选哪个？', options: [], kind: 'question' }] }),
    row('other'),
  ])
  assert.equal(m.get('top'), 2)
  assert.equal(m.get('a'), 1)
  assert.equal(m.get('b'), undefined)
  assert.equal(m.get('other'), undefined)
})

test('归档、进回收站、独立分支被删掉的子对话不再催用户；坏数据成环也不死循环', () => {
  const m = descendantNeeds([
    row('top'),
    row('x', 'top', { requests: [req()], archived: true }),
    row('y', 'top', { requests: [req()], deletedAt: '2026-11-01T00:00:00.000Z' }),
    row('z', 'top', {
      requests: [req()],
      worktree: { state: 'discarded' } as NonNullable<Task['worktree']>,
    }),
    row('c1', 'c2', { requests: [req()] }),
    row('c2', 'c1'),
  ])
  assert.equal(m.get('top'), undefined)
  assert.ok((m.get('c1') ?? 0) <= 6)
})

test('子对话卡在权限确认：父对话是「等你处理」，不是「子对话执行中」（实测报告问题 1）', () => {
  // 父对话自己停在等下一句、名下一个子对话在等确认（也算还在运行的子对话）
  const parent = { status: 'running' as const, steps: [], working: false, childrenWorking: 1, childrenNeeds: 1 }
  assert.equal(taskState(parent), 'needs')
  assert.equal(taskWaitText(parent), '子对话等你处理')
  // 没有后代在等时还是原来的「等结果」
  assert.equal(taskState({ ...parent, childrenNeeds: 0 }), 'waiting')
  assert.equal(taskWaitText({ ...parent, childrenNeeds: 0 }), '子对话执行中')
  // 父对话自己正在跑也一样取最紧急的
  assert.equal(convState({ status: 'running', working: true, childNeeds: 1 }), 'needs')
})

test('子对话行和计划窗口写出确认的是哪条命令', () => {
  const kid = { status: 'running' as const, working: false, requests: [req()], parentAsks: [], steps: [] }
  const w = childWait(kid)
  assert.deepEqual(w, { kind: 'confirm', n: 1, title: req().title, question: false })
  assert.equal(childWaitText(w), '等用户确认：运行命令：npm test 2>&1 | tail -30')
  assert.equal(
    childWaitText(childWait({ ...kid, requests: [req(), req({ id: 'r2' })] })),
    '等用户确认：运行命令：npm test 2>&1 | tail -30（共 2 项）',
  )
  assert.equal(
    childWaitText(childWait({ ...kid, requests: [req({ kind: 'question', title: '用哪个方案？' })] })),
    '等用户回答：用哪个方案？',
  )
  // 自己没在等、孙对话在等
  assert.equal(childWaitText(childWait({ ...kid, requests: [] }, { childNeeds: 2 })), '它的 2 个子对话等用户处理')
})

test('上报父对话的说明写出确认什么，孙对话在等时说清是它的子对话', () => {
  const kid = {
    status: 'running' as const,
    working: false,
    requests: [req()],
    parentAsks: [],
    plans: [],
    steps: [],
    resolved: false,
    stopReason: undefined,
  }
  assert.equal(childReport(kid).why, '等你处理：等用户确认：运行命令：npm test 2>&1 | tail -30')
  const r = childReport({ ...kid, requests: [] }, { childNeeds: 1 })
  assert.equal(r.state, 'needs')
  assert.equal(r.why, '等你处理：它的子对话在等用户处理（确认请求或回答提问）')
})

test('父对话页的确认行：命令、改文件、工具能直接允许 / 拒绝，提问和节点确认要点进去', () => {
  assert.equal(pendingRequest({ requests: [] }), undefined)
  assert.equal(pendingRequest({ requests: [req()] })?.quick, true)
  assert.equal(pendingRequest({ requests: [req({ kind: 'file' })] })?.quick, true)
  assert.equal(pendingRequest({ requests: [req({ kind: 'question' })] })?.quick, false)
  assert.equal(pendingRequest({ requests: [req({ kind: 'confirm' })] })?.quick, false)
  assert.equal(pendingRequest({ requests: [req({ detail: 'x'.repeat(5000) })] })?.detail.length, 2000)
})
