/**
 * AI 分析窗口按「每一轮」结束交回结果：分析对话的 CLI 说完一轮还开着等下一句，任务记录的 status 一直是 running，
 * 以前只认 status，用户追问几轮缺 JSON，要等 CLI 空闲退出（二十多分钟）才补发纠正（2026-11-16 用户报）。
 */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import type { TaskLive } from '@shared/live/task-live'
import { openAiWindow, resetAiWindow, turnStatus } from '@/lib/ai-window'
import { api } from '@/lib/api'
import { putLive } from '@/lib/live/store'

const live = (state: TaskLive['state']): TaskLive => ({
  state,
  next: state === 'done',
  cliAlive: true,
  jobs: [],
  childrenWorking: 0,
  childrenCli: 0,
  childrenNeeds: 0,
})

async function waitFor(ok: () => boolean, ms: number) {
  const until = Date.now() + ms
  while (!ok()) {
    if (Date.now() > until) throw new Error('等超时了：条件一直没成立')
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(() => resetAiWindow())

test('turnStatus：CLI 还开着、这一轮已经说完，按这一轮结束算', () => {
  const task = { id: 'turn-a', status: 'running' } as never
  putLive('turn-a', live('running'))
  assert.equal(turnStatus(task), 'running')
  putLive('turn-a', live('done'))
  assert.equal(turnStatus(task), 'done', 'status 还是 running，但这一轮说完了')
  putLive('turn-a', live('needs'))
  assert.equal(turnStatus(task), 'running', '等用户回答时这一轮还没完，不能拿半截回复去校验')
  assert.equal(turnStatus({ id: 'turn-a', status: 'stopped' } as never), 'stopped')
})

test('watch：这一轮说完的推送一到就交回结果，不等下一次轮询', async () => {
  const orig = api.task
  let calls = 0
  api.task = (async (id: string) => {
    calls += 1
    return { id, status: 'running', messages: [] }
  }) as unknown as typeof api.task
  let done = 0
  try {
    putLive('turn-b', live('running'))
    openAiWindow({
      label: 'AI 分析',
      title: '表格风格',
      create: async () => ({ id: 'turn-b', status: 'running' }) as never,
      onDone: () => void (done += 1),
    })
    // 第一次轮询（1.5 秒后）看到还在跑
    await waitFor(() => calls >= 1, 3000)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(done, 0)
    // 推送说这一轮说完了：马上去看，远早于下一次 1.5 秒的轮询
    putLive('turn-b', live('done'))
    await waitFor(() => done === 1, 500)
  } finally {
    api.task = orig
    resetAiWindow()
  }
})
