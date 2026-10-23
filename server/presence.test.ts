import assert from 'node:assert/strict'
import test from 'node:test'

// 宽限期默认 60 分钟，测试里用环境变量缩短（环境变量优先于设置）
process.env.AGENT_PANEL_PRESENCE_GRACE_MS = '30'
const {
  forgetPresence,
  hasViewer,
  isWatched,
  rescheduleIfUnwatched,
  seenWhileWatched,
  setPresenceIdleHandler,
  setPresenceGraceMs,
  setPresenceReclaimPolicy,
  setPresenceUnreadKeeper,
  setViewer,
} = await import('./presence.ts')

// 上限默认 8，这里的用例自己设定；未读宽限默认 30 分钟，用例里调小
setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })

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

test('这一轮完成还没看过：也回收，只是宽限更长', async () => {
  const id = 'presence-unread'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  const unread = new Set([id])
  setPresenceUnreadKeeper((taskId) => unread.has(taskId))
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })

  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  await wait(80)
  assert.equal(idle, 0, '未读宽限还没到，先留着')
  assert.equal(isWatched(id), true, '这段时间回来还能直接接着说')
  assert.equal(hasViewer(id), true)

  // 到期照样回收：橙点只有用户点开才会消，不收的话进程永远挂着
  await wait(300)
  assert.equal(idle, 1, '未读宽限到了也回收')
  assert.equal(isWatched(id), false)
  assert.equal(hasViewer(id), false, '回收后不再保活')

  setPresenceUnreadKeeper(() => false)
  forgetPresence(id)
})

test('看过之后页面还开着：不提前计时，等页面切走再算', async () => {
  const id = 'presence-seen-open'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  let unread = true
  setPresenceUnreadKeeper((taskId) => taskId === id && unread)

  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  // 页面重新打开并看过：还在看，不该开始计时
  setViewer(id, 'tab-a', true)
  unread = false
  rescheduleIfUnwatched(id)
  await wait(60)
  assert.equal(idle, 0, '还有人看着，不回收')
  assert.equal(isWatched(id), true)

  // 切走之后才按宽限期回收
  setViewer(id, 'tab-a', false)
  await wait(60)
  assert.equal(idle, 1)

  setPresenceUnreadKeeper(() => false)
  forgetPresence(id)
})

test('宽限计时开始后才变成未读：计时照旧走完，到点回收', async () => {
  const id = 'presence-unread-window'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  let unread = false
  setPresenceUnreadKeeper((taskId) => taskId === id && unread)
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })

  // 已经看过：离开就按已读宽限开始计时
  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  // 计时过程中又被标成未读（例如刚完成一轮）：已经排好的时长不改
  unread = true
  await wait(70)
  assert.equal(idle, 1, '到点照样回收')
  assert.equal(isWatched(id), false)

  setPresenceUnreadKeeper(() => false)
  forgetPresence(id)
})

test('关掉自动回收：页面切走后也不结束，进程一直留着', async () => {
  const id = 'presence-reclaim-off'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  setPresenceUnreadKeeper(() => false)
  setPresenceReclaimPolicy({ enabled: false })

  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  await wait(70)
  assert.equal(idle, 0, '关掉后不计时')
  assert.equal(hasViewer(id), true, '一直留着')

  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })
  forgetPresence(id)
})

test('这一轮完成时页面正开着：算看过，不留橙点也不留着进程', async () => {
  const id = 'presence-seen-while-watched'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  let unread = true
  setPresenceUnreadKeeper((taskId) => taskId === id && unread)

  assert.equal(seenWhileWatched(id), false, '页面还没上报时没人看')
  setViewer(id, 'tab-a', true)
  assert.equal(seenWhileWatched(id), true, '页面开着')

  // 完成时页面正开着：调用方直接把 turnSeenAt 一起写上，不再算未读
  if (seenWhileWatched(id)) unread = false
  setViewer(id, 'tab-a', false)
  await wait(60)
  assert.equal(idle, 1, '按宽限期正常回收')

  setPresenceUnreadKeeper(() => false)
  forgetPresence(id)
})

test('保活只在对话页真的开着时生效：没上报过、过了宽限都不留进程', async () => {
  const id = 'presence-has-viewer'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  setPresenceUnreadKeeper(() => false)

  // 只调接口、没有页面（脚本、测试）：不留 CLI 等下一句
  assert.equal(hasViewer(id), false)

  setViewer(id, 'tab-a', true)
  assert.equal(hasViewer(id), true, '页面开着：回复完可以留进程')

  setViewer(id, 'tab-a', false)
  assert.equal(hasViewer(id), true, '宽限期内切回来还能接着说')
  await wait(60)
  assert.equal(hasViewer(id), false, '过了宽限没人看，不再留进程')
  assert.equal(idle, 1)

  // 清掉记录后回到「没有页面」的状态
  forgetPresence(id)
  assert.equal(hasViewer(id), false)

  setPresenceUnreadKeeper(() => false)
})
