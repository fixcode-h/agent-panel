import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import type { Task, TaskMessage, ToolUse } from './schema.ts'
import {
  convActive,
  convState,
  taskActive,
  taskState,
  taskWaitText,
  convStateText,
  messageStamp,
  stageOf,
  childActivity,
  childActivityText,
  childComplete,
  childHolds,
  childHoldsOf,
  childHoldText,
  childIcon,
  childLastActivity,
  childSpinning,
  childStage,
  childStale,
  childWait,
  childWaitText,
  childWaiting,
  keepAliveBusy,
  keepAliveVictims,
  runRunning,
  stopReasonText,
  taskBusy,
  taskStage,
  type ChildEntry,
} from './task.ts'

// 文案断言按中文：跟着系统语言跑会让结果不稳定
setLang('zh')

test('taskStage：对话交付完一轮（running 但没在跑）算已完成，不是已停止', () => {
  // 子对话做完这一轮后 status 仍是 running、working 回到 false，CLI 在等下一句
  assert.equal(taskStage({ status: 'running', working: false }), 'done')
  assert.equal(taskStage({ status: 'running' }), 'done')
})

test('taskStage：只有 status 是 stopped 才算已停止', () => {
  assert.equal(taskStage({ status: 'stopped' }), 'stopped')
  assert.equal(taskStage({ status: 'stopped', working: true }), 'running')
  assert.equal(taskStage({ status: 'done' }), 'done')
})

test('taskStage：正在跑这一轮算执行中', () => {
  assert.equal(taskStage({ status: 'running', working: true }), 'running')
})

test('taskStage：有等用户确认的请求或没回答的提问，算需要你处理', () => {
  assert.equal(taskStage({ status: 'running', working: true, requests: 1 }), 'you')
  assert.equal(taskStage({ status: 'running', working: false, asking: 2 }), 'you')
  assert.equal(taskStage({ status: 'stopped', requests: 1 }), 'you')
  assert.equal(taskStage({ status: 'running', requests: 0, asking: 0 }), 'done')
})

test('taskStage：失败的任务算需要你处理', () => {
  assert.equal(taskStage({ status: 'failed' }), 'you')
  assert.equal(taskStage({ status: 'failed', working: true }), 'you')
})

test('taskStage：已标记解决但在跑的不算已完成，「已完成」不能盖住还在跑', () => {
  // 正常只在彻底完成时标记解决（见 childHolds）；标早了也不能隐藏还在执行、计划没做完这些事实
  assert.equal(taskStage({ status: 'running', working: true, resolved: true }), 'running')
  assert.equal(taskStage({ status: 'running', working: false, resolved: true }), 'done')
  assert.equal(taskStage({ status: 'stopped', resolved: true }), 'done')
  assert.equal(taskStage({ status: 'running', working: false, resolved: true, unfinished: true }), 'unfinished')
})

test('taskStage：后台命令还在跑就算执行中，不算已完成', () => {
  assert.equal(taskStage({ status: 'running', working: false, background: 2 }), 'running')
  assert.equal(taskStage({ status: 'running', working: false, background: 0 }), 'done')
  assert.equal(taskStage({ status: 'running', working: false, background: 1, resolved: true }), 'running')
})

test('childHolds：合并完成但计划没做完 / 有提问 / 后台命令在跑都不算彻底完成', () => {
  // 合并成功只是分支回去了：计划 5/7、后台还在跑、有待回答的提问时都还要接着做
  assert.deepEqual(childHolds({ plan: { done: 5, total: 7 } }), ['plan'])
  assert.deepEqual(childHolds({ background: 1 }), ['background'])
  assert.deepEqual(childHolds({ asking: 1 }), ['asking'])
  assert.deepEqual(childHolds({ requests: 1 }), ['requests'])
  assert.deepEqual(childHolds({ working: true }), ['working'])
  assert.deepEqual(childHolds({ unmerged: true }), ['unmerged'])
  // 每样都占一点时都列出来，界面按这些原因说明分支为什么还留着
  assert.deepEqual(childHolds({ working: true, background: 1, plan: { done: 1, total: 3 }, asking: 2 }), [
    'working',
    'background',
    'plan',
    'asking',
  ])
  assert.equal(childComplete({ plan: { done: 5, total: 7 } }), false)
  assert.equal(childComplete({ background: 1 }), false)
  assert.equal(childComplete({ asking: 1 }), false)
})

test('childHolds：计划做完、后台结束、没有问题、已经合回去才彻底完成', () => {
  assert.deepEqual(childHolds({}), [])
  assert.equal(childComplete({}), true)
  // 计划步骤都做完了（只是还在写总结）不算没做完
  assert.equal(childComplete({ plan: { done: 7, total: 7 }, background: 0, asking: 0, unmerged: false }), true)
})

test('childHoldsOf：从任务上取状态，后台命令数和合并状态由服务端补上', () => {
  const task = (over: Partial<Task> = {}) =>
    ({
      working: false,
      requests: [],
      parentAsks: [],
      plans: [],
      steps: [],
      ...over,
    }) as Task
  assert.deepEqual(childHoldsOf(task(), { merged: true }), [])
  assert.deepEqual(childHoldsOf(task(), { merged: false }), ['unmerged'])
  assert.deepEqual(childHoldsOf(task({ working: true }), { merged: true }), ['working'])
  assert.deepEqual(childHoldsOf(task(), { background: 2, merged: true }), ['background'])
  assert.deepEqual(childHoldsOf(task({ parentAsks: [{ id: 'a' }] as Task['parentAsks'] }), { merged: true }), [
    'asking',
  ])
  assert.deepEqual(childHoldsOf(task({ requests: [{ id: 'r' }] as Task['requests'] }), { merged: true }), ['requests'])
})

test('childHoldText：每条原因都说清楚，界面和标记完成的提示共用', () => {
  assert.equal(childHoldText(['plan']), '计划还没做完')
  assert.equal(childHoldText(['background', 'asking']), '后台命令还没跑完、还有等你回答的提问')
})

test('taskStage：计划没做完的不算已完成（等着下一句也一样）', () => {
  // 子对话页面底部显示「等待你的下一条消息」，但计划才 7/8
  assert.equal(taskStage({ status: 'running', working: false, unfinished: true }), 'unfinished')
  assert.equal(taskStage({ status: 'running', working: false, unfinished: false }), 'done')
  // 用户主动停下、失败、在等你处理都比「未完成」靠前：那几个已经说明了该怎么办
  assert.equal(taskStage({ status: 'stopped', unfinished: true }), 'stopped')
  assert.equal(taskStage({ status: 'failed', unfinished: true }), 'you')
  assert.equal(taskStage({ status: 'running', working: true, unfinished: true }), 'running', '还在执行就算执行中')
  assert.equal(taskStage({ status: 'running', working: false, unfinished: true, asking: 1 }), 'you')
})

test('runRunning：start_plan 启动的工作流运行没跑完就算还在跑', () => {
  const run = (status: string, endedAt = '') => ({ id: 1, status, startedAt: '', endedAt }) as Task['runs'][number]
  assert.equal(runRunning({ status: 'running', runs: [run('running')] }), true)
  assert.equal(runRunning({ status: 'running', runs: [run('done', '2026-01-01')] }), false)
  // 运行停了/任务被停：节点状态残留也不当成还在跑
  assert.equal(runRunning({ status: 'stopped', runs: [run('running')] }), false)
  // 旧任务没有运行记录：这一轮里还有节点在跑就算
  const step = (status: string) => ({ id: 's1', status }) as Task['steps'][number]
  assert.equal(runRunning({ status: 'running', steps: [step('running')] }), true)
  assert.equal(runRunning({ status: 'running', steps: [step('done')] }), false)
  // 有运行记录时以它为准，不看节点状态
  assert.equal(runRunning({ status: 'running', runs: [run('done')], steps: [step('running')] }), false)
})

test('工作流还在跑：不算彻底完成、阶段仍是执行中、任务列表也算执行中', () => {
  assert.deepEqual(childHolds({ workflow: true }), ['workflow'])
  assert.equal(childComplete({ workflow: true }), false)
  assert.equal(childHoldText(['workflow']), '工作流还没跑完')
  assert.equal(taskStage({ status: 'running', working: false, workflow: true }), 'running')
  assert.equal(taskStage({ status: 'running', working: false, workflow: true, resolved: true }), 'running')
  const task = {
    status: 'running' as const,
    working: true,
    requests: [],
    parentAsks: [],
    plans: [],
    steps: [],
    runs: [{ id: 1, status: 'running', startedAt: '', endedAt: '' }] as Task['runs'],
  }
  assert.deepEqual(childHoldsOf(task, { merged: true }), ['working', 'workflow'])
  assert.equal(taskBusy({ status: 'running', steps: [], working: false, runs: task.runs }), true)
  assert.equal(taskBusy({ status: 'running', steps: [], working: false, runs: [] }), false)
})

test('派出去的子任务还在跑：也不算彻底完成', () => {
  assert.deepEqual(childHolds({ helpers: true }), ['helpers'])
  assert.equal(childHoldText(['helpers']), '派出的子任务还没跑完')
  assert.equal(taskStage({ status: 'running', working: false, helpers: true }), 'running')
  const task = {
    status: 'running' as const,
    working: false,
    requests: [],
    parentAsks: [],
    plans: [],
    steps: [{ slot: 'sub', status: 'running' }] as Task['steps'],
    runs: [] as Task['runs'],
  }
  assert.deepEqual(childHoldsOf(task, { merged: true }), ['helpers'])
  // 工作流节点（不是派出的子任务）算在 workflow 上，两条不重复
  assert.deepEqual(childHoldsOf({ ...task, steps: [{ slot: '', status: 'running' }] as Task['steps'] }), ['workflow'])
})

test('没彻底完成的子对话行首转圈，在等你选择时不转', () => {
  const kid = (over: Partial<ChildEntry> = {}) =>
    ({
      id: 'c',
      title: '子对话',
      status: 'running',
      working: false,
      cliAlive: true,
      startedAt: '',
      ...over,
    }) as ChildEntry
  // 还在干活、计划没做完、后台命令/工作流/派出的子任务还在跑、独立分支没合回：都要转圈
  assert.equal(childSpinning(kid({ working: true })), true)
  assert.equal(childSpinning(kid({ plan: { done: 6, total: 9 } })), true)
  assert.equal(childSpinning(kid({ background: 1 })), true)
  assert.equal(childSpinning(kid({ workflow: true })), true)
  assert.equal(childSpinning(kid({ helpers: true })), true)
  assert.equal(childSpinning(kid({ unmerged: true })), true)
  assert.equal(childStage(kid({ unmerged: true })), 'unfinished')
  // 在等你：换成提问图标，转圈会把「等你选择」说成「还在跑」
  assert.equal(childSpinning(kid({ asking: 1 })), false)
  assert.equal(childWaiting(kid({ asking: 1 })), true)
  assert.equal(childWaiting(kid({ requests: 1 })), true)
  assert.equal(childWaiting(kid({ working: true })), false)
  assert.equal(childSpinning(kid({ plan: { done: 1, total: 3 }, asking: 1 })), false)
  // 做完了、停下了、失败了都不转圈
  assert.equal(childSpinning(kid({})), false)
  assert.equal(childSpinning(kid({ status: 'stopped' })), false)
  assert.equal(childSpinning(kid({ status: 'failed' })), false)
  assert.equal(childSpinning(kid({ plan: { done: 9, total: 9 } })), false)
  // 已标记解决但分支还没合回：分组上仍是未完成，行首也跟着转，别一边说未完成一边像做完了
  assert.equal(childStage(kid({ unmerged: true, resolved: true })), 'unfinished')
  assert.equal(childSpinning(kid({ unmerged: true, resolved: true })), true)
  assert.equal(childStage(kid({})), 'done')
})

/** 列表里的一行：图标、分组、徽标都读 ChildEntry（见 TaskView 的子对话行） */
const row = (over: Partial<ChildEntry> = {}) =>
  ({
    id: 'c',
    title: '子对话',
    status: 'running',
    working: false,
    cliAlive: true,
    startedAt: '',
    ...over,
  }) as ChildEntry

test('childIcon：分组、图标、childHolds 三者同源，已完成 ⇔ 图标完成 ⇔ 没有没做完的', () => {
  // 每种快照都从同一份 ChildEntry 算：进「已完成」组、图标是完成态、childHolds 为空必须同时成立
  const cases: ChildEntry[] = [
    // 交付完一轮、CLI 还在等下一句
    row({}),
    // 已标记解决：以前图标按 status='stopped' 画成暂停，分组却是已完成
    row({ status: 'stopped', resolved: true }),
    // 已关闭（进程没了）但确实做完了：不能因为进程没了就画成暂停
    row({ cliAlive: false }),
    row({ status: 'stopped', resolved: true, cliAlive: false }),
    // 还没做完的几种
    row({ plan: { done: 1, total: 3 } }),
    row({ unmerged: true }),
    row({ working: true }),
    row({ background: 1 }),
    row({ workflow: true }),
    row({ helpers: true }),
    row({ asking: 1 }),
    row({ requests: 1 }),
    row({ status: 'failed' }),
    row({ status: 'stopped' }),
    row({ status: 'stopped', stopReason: 'parent' }),
  ]
  for (const c of cases) {
    const stage = childStage(c)
    const icon = childIcon(c)
    const holds = childHolds({ ...c })
    assert.equal(
      stage === 'done',
      icon === 'done',
      `分组和图标必须一致：${JSON.stringify(c)} 分组 ${stage}，图标 ${icon}`,
    )
    // 进「已完成」的一定没有没做完的事；反过来，还有没做完的事就一定不在已完成组
    if (stage === 'done') assert.equal(holds.length, 0, `已完成的不该还差着东西：${JSON.stringify(c)}`)
    if (holds.length) assert.notEqual(stage, 'done', `还差着东西的不能归已完成：${JSON.stringify(c)}`)
    // 失败是另一个维度（不是没做完，是没做成）：不在已完成组，图标是失败，不拿暂停盖住
    if (c.status === 'failed') {
      assert.equal(icon, 'failed')
      assert.notEqual(stage, 'done')
    }
    // 图标和 childSpinning / childWaiting 也是同一份判定
    assert.equal(childSpinning(c), icon === 'running')
    assert.equal(childWaiting(c), icon === 'waiting')
  }
})

test('childIcon：resolved 的项是完成态，不能画成暂停，也不管 CLI 关没关', () => {
  assert.equal(childIcon(row({ status: 'stopped', resolved: true })), 'done')
  assert.equal(childIcon(row({ status: 'stopped', resolved: true, cliAlive: false })), 'done')
  // 已解决但还在跑 / 计划没做完：不能拿「已解决」盖住还在跑的事实
  assert.equal(childIcon(row({ status: 'stopped', resolved: true, working: true })), 'running')
  assert.equal(childIcon(row({ status: 'stopped', resolved: true, plan: { done: 1, total: 2 } })), 'running')
})

test('childIcon：只有用户自己按的暂停才是暂停图标，别的来源是「中断」', () => {
  assert.equal(childIcon(row({ status: 'stopped', stopReason: 'user' })), 'stopped')
  // 旧任务没有原因：当时只有用户按暂停这一条路，保持暂停图标
  assert.equal(childIcon(row({ status: 'stopped' })), 'stopped')
  // 父对话收尾、换 CLI、归档、面板重启、页面切走、被新消息打断：都不是用户暂停
  for (const reason of ['parent', 'switch', 'archive', 'restart', 'presence', 'supersede'] as const) {
    assert.equal(childIcon(row({ status: 'stopped', stopReason: reason })), 'idle', reason)
  }
  // 中断的项不算失败，也不能说成已完成
  assert.equal(childStage(row({ status: 'stopped', stopReason: 'parent' })), 'stopped')
  assert.notEqual(childIcon(row({ status: 'stopped', stopReason: 'parent' })), 'failed')
})

test('childIcon：父对话收尾停掉子对话，子对话不是「用户暂停」', () => {
  // 父对话 92dfd0da 被中断后 closeChildren 逐个停子对话：原因标成 parent，不是 user
  const kid = row({ status: 'stopped', stopReason: 'parent', cliAlive: false })
  assert.equal(childIcon(kid), 'idle')
  assert.equal(childSpinning(kid), false)
  assert.notEqual(childIcon(kid), 'stopped', '父对话收尾不能显示成用户按了暂停')
  // 进程异常退出是 failed：失败图标 + 原因，不是停止
  assert.equal(childIcon(row({ status: 'failed' })), 'failed')
})

test('stopReasonText：只有用户按的暂停说「已暂停」，其它来源说清是谁结束的', () => {
  assert.equal(stopReasonText('user'), '已暂停')
  // 旧任务没有原因：当时只有用户按暂停这一条路
  assert.equal(stopReasonText(undefined), '已暂停')
  assert.equal(stopReasonText('parent'), '父对话结束时一起结束')
  assert.equal(stopReasonText('switch'), '换 CLI / 模型时中断')
  assert.equal(stopReasonText('archive'), '归档时结束')
  assert.equal(stopReasonText('restart'), '面板重启时中断')
  assert.equal(stopReasonText('presence'), '页面切走后结束')
  assert.equal(stopReasonText('supersede'), '被新消息打断')
  assert.equal(stopReasonText('finish'), '做完后收尾')
  // 除了 user，每种来源都不能落回「已暂停」
  assert.equal(stopReasonText('idle'), '闲置太久已回收')
  for (const r of ['parent', 'switch', 'archive', 'restart', 'presence', 'idle', 'supersede', 'finish'] as const)
    assert.notEqual(stopReasonText(r), '已暂停', r)
})

test('keepAliveVictims：超过上限时结束最久没用的，正在看的和刚进入的不算', () => {
  const alive = (id: string, seen: string, awaiting = true) => ({
    id,
    awaitingUser: awaiting,
    turnSeenAt: seen,
    turnDoneAt: '',
    updatedAt: seen,
  })
  const list = [
    alive('a', '2026-01-01T10:00:00Z'),
    alive('b', '2026-01-01T12:00:00Z'),
    alive('c', '2026-01-01T11:00:00Z'),
    alive('running', '2026-01-01T09:00:00Z', false),
  ]
  // 上限 3、刚进来的 d：只超一个，收掉最久没用的 a（running 不在等下一句，不算）
  assert.deepEqual(keepAliveVictims([...list, alive('d', '2026-01-01T13:00:00Z')], 3, 'd'), ['a'])
  // 正在执行的对话不占名额：只剩它一个时上限多小都不收它（它连候选都不是）
  assert.deepEqual(keepAliveVictims([list[3]], 1, 'd'), [], 'running 的既不算名额也不会被选走')
  assert.deepEqual(
    keepAliveVictims([list[3], alive('d', '2026-01-01T13:00:00Z')], 1, 'd'),
    [],
    '只有一个空闲的，没超限',
  )
  // 上限 2：超两个就收两个，从最久没用的开始
  assert.deepEqual(keepAliveVictims([...list, alive('d', '2026-01-01T13:00:00Z')], 2, 'd'), ['a', 'c'])
  // 没超限不动
  assert.deepEqual(keepAliveVictims(list, 4, 'd'), [])
  // 刚进入保活的那个不会被自己收掉
  assert.deepEqual(keepAliveVictims(list, 3, 'a'), [])
  // 页面正开着的不算：b 正在看，就轮不到它
  assert.deepEqual(
    keepAliveVictims(list, 2, 'd', (id) => id === 'a'),
    ['c'],
  )
  // 0 表示不限制
  assert.deepEqual(keepAliveVictims(list, 0, 'd'), [])
  // 不传 exceptId（刚进入保活的那个自己还在忙、不占名额）：不能把那个 +1 算进去，否则会多收一个
  assert.deepEqual(keepAliveVictims(list, 2, ''), ['a'], '上限 2、3 个空闲：只收最久没用的一个')
  assert.deepEqual(keepAliveVictims(list, 3, ''), [], '上限 3、3 个空闲：正好到顶，一个都不收')
})

test('keepAliveBusy：只有停在等下一句、名下没东西在跑的才算空闲', () => {
  const idle = { status: 'running' as const, working: false, awaitingUser: true, prewarming: false, steps: [] }
  assert.equal(keepAliveBusy(idle), false, '停在等下一句：空闲，可以被上限/时长收')
  // 有没回复的提问、请求：还在运行（convActive），不能收
  assert.equal(keepAliveBusy({ ...idle, requests: [{}] as never }), true, '请求还没回复')
  // 正在回话、正在启动：都不是空闲
  assert.equal(keepAliveBusy({ ...idle, working: true }), true, 'CLI 正在回话')
  assert.equal(keepAliveBusy({ ...idle, prewarming: true }), true, '还在启动')
  // 这一轮没收尾（等它派出的子任务、跑工作流节点）：awaitingUser 还是 false
  assert.equal(keepAliveBusy({ ...idle, awaitingUser: false }), true, '这一轮没收尾')
  assert.equal(keepAliveBusy({ ...idle, status: 'done', awaitingUser: false }), false, '已经结束的一轮不算在跑')
  // 后台命令还在跑、名下还有活着的子对话：都要等它们回来接着干
  assert.equal(keepAliveBusy(idle, { background: 1 }), true, '后台命令还在跑')
  assert.equal(keepAliveBusy(idle, { children: 1 }), true, '名下有子对话还在运行')
  assert.equal(keepAliveBusy(idle, { background: 0, children: 0 }), false, '都没有：空闲')
})

/** 子对话的任务快照：只写被测字段，其余给最小默认值 */
const kidTask = (over: Partial<Task> = {}) =>
  ({
    id: 'k',
    title: '子对话',
    status: 'running',
    working: false,
    messages: [],
    steps: [],
    requests: [],
    parentAsks: [],
    plans: [],
    updatedAt: '2026-01-01T10:00:00Z',
    ...over,
  }) as unknown as Task

/** 一份没做完的计划：第一步做完、第二步在跑（或等待中） */
const planOf = (status: 'running' | 'waiting' = 'running') =>
  [
    {
      id: 'p1',
      title: '修 Bug',
      doneAt: '',
      steps: [
        { id: 's1', title: '改后端', status: 'done', note: '', waits: [], children: [], startedAt: '', endedAt: '' },
        {
          id: 's2',
          title: '补测试',
          status,
          note: '',
          waits: [],
          children: [],
          startedAt: '2026-01-01T09:00:00Z',
          endedAt: '',
        },
      ],
    },
  ] as unknown as Task['plans']

test('childWait：等用户 > 等确认 > 等后台命令 > 等子任务 > 等工作流 > 等下一句', () => {
  const ask = kidTask({ parentAsks: [{}] as never, requests: [] as never })
  assert.deepEqual(childWait(ask, { background: 2, cliAlive: true }), { kind: 'answer', n: 1 })

  const confirm = kidTask({ requests: [{}] as never })
  assert.deepEqual(childWait(confirm, { background: 2, cliAlive: true }), { kind: 'confirm', n: 1 })

  // 后台命令在服务端跑，任务里只有编号：数量由调用方传
  assert.deepEqual(childWait(kidTask({ working: true }), { background: 2 }), { kind: 'background', n: 2 })

  // 派出去的子任务（spawn_agents 的步骤）还在跑
  const sub = kidTask({
    working: true,
    steps: [{ id: 'h1', title: '查代码', status: 'running', slot: 'sub' }] as never,
  })
  assert.deepEqual(childWait(sub), { kind: 'helpers', list: ['查代码'] })

  // 工作流运行还没结束：工具调用早返回了，运行本身还在跑
  const run = kidTask({ working: true, runs: [{ status: 'running', endedAt: '' }] as never })
  assert.deepEqual(childWait(run), { kind: 'workflow' })

  // 进程活着但这一轮已经结束：在等下一句，不是卡住
  assert.deepEqual(childWait(kidTask({ working: false }), { cliAlive: true }), { kind: 'next' })
  assert.equal(childWait(kidTask({ working: false }), { cliAlive: false }), undefined)
})

test('childStale：执行中很久没新输出标黄 / 标红，能解释的等待不标', () => {
  const now = Date.parse('2026-01-01T10:10:00Z')
  const at = (iso: string) => ({ working: true, lastActivityAt: iso })

  assert.equal(childStale(at('2026-01-01T10:09:30Z'), now), '')
  // 模型一步要几十秒，两分钟以内不动不算异常
  assert.equal(childStale(at('2026-01-01T10:08:30Z'), now), '')
  assert.equal(childStale(at('2026-01-01T10:07:00Z'), now), 'slow')
  assert.equal(childStale(at('2026-01-01T09:55:00Z'), now), 'stale')
  // 等后台命令、等用户、等工作流时没有新输出是正常的
  assert.equal(childStale({ ...at('2026-01-01T09:55:00Z'), wait: { kind: 'background', n: 1 } }, now), '')
  assert.equal(childStale({ ...at('2026-01-01T09:55:00Z'), wait: { kind: 'answer', n: 1 } }, now), '')
  // 没在跑就不标
  assert.equal(childStale({ working: false, lastActivityAt: '2026-01-01T09:00:00Z' }, now), '')
})

test('childLastActivity：最后一条消息、节点结束时间和任务更新时间里取最晚的', () => {
  const msg = (at: string) => ({ id: at, role: 'agent' as const, agentId: '', step: '', text: '', tools: [], at })
  assert.equal(
    childLastActivity(kidTask({ updatedAt: '2026-01-01T10:00:00Z', messages: [msg('2026-01-01T10:05:00Z')] as never })),
    '2026-01-01T10:05:00Z',
  )
  assert.equal(
    childLastActivity(
      kidTask({
        updatedAt: '2026-01-01T10:00:00Z',
        messages: [msg('2026-01-01T10:05:00Z')] as never,
        steps: [{ id: 's', title: '节点', status: 'running', endedAt: '2026-01-01T10:08:00Z' }] as never,
      }),
    ),
    '2026-01-01T10:08:00Z',
  )
  // 都没有时退回任务更新时间，不返回空串以外的异常
  assert.equal(childLastActivity(kidTask({ updatedAt: '2026-01-01T10:00:00Z' })), '2026-01-01T10:00:00Z')
})

test('childActivity：没在跑也带出计划当前步骤，父对话不用翻计划窗口', () => {
  const task = kidTask({ working: false, plans: planOf() })
  const a = childActivity(task)
  assert.deepEqual(a?.plan, { title: '补测试', child: undefined, done: 1, total: 2 })
  // 没在跑、也没有计划时为空
  assert.equal(childActivity(kidTask({ working: false })), undefined)

  // 在跑时附上计划当前步骤，正在做的动作照常给
  const running = kidTask({
    working: true,
    plans: planOf(),
    messages: [
      {
        id: 'm1',
        role: 'agent',
        agentId: '',
        step: '',
        text: '',
        tools: [{ id: 'x', kind: 'bash', name: 'bash', label: 'npm run test:unit', running: true }],
        at: '2026-01-01T10:00:00Z',
      },
    ] as never,
  })
  const doing = childActivity(running)
  assert.equal(doing?.tool?.label, 'npm run test:unit')
  assert.equal(doing?.plan?.title, '补测试')
  // 一句话版本：在做什么 + 计划做到第几步
  assert.match(childActivityText(doing), /npm run test:unit/)
  assert.match(childActivityText(doing), /计划 1\/2 · 补测试/)
})

test('childWaitText：等待原因说成一句话', () => {
  assert.equal(childWaitText({ kind: 'next' }), '等下一句')
  assert.equal(childWaitText({ kind: 'background', n: 2 }), '等 2 个后台命令')
  assert.equal(childWaitText({ kind: 'answer', n: 1 }), '等用户回答 1 个提问')
  assert.equal(childWaitText(undefined), '')
})

test('convState：8 个状态各自的判定和优先级（ADR 0005）', () => {
  const base = { status: 'running' as const }
  assert.equal(convState({ ...base, working: true }), 'running')
  assert.equal(convState({ ...base, background: 1 }), 'waiting')
  assert.equal(convState({ ...base, workflow: true }), 'waiting')
  assert.equal(convState({ ...base, helpers: true }), 'waiting')
  // 要你处理的排最前：在跑的同时有提问也先说在等你
  assert.equal(convState({ ...base, working: true, asking: 1 }), 'needs')
  assert.equal(convState({ status: 'failed' }), 'failed')
  assert.equal(convState({ status: 'stopped', stopReason: 'user' }), 'stopped')
  assert.equal(convState({ status: 'stopped', stopReason: 'parent' }), 'stopped')
  // 彻底完成后面板收掉进程：不是中断
  assert.equal(convState({ status: 'stopped', stopReason: 'finish' }), 'done')
  assert.equal(convState({ ...base, unfinished: true }), 'unfinished')
  assert.equal(convState({ ...base, unmerged: true }), 'unfinished')
  assert.equal(convState({ ...base, unfinished: true, unmerged: true, wrapup: true }), 'wrapup')
  assert.equal(convState({ ...base, wrapup: true, resolved: true }), 'done')
  assert.equal(convState(base), 'done')
  // 归组：列表的 5 组从这里来
  assert.equal(stageOf('waiting'), 'running')
  assert.equal(stageOf('wrapup'), 'unfinished')
  assert.equal(stageOf('failed'), 'you')
  assert.equal(convStateText('wrapup'), '待收尾')
})

test('messageStamp：工具行收掉运行中、记上耗时也算变化（停止后不再一直转圈）', () => {
  const tool = { kind: 'run', label: 'ls', detail: '', output: 'a', running: true } as unknown as ToolUse
  const msg = { id: 'm', role: 'agent', text: '', tools: [tool] } as unknown as TaskMessage
  const before = messageStamp(msg)
  delete tool.running
  tool.ms = 10
  assert.notEqual(messageStamp(msg), before)
})

test('对外状态统一：子对话、子任务、后台命令、工作流没完，提问没回复，对话都还在运行（ADR 0010）', () => {
  const base = { status: 'running' as const, steps: [], working: false }
  // 这一轮说完了，但名下子对话还在动：等结果，转圈，不能回收
  assert.equal(taskState({ ...base, childrenWorking: 2 }), 'waiting')
  assert.equal(taskBusy({ ...base, childrenWorking: 2 }), true)
  assert.equal(taskWaitText({ ...base, childrenWorking: 2 }), '子对话执行中')
  // 后台命令、子任务
  assert.equal(taskBusy({ ...base, jobs: [{}] as never }), true)
  assert.equal(taskWaitText({ ...base, jobs: [{}] as never }), '后台命令执行中')
  const helper = { id: '@chat/sub/h1', slot: 'sub', status: 'running' } as never
  assert.equal(taskWaitText({ ...base, steps: [helper] }), '子任务执行中')
  // 提问没回复：不转圈（画成提问图标），但同样算还在运行
  assert.equal(taskState({ ...base, requests: [{}] as never }), 'needs')
  assert.equal(taskBusy({ ...base, requests: [{}] as never }), false)
  assert.equal(taskActive({ ...base, requests: [{}] as never }), true)
  assert.equal(taskActive({ ...base, parentAsks: [{}] as never }), true)
  // 真闲着的：可以回收
  assert.equal(taskActive(base), false)
  assert.equal(taskActive({ ...base, status: 'done' }), false)
  // 这一轮失败了但还有会推回来的结果：还在运行，不是失败
  assert.equal(convState({ status: 'failed', background: 1 }), 'waiting')
  assert.equal(convState({ status: 'failed', children: 1 }), 'waiting')
  assert.equal(convState({ status: 'failed' }), 'failed')
  assert.deepEqual(
    (['running', 'waiting', 'needs', 'failed', 'stopped', 'unfinished', 'wrapup', 'done'] as const).filter(convActive),
    ['running', 'waiting', 'needs'],
  )
})
