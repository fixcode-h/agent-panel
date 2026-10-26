/**
 * 后台命令窗口的拉取节奏和结果合并：命令跑在服务端，输出按 jobId 轮询。
 * 两条不能退化的行为：拉失败要接着试（不能永久停在旧输出还写着「执行中」）、
 * 结束之后就不再试（拿到最终输出和退出码为止）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskJobView } from '@shared/schema'
import { JOB_POLL_MS, JOB_RETRY_MS, jobLive, mergeJobView, nextPollMs } from './job-poll'

const job = (state: TaskJobView['state']) => ({ id: 'j1', state }) as unknown as TaskJobView

test('nextPollMs：在跑和排队都接着拉，结束就停', () => {
  assert.equal(nextPollMs(job('running')), JOB_POLL_MS)
  assert.equal(nextPollMs(job('queued')), JOB_POLL_MS)
  // 结束的三种都停：窗口停在这份结果上（最终输出和退出码已经拿到了）
  for (const s of ['done', 'failed', 'stopped'] as const) assert.equal(nextPollMs(job(s)), undefined, s)
})

test('nextPollMs：拉失败也要重试，不是终态', () => {
  assert.equal(nextPollMs(null), JOB_RETRY_MS)
  assert.ok(JOB_RETRY_MS > JOB_POLL_MS, '重试间隔比正常轮询宽一些，不要失败之后更频繁地打')
})

test('mergeJobView：拉失败保留上一次的输出，只更新错误', () => {
  const first = mergeJobView({ id: '', view: null, error: '' }, 'j1', job('running'), '')
  assert.equal(first.view?.state, 'running')
  // 下一次失败：输出还在（不能清空，否则窗口变成空的、以为命令没输出）
  const failed = mergeJobView(first, 'j1', null, '网络断了')
  assert.deepEqual(failed.view, first.view)
  assert.equal(failed.error, '网络断了')
  // 再成功一次：错误清掉、输出换新
  const back = mergeJobView(failed, 'j1', job('done'), '')
  assert.equal(back.view?.state, 'done')
  assert.equal(back.error, '')
})

test('mergeJobView：换了一条命令不沿用上一条的输出', () => {
  const a = mergeJobView({ id: '', view: null, error: '' }, 'j1', job('running'), '')
  assert.equal(a.view?.state, 'running')
  // 打开另一条命令：还没拉到数据，不能显示上一条的输出
  const b = mergeJobView(a, 'j2', null, '')
  assert.equal(b.view, null)
  assert.equal(b.id, 'j2')
})

test('jobLive：只有排队中和在跑算活着', () => {
  assert.equal(jobLive('queued'), true)
  assert.equal(jobLive('running'), true)
  for (const s of ['done', 'failed', 'stopped'] as const) assert.equal(jobLive(s), false, s)
})
