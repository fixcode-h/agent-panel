/**
 * 停下只有两种收法（ADR 0042 第 2 期）：暂停（pauseUnit，会接着做）和终止（cancelUnit，明确不做了）。
 * 引擎收尾（finish）、落盘收口（settleStopped）、stop_subtask 都走这两个，不再各写一份。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { finish, type EngineHost } from './engine.ts'
import { cancelUnit, dropInterrupted, helperKey, helperStops, pauseUnit, pausedSignal } from './run-stops.ts'
import { Task, TaskStep } from './schema.ts'
import { settleStopped } from './task-settle.ts'

const T0 = Date.parse('2026-11-03T00:00:00Z')
const step = (x: Partial<TaskStep> = {}) =>
  TaskStep.parse({
    id: 's/sub/h1',
    title: '查代码',
    slot: 'sub',
    status: 'running',
    startedAt: new Date(T0).toISOString(),
    ...x,
  })

test('暂停：待做 + 被打断、结掉用时、清排队标记；终止：跳过、不再被打断，原因在没有输出时当结果', () => {
  const s = step({ apiWait: { api: 'a', name: 'A', ahead: 1, since: '' } as never })
  pauseUnit(s, T0 + 5000)
  assert.equal(s.status, 'pending')
  assert.equal(s.interrupted, true)
  assert.equal(s.spentMs, 5000)
  assert.equal(s.startedAt, '')
  assert.equal(s.apiWait, undefined)
  // 时间解析不出来（老数据）也不抛错
  assert.doesNotThrow(() => pauseUnit(step(), NaN))

  const c = step({ status: 'pending', interrupted: true })
  cancelUnit(c, '不需要了')
  assert.equal(c.status, 'skipped')
  assert.equal(c.interrupted, false)
  assert.equal(c.output, '不需要了')
  // stop_subtask 收掉被打断的走同一个写法；没被打断的不归它管
  const d = step({ status: 'pending', interrupted: true })
  assert.equal(dropInterrupted(d, '用户不要了'), true)
  assert.equal(d.status, 'skipped')
  assert.equal(dropInterrupted(step({ status: 'done' }), 'x'), false)
})

const chat = (steps: TaskStep[]) => {
  const iso = new Date(T0).toISOString()
  const task = Task.parse({
    id: 't',
    createdAt: iso,
    updatedAt: iso,
    projectId: '',
    title: '对话',
    mode: 'chat',
    status: 'running',
    messages: [],
    steps,
  })
  const host = { task, newId: () => 'm', changed: () => {}, stopReason: () => 'presence' } as unknown as EngineHost
  return { task, host }
}

test('停下时还有子任务在跑：即使这一轮已经答完，也不把子任务记成完成，整轮记成已停止、能继续执行', () => {
  const { task, host } = chat([step()])
  finish(host, { ok: false, stopped: true, error: '' }, { answered: true })
  assert.equal(task.steps[0].status, 'pending', '子任务暂停，不是完成')
  assert.equal(task.steps[0].interrupted, true)
  assert.equal(task.status, 'stopped', '活没干完，不算答完')
  // 没有在跑的：答完照旧算完成
  const idle = chat([step({ status: 'done' })])
  finish(idle.host, { ok: false, stopped: true, error: '' }, { answered: true })
  assert.equal(idle.task.status, 'done')
})

test('对话自己的 CLI 失败（不是停止）：在跑的子任务被中断并暂停，继续时接着做；工作流节点照旧记失败', () => {
  const bad = chat([step(), step({ id: 'n1', slot: '' as never })])
  const ac = new AbortController()
  helperStops.set(helperKey('t', 's/sub/h1'), ac)
  finish(bad.host, { ok: false, error: 'CLI 崩了' })
  assert.equal(ac.signal.aborted, true, '子任务的 CLI 被中断：不然它跑完又把自己写成完成')
  assert.equal(pausedSignal(ac.signal), true, '按暂停中断，不按终止（终止会记成跳过）')
  assert.equal(bad.task.steps[0].status, 'pending')
  assert.equal(bad.task.steps[0].interrupted, true)
  assert.equal(bad.task.steps[1].status, 'failed', '工作流节点照旧记失败')
  assert.equal(bad.task.status, 'failed')
  helperStops.delete(helperKey('t', 's/sub/h1'))
})

test('落盘收口和引擎收尾同一个写法：在跑的步骤暂停，所有步骤和对话的排队标记清掉', () => {
  const { task } = chat([step(), step({ id: 's/sub/h2', status: 'done', apiWait: { api: 'a' } as never })])
  task.apiWait = { api: 'a' } as never
  const out = settleStopped(task, 'restart')
  assert.equal(out.steps[0].status, 'pending')
  assert.equal(out.steps[0].interrupted, true)
  assert.equal(out.steps[1].apiWait, undefined)
  assert.equal(out.apiWait, undefined)
  assert.equal(task.steps[0].status, 'running', '不改传进来的那份')
})
