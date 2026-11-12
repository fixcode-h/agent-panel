/**
 * 运行时状态（live）和任务记录分开存（重构文档第 1 条）：停止、改名这类接口顺手回的任务不带 live 时，
 * 页面上的状态不能被清掉（以前的 keepLiveFields 要「没带就沿用」，现在 live 根本不跟着记录走）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskData, type Task } from '@shared/schema'
import { askedAt, taskSummary } from '@shared/task'
import { liveBusy, taskLiveOf, type TaskLive } from '@shared/task-live'
import { dropLive, liveFor, putLive, takeLive } from './live-store'
import { windowedForSummary } from './summary-window'

const task = (over: Record<string, unknown> = {}) =>
  ({ ...TaskData.parse({ projectId: 'p', title: 't', mode: 'chat', status: 'done', ...over }), id: 'a' }) as Task
const live = (rt: Partial<TaskLive> = {}) =>
  taskLiveOf(task(), { cliAlive: false, jobs: [], childrenWorking: 0, childrenCli: 0, childrenNeeds: 0, ...rt })

test('接口回来的任务：live 取下放进 live-store，记录里不再带；别的接口回的不带 live 时状态不变', () => {
  const rec = takeLive({ ...task(), live: live({ childrenWorking: 2 }) })
  assert.equal('live' in rec, false, '记录里不带 live')
  assert.equal(liveFor(rec).state, 'waiting')
  assert.ok(liveBusy(liveFor(rec)))
  // 停止、改名顺手回的那份没带 live：记录照换，状态不动，转圈不闪
  takeLive(task({ title: '改了名' }))
  assert.equal(liveFor(task()).childrenWorking, 2)
  // 带了新的就换：子对话做完了是 0
  putLive('a', live())
  assert.equal(liveFor(task()).state, 'done')
  dropLive('a')
})

test('还没拿到服务端那份：按任务记录本身算（同一个 taskLiveOf），不显示成在跑', () => {
  dropLive('a')
  assert.equal(liveFor(task({ status: 'running', working: true })).state, 'running')
  assert.equal(liveFor(task()).cliAlive, false)
})

test('长对话只取到最后一段时换回列表摘要：最近发言时间不退回第一条消息（侧栏排序不闪）', () => {
  const msg = (role: string, at: string) => ({ id: at, role, at, text: '', tools: [] })
  const listed = taskSummary(
    task({
      createdAt: '2026-01-01T00:00:00Z',
      messages: [msg('user', '2026-01-01T00:00:00Z'), msg('user', '2026-01-03T00:00:00Z')],
    }),
  )
  const page = task({ createdAt: '2026-01-01T00:00:00Z', messages: [msg('agent', '2026-01-04T00:00:00Z')] })
  assert.equal(askedAt(taskSummary(windowedForSummary(page, listed))), '2026-01-03T00:00:00Z')
  // 打开期间刚发的那条在这一段里：以它为准
  const sent = { ...page, messages: [...page.messages, msg('user', '2026-01-05T00:00:00Z')] } as Task
  assert.equal(askedAt(taskSummary(windowedForSummary(sent, listed))), '2026-01-05T00:00:00Z')
})
