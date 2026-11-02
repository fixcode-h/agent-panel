import assert from 'node:assert/strict'
import test from 'node:test'

// 这个文件不注入 AGENT_PANEL_PRESENCE_GRACE_MS：环境变量优先于设置，注入了就没法把宽限期改成 0
process.env.AGENT_PANEL_PRESENCE_RECHECK_MS = '200'
const { forgetPresence, resetIdleCountdown, setPresenceBusy, setPresenceGraceMs, setPresenceIdleHandler, setViewer } =
  await import('./presence.ts')

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('宽限期设成 0：正在跑的对话不会靠 0ms 定时器反复重排，空下来才回收', async () => {
  const id = 'presence-zero-grace'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  setPresenceGraceMs(0)
  let running = true
  setPresenceBusy((taskId) => taskId === id && running)

  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  await wait(60)
  assert.equal(idle, 0, '正在跑：0 宽限也不结束这一轮')

  // 关键：busy 时不能排 0ms 定时器反复重排（旧写法会一直自旋）。
  // 这里变成空闲但不调 resetIdleCountdown：要一直不回收，而不是下一个 tick 就被收掉
  running = false
  await wait(60)
  assert.equal(idle, 0, '执行期间不重排计时：空下来要靠重置计时，不是靠自旋')

  // 这一轮真的结束了（onKeepAlive 会调它）：从现在起按整段算，0 宽限就是立刻收
  resetIdleCountdown(id)
  await wait(30)
  assert.equal(idle, 1, '空下来后按整段回收')

  setPresenceBusy(() => false)
  forgetPresence(id)
})
