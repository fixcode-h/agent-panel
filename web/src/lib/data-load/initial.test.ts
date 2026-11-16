/**
 * 页面打开时取全局数据：一份失败不能让项目列表一直是空的（升级后打开旧项目变成「新建项目」弹窗就是这个）。
 * 定时器换成手动推进，测「先放取到的、只重取失败的、都取到才算完、只报一次错」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadInitialData, part, retryDelay } from '@/lib/data-load/initial'

const flush = () => new Promise((r) => setTimeout(r, 0))

test('一份失败：其他的先放进去，失败的重取到为止，都取到才算加载完', async () => {
  const got: Record<string, unknown> = {}
  let projectsCalls = 0
  let agentsCalls = 0
  const timers: (() => void)[] = []
  const errors: string[] = []
  let done = false
  loadInitialData(
    [
      part(
        'agents',
        async () => (agentsCalls++, ['a']),
        (v) => (got.agents = v),
      ),
      part(
        'projects',
        async () => {
          projectsCalls++
          if (projectsCalls < 3) throw new Error('fetch failed')
          return ['p']
        },
        (v) => (got.projects = v),
      ),
    ],
    () => (done = true),
    (m) => errors.push(m),
    (_ms, fn) => {
      timers.push(fn)
      return () => {}
    },
  )
  await flush()
  assert.deepEqual(got, { agents: ['a'] })
  assert.equal(done, false)
  assert.deepEqual(errors, ['fetch failed'])
  timers.shift()!()
  await flush()
  timers.shift()!()
  await flush()
  assert.deepEqual(got, { agents: ['a'], projects: ['p'] })
  assert.equal(done, true)
  // 只重取失败的那份；错误只报一次
  assert.equal(agentsCalls, 1)
  assert.equal(projectsCalls, 3)
  assert.equal(errors.length, 1)
})

test('取消后不再写状态、不再重试', async () => {
  let applied = false
  let scheduled = 0
  const cancel = loadInitialData(
    [
      part(
        'projects',
        async () => ['p'],
        () => (applied = true),
      ),
    ],
    () => {},
    () => {},
    () => (scheduled++, () => {}),
  )
  cancel()
  await flush()
  assert.equal(applied, false)
  assert.equal(scheduled, 0)
})

test('重试间隔逐步拉长，最多 10 秒', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(retryDelay), [1000, 2000, 4000, 8000, 10_000, 10_000])
})
