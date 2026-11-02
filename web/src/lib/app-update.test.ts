import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoCheck, failedReleases, stopAutoCheck } from './app-update'

/**
 * 自动检查开关：默认关，关着时页面打开不能发请求；打开后只启动一次，
 * 多个用到 useAppUpdate 的地方共用同一个定时器
 */
test('自动检查开关：关着不发请求，打开后检查一次且重复打开不重复请求', (t) => {
  t.after(stopAutoCheck)
  let calls = 0
  const check = () => {
    calls++
  }
  assert.equal(autoCheck(false, check), false)
  assert.equal(calls, 0, '关掉后不能自动发请求')
  assert.equal(autoCheck(true, check), true)
  assert.equal(calls, 1, '打开后先检查一次')
  assert.equal(autoCheck(true, check), false, '多个页面共用时只启动一次')
  assert.equal(calls, 1, '重复打开不能重复请求')
  autoCheck(false, check)
  autoCheck(true, check)
  assert.equal(calls, 2, '关掉再打开会重新检查')
})

test('检查请求失败：保留本地版本信息，只清掉发布列表并记下错误', () => {
  const prev = {
    current: '0.28.0',
    packaged: true,
    previous: '0.27.0',
    releases: [{ tag: 'v0.28.0', version: '0.28.0' } as never],
    checkedAt: '2026-01-01T00:00:00Z',
    update: { tag: 'v0.29.0', version: '0.29.0' } as never,
  }
  const next = failedReleases(prev, '连不上面板服务')
  assert.equal(next.current, '0.28.0', '当前版本要留着')
  assert.equal(next.packaged, true, '不能把发布包显示成从源码运行')
  assert.equal(next.previous, '0.27.0', '回到上一个版本的入口要留着')
  assert.deepEqual(next.releases, [], '发布列表清掉，不拿旧的冒充')
  assert.equal(next.error, '连不上面板服务')
  // 还没有读到本地信息时也要能给出一个完整的失败状态
  assert.deepEqual(failedReleases(undefined, 'x'), { current: '', packaged: false, releases: [], error: 'x' })
})
