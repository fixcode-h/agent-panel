import assert from 'node:assert/strict'
import test from 'node:test'
import { groupOf, nextToRun, pickDue, Schedule, weekOccurrences, weekStartOf } from '../schedule.ts'
import {
  everyLabel,
  isEventSchedule,
  sameTriggerConfig,
  ScheduleTrigger,
  triggerCheckDue,
  triggerConfigError,
  triggerFires,
  triggerPrompt,
} from './trigger.ts'

const MINUTE = 60_000
const now = Date.parse('2026-06-01T10:00:00Z')

const plan = (over: Record<string, unknown> = {}) =>
  Schedule.parse({
    id: 'p',
    name: 'n',
    prompt: '做点事',
    at: new Date(now - 1000).toISOString(),
    createdAt: '',
    updatedAt: '',
    ...over,
  })

test('旧数据没有 trigger：按时间', () => {
  const s = plan()
  assert.equal(s.trigger.kind, 'time')
  assert.equal(isEventSchedule(s), false)
  assert.equal(s.triggerState.baseline, '')
})

test('第一次检查只记现状，之后变了才触发；只在失败时不认变回 0', () => {
  const files = { kind: 'files' as const, onlyFailure: false }
  assert.equal(triggerFires(files, '', 'a'), false)
  assert.equal(triggerFires(files, 'a', 'a'), false)
  assert.equal(triggerFires(files, 'a', 'b'), true)
  const cmd = { kind: 'command' as const, onlyFailure: true }
  assert.equal(triggerFires(cmd, '1', '0'), false)
  assert.equal(triggerFires(cmd, '0', '2'), true)
  assert.equal(triggerFires({ ...cmd, onlyFailure: false }, '1', '0'), true)
})

test('检查间隔：没检查过马上查，到了 everyMin 再查；停用和按时间的不查', () => {
  const trigger = ScheduleTrigger.parse({ kind: 'git', branch: 'main', everyMin: 5 })
  const base = { enabled: true, trigger }
  assert.equal(triggerCheckDue(base, now), true)
  const checked = {
    ...base,
    triggerState: { baseline: 'x', checkedAt: new Date(now).toISOString(), error: '', firedAt: '' },
  }
  assert.equal(triggerCheckDue(checked, now + 4 * MINUTE), false)
  assert.equal(triggerCheckDue(checked, now + 5 * MINUTE), true)
  assert.equal(triggerCheckDue({ ...base, enabled: false }, now), false)
  assert.equal(triggerCheckDue({ enabled: true, trigger: ScheduleTrigger.parse({}) }, now), false)
})

test('按事件的计划不按 at 到点，日历不画，也不当「下一次执行」', () => {
  const s = plan({ trigger: { kind: 'files' } })
  assert.deepEqual(pickDue([s], now), { run: [], missed: [] })
  assert.deepEqual(weekOccurrences(s, weekStartOf(now)), [])
  assert.equal(nextToRun([s]), undefined)
  assert.equal(groupOf(s), 'upcoming')
  // 检查出错：归到「出过问题」提醒用户去修
  assert.equal(groupOf({ ...s, triggerState: { ...s.triggerState, error: '目录不存在' } }), 'problem')
})

test('保存校验和条件比较', () => {
  const git = ScheduleTrigger.parse({ kind: 'git' })
  assert.notEqual(triggerConfigError({ projectId: 'p', trigger: git }), '')
  assert.equal(triggerConfigError({ projectId: 'p', trigger: { ...git, branch: 'main' } }), '')
  const files = ScheduleTrigger.parse({ kind: 'files', path: 'sub' })
  assert.notEqual(triggerConfigError({ projectId: '', trigger: files }), '')
  assert.equal(triggerConfigError({ projectId: '', trigger: { ...files, path: 'D:/Game' } }), '')
  assert.notEqual(triggerConfigError({ projectId: 'p', trigger: { ...files, path: '../x' } }), '')
  // 只改检查间隔不算换了条件，改目录算
  assert.equal(sameTriggerConfig(files, { ...files, everyMin: 30 }), true)
  assert.equal(sameTriggerConfig(files, { ...files, path: 'other' }), false)
})

test('提示词附上触发原因；间隔写法', () => {
  assert.equal(triggerPrompt('原话', ''), '原话')
  assert.match(triggerPrompt('原话', '变了 a.txt'), /^原话\n\n---\n.*\n变了 a\.txt$/)
  assert.equal(everyLabel(5), '每 5 分钟')
  assert.equal(everyLabel(180), '每 3 小时')
  assert.equal(everyLabel(1440), '每天')
})
