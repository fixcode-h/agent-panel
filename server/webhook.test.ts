import assert from 'node:assert/strict'
import test from 'node:test'
import { whenLabel, type Schedule } from '../shared/schedule.ts'
import { webhookPayload } from './webhook.ts'

const at = (y: number, mo: number, d: number, h: number) => new Date(y, mo - 1, d, h).toISOString()

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: 'schedule-1',
  name: '每日构建',
  prompt: '跑一遍构建',
  projectId: 'proj-1',
  agentId: '',
  repeat: 'daily',
  weekdays: [],
  at: at(2026, 5, 1, 9),
  enabled: true,
  dependsOn: [],
  budget: { tokens: 0, minutes: 0 },
  endDate: '',
  durationMin: 60,
  trigger: { kind: 'time', path: '', remote: 'origin', branch: '', command: '', onlyFailure: false, everyMin: 5 },
  triggerState: { baseline: '', checkedAt: '', error: '', firedAt: '' },
  status: 'pending',
  lastRunAt: '',
  lastTaskId: '',
  missedAt: '',
  lastError: '',
  blockedAt: '',
  blockedReason: '',
  lastDelivery: null,
  runs: [],
  createdAt: at(2026, 4, 30, 9),
  updatedAt: at(2026, 4, 30, 9),
  ...over,
})

test('载荷：失败 / 错过 / 没启动都带上原因，只有成功启动才带任务 id', () => {
  const failed = webhookPayload(schedule({ lastTaskId: 'old', lastError: '项目不存在' }), 'fail', at(2026, 5, 1, 9))
  assert.equal(failed.taskId, '')
  assert.equal(failed.error, '项目不存在')

  const blocked = webhookPayload(
    schedule({ blockedAt: at(2026, 5, 1, 9), blockedReason: '因为「构建」启动失败，没有启动' }),
    'blocked',
    at(2026, 5, 1, 9),
  )
  assert.equal(blocked.error, '因为「构建」启动失败，没有启动')

  // 成功启动之后 at 已经推到下一次：载荷里的 at 必须是这一轮（调用方传入的快照）
  const ran = webhookPayload(
    schedule({ lastRunAt: at(2026, 5, 1, 9), lastTaskId: 'task-1', at: at(2026, 5, 2, 9) }),
    'run',
    at(2026, 5, 1, 9),
  )
  assert.equal(ran.at, at(2026, 5, 1, 9))
  assert.equal(ran.taskId, 'task-1')
  assert.equal(ran.error, '')
})

test('载荷：错过和没启动各带自己的原因，不拿上一次的启动失败原因冒充', () => {
  const s = schedule({
    lastError: '项目不存在',
    missedAt: at(2026, 5, 1, 9),
    blockedAt: at(2026, 5, 2, 9),
    blockedReason: '因为「构建」启动失败，没有启动',
  })
  // 启动失败：用失败原文
  assert.equal(webhookPayload(s, 'fail', at(2026, 5, 1, 9)).error, '项目不存在')
  // 被上游拦住：用这次拦住的说明，而不是 lastError 里更早的那条
  assert.equal(webhookPayload(s, 'blocked', at(2026, 5, 2, 9)).error, '因为「构建」启动失败，没有启动')
  // 错过：说清是哪一次错过，不是启动失败
  const missed = webhookPayload(s, 'miss', at(2026, 5, 1, 9)).error
  assert.match(missed, /错过/)
  assert.ok(missed.includes(whenLabel(s.missedAt)))
  assert.ok(!missed.includes('项目不存在'))
})

test('载荷：用户同时改过排期、missedAt 被清掉时，错过原因用这一轮的到点时间', () => {
  // writeBack 发现排期被改过时会丢掉 missedAt，这时不能把时间位置空着
  const s = schedule({ missedAt: '' })
  const runAt = at(2026, 5, 1, 9)
  const error = webhookPayload(s, 'miss', runAt).error
  assert.match(error, /错过/)
  assert.ok(error.includes(whenLabel(runAt)), `错过原因里要有时间：${error}`)
  assert.ok(!/错过\s+（/.test(error), `时间位置不能空着：${error}`)
})
