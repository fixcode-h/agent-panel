import assert from 'node:assert/strict'
import test from 'node:test'

// 宽限期默认 60 分钟，测试里用环境变量缩短（环境变量优先于设置）
process.env.AGENT_PANEL_PRESENCE_GRACE_MS = '30'
// 还在跑的对话宽限到点后的复查间隔（见 presence.ts 的 scheduleRecheck），同样缩短
process.env.AGENT_PANEL_PRESENCE_RECHECK_MS = '200'
const {
  forgetPresence,
  hasViewer,
  isViewing,
  isWatched,
  rescheduleIfUnwatched,
  resetIdleCountdown,
  seenWhileWatched,
  setPresenceBusy,
  setPresenceIdleHandler,
  setPresenceGraceMs,
  setPresenceReclaimPolicy,
  setPresenceUnreadKeeper,
  setViewer,
  touchPresence,
} = await import('./presence.ts')

// 上限默认 8，这里的用例自己设定；未读宽限默认 30 分钟，用例里调小
setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
// 真实保活判定：名下有子对话在跑时，这一轮结束、进程退了也在等结果（见 shared/task.ts 的 keepAliveHolding）
const { keepAliveHolding } = await import('../shared/task.ts')

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

test('正在执行的对话不受两个时长管：到点不回收，空下来重新计满一整段', async () => {
  const id = 'presence-busy'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  const unread = new Set([id])
  setPresenceUnreadKeeper((taskId) => unread.has(taskId))
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })
  let running = true
  setPresenceBusy((taskId) => taskId === id && running)

  // 页面还开着、正在跑：本来就不计时，这里明确断言一次，不靠「没调 false」隐式成立
  setViewer(id, 'tab-open', true)
  await wait(1000)
  assert.equal(idle, 0, '页面开着又在跑：不回收')
  setViewer(id, 'tab-open', false)

  // 页面切到后台（卸载和隐藏报的是一样的 false），宽限过了两轮还在跑
  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  await wait(700)
  assert.equal(idle, 0, '正在执行：宽限到了也不结束这一轮')
  assert.equal(isWatched(id), true, '还在跑的对话不能因为没人看就被收掉')

  // 这一轮真的结束、开始停着等下一句：从这一刻起重新算满一整段，执行期间过掉的时间不算
  running = false
  resetIdleCountdown(id)
  await wait(20)
  assert.equal(idle, 0, '刚空下来不立刻回收')
  await wait(1200)
  assert.equal(idle, 1, '空满一整段才回收')

  setPresenceBusy(() => false)
  setPresenceUnreadKeeper(() => false)
  forgetPresence(id)
})

test('宽限期设成 0：正在跑的对话不会靠 0ms 定时器反复重排，空下来才回收', async () => {
  const id = 'presence-zero-grace'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  const unread = new Set([id])
  setPresenceUnreadKeeper((taskId) => unread.has(taskId))
  // 宽限期 0：到点就收
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 0 })
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
  setPresenceUnreadKeeper(() => false)
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })
  forgetPresence(id)
})

test('父对话在等子对话：宽限到了也不回收，子对话结束、自己空下来之后照旧回收', async () => {
  const id = 'presence-child-running'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  setPresenceUnreadKeeper(() => false)
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })
  // 父对话这一轮已经结束、进程也退了（不保活的 CLI）：只有名下的子对话还在跑
  let children = 1
  setPresenceBusy((taskId) => taskId === id && keepAliveHolding({ live: false, children }))

  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  await wait(200)
  assert.equal(idle, 0, '名下有子对话在跑：宽限到了也不回收，回收会把父对话落成「已中断」')
  assert.equal(isWatched(id), true, '还在等子对话的结果，不能当成没人看的空闲会话')

  // 子对话跑完、父对话也空下来：从这一刻重新算满一整段，到点照旧回收（不是永远不回收）
  children = 0
  resetIdleCountdown(id)
  await wait(20)
  assert.equal(idle, 0, '刚空下来不立刻回收')
  await wait(200)
  assert.equal(idle, 1, '子对话全结束、也空闲了，照旧按现有规则回收')

  setPresenceBusy(() => false)
  forgetPresence(id)
})

test('宽限到点还在跑的对话留一个复查：子对话被停掉、自己空下来后照旧回收', async () => {
  const id = 'presence-busy-recheck'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  setPresenceUnreadKeeper(() => false)
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })
  // 父对话没有执行位（这一轮结束、进程已退），名下的子对话还在跑
  let children = 1
  setPresenceBusy((taskId) => taskId === id && keepAliveHolding({ live: false, children }))

  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  // 宽限到点：还在等子对话，不回收
  await wait(100)
  assert.equal(idle, 0, '还在等子对话：不回收')

  // 子对话被用户强制停掉，结果不会再交回：不会再走 onKeepAlive 重置计时，只能靠复查把它拉回收
  children = 0
  await wait(300)
  assert.equal(idle, 1, '空下来后复查到点照旧回收（不能永远挂成「等结果」）')

  setPresenceBusy(() => false)
  forgetPresence(id)
})

test('关掉自动回收：宽限或复查到点都不收（开关只有一处读）', async () => {
  const id = 'presence-recheck-off'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  setPresenceUnreadKeeper(() => false)
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })
  let children = 1
  setPresenceBusy((taskId) => taskId === id && keepAliveHolding({ live: false, children }))

  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  // 宽限到点、还在跑：先真的排上复查计时器
  await wait(60)
  assert.equal(idle, 0, '还在等子对话：不回收')
  // 这时才关掉「按时间回收」：已排的复查到点也不能收（不是只测宽限计时器）
  setPresenceReclaimPolicy({ enabled: false })
  children = 0
  await wait(300)
  assert.equal(idle, 0, '关掉自动回收后，复查也不能把会话收掉')

  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })
  setPresenceBusy(() => false)
  forgetPresence(id)
})

test('复查不占宽限计时：空下来以后按宽限收，不等到复查点', async () => {
  const id = 'presence-recheck-grace'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  setPresenceUnreadKeeper(() => false)
  setPresenceReclaimPolicy({ enabled: true, unreadGraceMs: 300 })
  let children = 1
  setPresenceBusy((taskId) => taskId === id && keepAliveHolding({ live: false, children }))

  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  // 宽限到点、还在跑：排上复查（200ms）
  await wait(60)
  assert.equal(idle, 0, '还在等子对话：不回收')

  // 子对话结束、这一轮也看过了（对应 /seen 后的 rescheduleIfUnwatched）：宽限 30ms 就该收，不能等复查点
  children = 0
  rescheduleIfUnwatched(id)
  await wait(120)
  assert.equal(idle, 1, '空下来后按宽限回收，不被复查计时占住')

  setPresenceBusy(() => false)
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

test('保活上限只放过前台开着的页面：切走后宽限期里 hasViewer 还算有人，isViewing 不算', () => {
  const id = 'presence-viewing'
  setPresenceIdleHandler(() => {})
  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-b', true)
  assert.equal(isViewing(id), true)
  setViewer(id, 'tab-a', false)
  assert.equal(isViewing(id), true, '另一个标签页还开着')
  setViewer(id, 'tab-b', false)
  assert.equal(hasViewer(id), true, '宽限期里回来还能接着说')
  assert.equal(isViewing(id), false, '但已经不在看了，超过保活上限时可以收掉')
  forgetPresence(id)
})

test('菜单「激活 Agent」：过了宽限的对话重新算有人看，再过一整段宽限照常回收', async () => {
  const id = 'presence-touch'
  let idle = 0
  setPresenceIdleHandler((taskId) => {
    if (taskId === id) idle++
  })
  setPresenceUnreadKeeper(() => false)
  setViewer(id, 'tab-a', true)
  setViewer(id, 'tab-a', false)
  await wait(60)
  assert.equal(hasViewer(id), false, '页面切走、过了宽限')
  assert.equal(idle, 1)

  // 从侧栏点激活：不然拉起的 CLI 一停到等下一句就会退出
  touchPresence(id)
  assert.equal(hasViewer(id), true)
  assert.equal(isWatched(id), true)
  await wait(60)
  assert.equal(hasViewer(id), false, '激活后仍然没人打开：宽限到了照常回收')
  assert.equal(idle, 2)
  forgetPresence(id)
})
