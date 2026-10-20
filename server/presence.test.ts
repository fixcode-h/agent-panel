import assert from 'node:assert/strict'
import test from 'node:test'

// 宽限期默认 60 分钟，测试里用环境变量缩短（环境变量优先于设置）
process.env.AGENT_PANEL_PRESENCE_GRACE_MS = '30'
const { forgetPresence, isWatched, setPresenceIdleHandler, setPresenceGraceMs, setViewer } =
  await import('./presence.ts')

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('对话页在场：切走后宽限到了才结束，切回来取消计时', async () => {
  const id = 'presence-test'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  // 页面还没上报过：当作在看，避免刚开始执行就结束
  assert.equal(isWatched(id), true)
  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  await wait(10)
  assert.equal(isWatched(id), true, '宽限期内还算在场')
  await wait(40)
  assert.equal(isWatched(id), false, '过了宽限就不在了')
  assert.equal(idle, 1, '通知还在等下一句的 CLI 结束')

  // 切回来：取消计时，重新算在场
  setViewer(id, 'tab-a', true)
  assert.equal(isWatched(id), true)
  await wait(40)
  assert.equal(isWatched(id), true)

  // 两个页面：关掉一个还有人在看
  setViewer(id, 'tab-b', false)
  await wait(40)
  assert.equal(isWatched(id), true)
  setViewer(id, 'tab-a', false)
  await wait(40)
  assert.equal(isWatched(id), false)

  forgetPresence(id)
  assert.equal(isWatched(id), true, '清掉记录后回到默认的在场')
})

test('测试用的环境变量优先于设置里的宽限期', async () => {
  const id = 'presence-env-priority'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  // 设置里改成很长也不会生效：环境变量已经把宽限固定成 30ms
  setPresenceGraceMs(60 * 60_000)
  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  await wait(60)
  assert.equal(isWatched(id), false)
  assert.equal(idle, 1)
  forgetPresence(id)
})
