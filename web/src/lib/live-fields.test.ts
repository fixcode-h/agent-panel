/**
 * 点开在运行的对话时转圈不能闪一下：标记已看、预热这类接口返回的任务不带运行时字段，
 * 不能把列表和标题栏里「还有子对话 / 后台命令在跑」清掉
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '@shared/schema'
import { askedAt, taskSummary } from '@shared/task'
import { taskBusy } from '@shared/task'
import { keepLiveFields, windowedForSummary } from './live-fields'

const base = { id: 'a', status: 'running', working: false, steps: [] } as unknown as Task

test('keepLiveFields：新的一份没带运行时字段时沿用旧的，转圈不闪', () => {
  const prev = { ...base, childrenWorking: 2, jobs: [{}] } as unknown as Task
  const bare = { ...base } as Task
  const kept = keepLiveFields(prev, bare)
  assert.equal(kept.childrenWorking, 2)
  assert.equal(kept.jobs?.length, 1)
  assert.equal(taskBusy(kept), true)
  // 带了就用新的：子对话做完了是 0，不能再沿用
  const done = keepLiveFields(prev, { ...base, childrenWorking: 0, jobs: [] } as unknown as Task)
  assert.equal(done.childrenWorking, 0)
  assert.equal(taskBusy(done), false)
  // 换了任务不沿用
  assert.equal(keepLiveFields(prev, { ...bare, id: 'b' }).childrenWorking, undefined)
  // 长对话只取到最后一段时换回列表摘要：最近发言时间不能退回到第一条消息（侧栏排序会闪）
  const msg = (role: string, at: string) => ({ id: at, role, at, text: '' })
  const listed = taskSummary({
    ...base,
    workflows: [],
    createdAt: '2026-01-01T00:00:00Z',
    messages: [msg('user', '2026-01-01T00:00:00Z'), msg('user', '2026-01-03T00:00:00Z')],
  } as unknown as Task)
  const page = {
    ...base,
    workflows: [],
    createdAt: '2026-01-01T00:00:00Z',
    messages: [msg('agent', '2026-01-04T00:00:00Z')],
  }
  assert.equal(askedAt(taskSummary(windowedForSummary(page as unknown as Task, listed))), '2026-01-03T00:00:00Z')
  // 打开期间刚发的那条在这一段里：以它为准
  const sent = { ...page, messages: [...page.messages, msg('user', '2026-01-05T00:00:00Z')] }
  assert.equal(askedAt(taskSummary(windowedForSummary(sent as unknown as Task, listed))), '2026-01-05T00:00:00Z')
})

test('keepLiveFields：CLI 存活没带时沿用，带了 false 就撤掉（CLI 关了绝不显示）', () => {
  const prev = { ...base, cliAlive: true, childrenCli: 1 } as unknown as Task
  const kept = keepLiveFields(prev, { ...base } as Task)
  assert.equal(kept.cliAlive, true)
  assert.equal(kept.childrenCli, 1)
  const gone = keepLiveFields(prev, { ...base, cliAlive: false, childrenCli: 0 } as unknown as Task)
  assert.equal(gone.cliAlive, false)
  assert.equal(gone.childrenCli, 0)
})
