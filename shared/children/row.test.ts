import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskData } from '../schema.ts'
import { FlowRun } from '../tasks/flow-schema.ts'
import { childCountsScan, childRecordActive } from './row.ts'

const tk = (id: string, over: Record<string, unknown> = {}) => ({
  ...TaskData.parse({ projectId: 'p', title: id, mode: 'chat', status: 'done', ...over }),
  id,
  createdAt: '',
  updatedAt: '',
})
const run = (id: string, over: Record<string, unknown> = {}, f: Record<string, unknown> = {}) =>
  tk(id, { mode: 'workflow', flowRun: FlowRun.parse({ owner: 'parent', ...f }), ...over })

const counts = (all: ReturnType<typeof tk>[]) =>
  childCountsScan(all, { active: (k) => childRecordActive(k, 0), cliAlive: () => false })('parent')

test('名下工作流运行单独计数：在跑的、等你确认的；不混进子对话计数（用户 2026-11-26 报父对话不算进行中）', () => {
  const c = counts([
    tk('parent'),
    run('r1', { status: 'running', working: true }),
    run(
      'r2',
      { status: 'running', requests: [{ id: 'q', kind: 'confirm', title: '确认方案', detail: '', at: '' }] },
      { phase: 'confirm' },
    ),
  ])
  assert.equal(c.runsWorking, 1)
  assert.equal(c.runsNeeds, 1)
  assert.equal(c.childrenWorking, 0)
  assert.equal(c.childrenNeeds, 0)
})

test('不算的运行：暂停、跑完待合回、已归档、交给父对话代答的确认不算等你处理', () => {
  const c = counts([
    tk('parent'),
    run('paused', { status: 'stopped', stopReason: 'user' }, { pausedBy: 'user' }),
    run('ready', { status: 'done' }, { phase: 'ready' }),
    run('gone', { status: 'running', working: true, archived: true }),
    run(
      'delegated',
      { status: 'done', requests: [{ id: 'q', kind: 'confirm', title: '确认', detail: '', at: '' }] },
      { phase: 'confirm', delegated: true },
    ),
  ])
  assert.equal(c.runsNeeds, 0)
  // 代答的那个仍挂着请求，按「在不在运行」算进在跑：父对话这时在替用户做决定
  assert.equal(c.runsWorking, 1)
})
