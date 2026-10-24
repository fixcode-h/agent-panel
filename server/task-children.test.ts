/**
 * 子对话列表：排序规则（先状态分类、同类按本次开启时间）、本次开启时间的口径、
 * 只列进程还活着的、父对话的「有子对话在跑」和 CLI 生命周期约定。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../shared/i18n.ts'
import { Task } from '../shared/schema.ts'
import {
  childCounts,
  childStage,
  childStartedAt,
  runningChildren,
  sortChildren,
  splitStepJobs,
  taskSummary,
  visibleChildren,
} from '../shared/task.ts'

setLang('zh')

const kid = (id: string, over: Partial<Parameters<typeof sortChildren>[0][number]> = {}) => ({
  id,
  title: id,
  status: 'running' as const,
  working: false,
  cliAlive: false,
  startedAt: '2026-10-21T00:00:00.000Z',
  ...over,
})

test('子对话排序：先按状态分类（需要你处理 → 执行中 → 已完成 → 已停止），分类顺序不随时间变', () => {
  const list = [
    kid('stopped', { status: 'stopped', startedAt: '2026-10-21T09:00:00.000Z' }),
    kid('done', { status: 'done', startedAt: '2026-10-21T08:00:00.000Z' }),
    kid('running', { working: true, startedAt: '2026-10-21T07:00:00.000Z' }),
    kid('failed', { status: 'failed', startedAt: '2026-10-21T06:30:00.000Z' }),
    kid('asking', { asking: 1, startedAt: '2026-10-21T06:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['failed', 'asking', 'running', 'done', 'stopped'],
    '失败和提问都算「需要你处理」（这一类里按开启时间倒序）；分类顺序不随开启时间变',
  )
})

test('子对话排序：同一类里按本次开启的时间倒序', () => {
  const list = [
    kid('old', { startedAt: '2026-10-20T10:00:00.000Z' }),
    kid('new', { startedAt: '2026-10-21T09:00:00.000Z' }),
    kid('mid', { startedAt: '2026-10-21T08:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['new', 'mid', 'old'],
    '越新开启的越靠前',
  )
})

test('子对话排序：同时有多个在执行时，它们之间也按本次开启的时间倒序', () => {
  const list = [
    kid('a', { working: true, startedAt: '2026-10-21T07:00:00.000Z' }),
    kid('b', { working: true, startedAt: '2026-10-21T09:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['b', 'a'],
  )
})

test('子对话排序：排序键相同用 id 兜底，同样的数据每次排出来一样', () => {
  const same = '2026-10-21T00:00:00.000Z'
  const list = [kid('c', { startedAt: same }), kid('a', { startedAt: same }), kid('b', { startedAt: same })]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    sortChildren(list.slice().reverse()).map((x) => x.id),
    ['a', 'b', 'c'],
    '传入顺序变了一样排得出来同样的结果',
  )
})

test('本次开启的时间：取最近一轮开始执行的时间，没执行过按创建时间', () => {
  const turn = (startedAt: string) => ({
    id: startedAt,
    title: '做点什么',
    status: 'done' as const,
    startedAt,
    from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
  })
  const task = (createdAt: string, turns: ReturnType<typeof turn>[]) =>
    Task.parse({
      id: 'kid',
      projectId: '',
      title: '子对话',
      mode: 'chat',
      status: 'done',
      messages: [],
      steps: [],
      turns,
      createdAt,
      updatedAt: createdAt,
      working: false,
    })

  assert.equal(childStartedAt(task('2026-10-20T00:00:00.000Z', [])), '2026-10-20T00:00:00.000Z', '没执行过按创建时间')
  const first = task('2026-10-20T00:00:00.000Z', [turn('2026-10-20T00:00:00.000Z')])
  assert.equal(childStartedAt(first), '2026-10-20T00:00:00.000Z')
})

test('子对话排序：做完后又接到新任务的排到最前面', () => {
  const turn = (startedAt: string) => ({
    id: startedAt,
    title: '做点什么',
    status: 'done' as const,
    startedAt,
    from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
  })
  const task = (id: string, createdAt: string, turns: ReturnType<typeof turn>[]) =>
    Task.parse({
      id,
      projectId: '',
      title: id,
      mode: 'chat',
      status: 'done',
      messages: [],
      steps: [],
      turns,
      createdAt,
      updatedAt: createdAt,
      working: false,
    })
  // 两个都是一直等着的子对话：老的先建、新的后建，老的做完后又被派了新任务
  const fresh = task('fresh', '2026-10-21T00:00:00.000Z', [turn('2026-10-21T00:00:00.000Z')])
  const resumed = task('resumed', '2026-10-20T00:00:00.000Z', [
    turn('2026-10-20T00:00:00.000Z'),
    turn('2026-10-21T12:00:00.000Z'),
  ])
  const list = [fresh, resumed].map((x) => ({
    ...kid(x.id, { status: x.status }),
    startedAt: childStartedAt(x),
  }))
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['resumed', 'fresh'],
    '重新接了新任务的按本次开启时间排到最前面',
  )
})

test('子对话排序：计划没做完的归「未完成」，排在执行中后面、已完成前面', () => {
  const list = [
    kid('done', { startedAt: '2026-10-21T09:00:00.000Z' }),
    kid('unfinished', { plan: { done: 7, total: 8 }, startedAt: '2026-10-21T08:00:00.000Z' }),
    kid('running', { working: true, startedAt: '2026-10-21T07:00:00.000Z' }),
  ]
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['running', 'unfinished', 'done'],
    '计划没做完的不算已完成，开启时间再新也压不过执行中的',
  )
})

test('「运行中」列真正在干活的：后台命令还在跑的也算，只在等下一句的不混进来', () => {
  const list = [
    kid('running', { working: true }),
    kid('waiting', { startedAt: '2026-10-21T09:00:00.000Z' }),
    kid('waitingPlan', { plan: { done: 7, total: 8 } }),
    // 后台命令跑在服务端，CLI 只是在等结果：子对话还没做完，不能从「运行中」里消失
    kid('background', { background: 1 }),
    // 标记解决标早了（还在跑）：也要列出来，「已完成」不能盖住还在跑
    kid('resolvedRunning', { working: true, resolved: true }),
  ]
  assert.deepEqual(
    runningChildren(list).map((x) => x.id),
    ['running', 'background', 'resolvedRunning'],
    '等下一句的、计划没做完等着继续的不算运行中',
  )
})

test('子对话排序不改传入的数组', () => {
  const list = [kid('old', { startedAt: '2026-10-20T00:00:00.000Z' }), kid('new')]
  sortChildren(list)
  assert.deepEqual(
    list.map((x) => x.id),
    ['old', 'new'],
  )
})

test('默认只看进程还活着的：cliAlive 决定进不进默认列表，已关闭的只在「全部」里', () => {
  const list = [
    kid('alive', { cliAlive: true, startedAt: '2026-10-20T00:00:00.000Z' }),
    kid('closed', { startedAt: '2026-10-21T00:00:00.000Z' }),
  ]
  assert.deepEqual(
    list.filter((x) => x.cliAlive).map((x) => x.id),
    ['alive'],
    '默认列表只列进程还活着的',
  )
  assert.deepEqual(
    sortChildren(list).map((x) => x.id),
    ['closed', 'alive'],
    '「全部」里都列出来，仍然按本次开启的时间倒序',
  )
})

test('父对话的「执行中」：自己有子对话在跑时也算，但不改变完成状态和通知语义', () => {
  const base = {
    id: 'parent',
    projectId: '',
    title: '父对话',
    mode: 'chat',
    status: 'done',
    messages: [],
    steps: [],
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    working: false,
  }
  const parsed = Task.parse(base)
  // 摘要里带上 childrenWorking 时，侧栏据此转圈
  const withKids = taskSummary({ ...parsed, childrenWorking: 2 })
  assert.equal(withKids.childrenWorking, 2)
  assert.equal(withKids.status, 'done', '任务本身仍然是完成：不因为子对话在跑就把状态改成执行中')
  assert.equal(withKids.working, false, '也不是父对话自己在跑')
  // 没有子对话在跑时字段不出现，侧栏按原来的 working 判断
  assert.equal(taskSummary(parsed).childrenWorking, undefined)
})

test('子对话计数：在跑又带着没做完计划的，归「执行中」，和行内「执行中」标签、转圈图标同一批', () => {
  // 这是「三个子对话在转圈，状态栏却写 1/5」那次的场景：在跑的子对话计划还没做完，
  // 分组不能把它归到「未完成」，否则列表里转着圈、标题却是未完成，计数也会少算。
  const list = [
    kid('a', { working: true, cliAlive: true }),
    kid('b', { working: true, cliAlive: true, plan: { done: 1, total: 2 } }),
    kid('c', { working: true, cliAlive: true, plan: { done: 1, total: 2 } }),
    kid('waiting1', { cliAlive: true }),
    kid('waiting2', { cliAlive: true }),
    kid('closed', { cliAlive: false }),
  ]
  for (const id of ['a', 'b', 'c']) {
    const x = list.find((y) => y.id === id)!
    assert.equal(childStage(x), 'running', `${id} 在跑，就算计划没做完也是执行中`)
  }
  assert.equal(childStage(list.find((x) => x.id === 'waiting1')!), 'done', '没在跑、计划做完了的是已完成')
  assert.equal(runningChildren(list).length, 3)
  // 分子 3（执行中）和浮层「执行中」分组、行内的「执行中」标签是同一批；分母是进程还活着的 5 个
  assert.deepEqual(childCounts(list), { running: 3, total: 5 })
})

test('子对话计数：标记「解决」但还在跑的，仍然算进行中（不能让它从计数里消失）', () => {
  const list = [
    kid('running', { working: true, cliAlive: true }),
    kid('resolved', { working: true, cliAlive: true, resolved: true }),
  ]
  assert.deepEqual(childCounts(list), { running: 2, total: 2 }, '还在跑就算进去，不能因为标了解决就藏起来')
})

test('子对话计数：进程信息还没回来时分母不小于分子，不显示成 3/0', () => {
  const list = [kid('a', { working: true }), kid('b', { working: true }), kid('c', { working: true })]
  assert.deepEqual(childCounts(list), { running: 3, total: 3 })
})

test('子对话计数：没有子对话时是 0/0', () => {
  assert.deepEqual(childCounts([]), { running: 0, total: 0 })
})

test('子对话计数：计划没做完但这一轮没在跑的，也转圈、也算进分子', () => {
  // 「未完成」组的行首也转圈（见 shared/task.ts 的 childIcon）：计数只算 working 就会出现
  // 「列表里三个在转圈、上面写 1/5」，所以分子取转圈的那一批。
  const list = [kid('unfinished', { cliAlive: true, plan: { done: 1, total: 3 } })]
  assert.equal(childStage(list[0]), 'unfinished')
  assert.deepEqual(childCounts(list), { running: 1, total: 1 })
})

test('子对话计数：在等你选择的不转圈，不算进分子', () => {
  const list = [
    kid('asking', { working: true, cliAlive: true, asking: 1 }),
    kid('running', { working: true, cliAlive: true }),
  ]
  assert.equal(childStage(list[0]), 'you', '有未回答的提问时这一行说的是「等你选择」')
  assert.deepEqual(childCounts(list), { running: 1, total: 2 }, '等你的那一行不转圈，就不算进行中，但仍占分母')
})

test('运行区列的子对话：和悬浮层「运行中」、状态栏计数是同一批，已解决但还在跑的也要列', () => {
  // 这一条盯着「两处口径」：运行区以前自己写 `working && !resolved`，
  // 于是等后台命令、计划没做完、已解决但还在跑的子对话只在弹层里有，同一个页面对不上数
  const at = (n: number) => `2026-10-21T0${n}:00:00.000Z`
  const list = [
    kid('working', { working: true, cliAlive: true, startedAt: at(1) }),
    // 在等后台命令：这一轮没在跑，CLI 在等命令结果
    kid('background', { working: false, cliAlive: true, background: 1, startedAt: at(2) }),
    // 计划没做完，CLI 已经停了
    kid('unfinished', { working: false, cliAlive: false, plan: { done: 1, total: 3 }, startedAt: at(3) }),
    // 已经请父对话收尾、还没出结果
    kid('wrapup', { working: false, cliAlive: true, wrapup: true, startedAt: at(4) }),
    // 已标记解决但还在跑：resolved 不能盖住还在跑
    kid('resolved-running', { working: true, cliAlive: true, resolved: true, startedAt: at(5) }),
    // 在等你拍板：那是等你，不是还在跑，不列
    kid('asking', { working: true, cliAlive: true, asking: 1, startedAt: at(6) }),
    // 真的做完了、进程还活着的也不列
    kid('done', { status: 'done', resolved: true, cliAlive: true, startedAt: at(7) }),
  ]
  const shown = visibleChildren(list)
  assert.deepEqual(
    shown.map((x) => x.id),
    ['resolved-running', 'background', 'working', 'wrapup', 'unfinished'],
    '在跑的那一类在前（同类按本次开启时间倒序），再是计划没做完、待收尾的',
  )
  assert.equal(shown.length, childCounts(list).running, '运行区的条数就是状态栏分子，不许两处各算一遍')
  assert.deepEqual(
    shown.map((x) => x.id),
    sortChildren(list)
      .filter((x) => shown.includes(x))
      .map((x) => x.id),
    '顺序和悬浮层列表（sortChildren）一致',
  )
})

test('运行区列的子对话：后台命令、工作流、派出的子任务也算在跑，和行首图标同一处判定', () => {
  const list = [
    kid('background', { background: 2 }),
    kid('workflow', { workflow: true }),
    kid('helpers', { helpers: true }),
    kid('idle', {}),
  ]
  assert.deepEqual(
    visibleChildren(list).map((x) => x.id),
    ['background', 'helpers', 'workflow'],
    '同一类里开启时间一样时按 id 兜底排序（同 sortChildren）',
  )
})

test('运行区的后台命令按来源分：挂在子任务上的单独列，父对话自己起的照旧', () => {
  const steps = [
    { id: '@chat', slot: '', title: '对话' },
    { id: '@chat/sub/h1', slot: 'sub', title: '核对限流规则' },
    { id: '@chat/sub/h2', slot: 'sub', title: '补登录用例' },
    { id: '3', slot: 'step', title: '第 3 步' },
  ]
  const jobs = [
    { id: 'j1', step: '@chat/sub/h1' },
    { id: 'j2' },
    { id: 'j3', step: '3' },
    // 步骤已经不在了（子任务被删、旧记录）：当成父对话自己的，不能丢在两边都不列
    { id: 'j4', step: '@chat/sub/h9' },
    // 同一个子任务起的第二、三条命令：和 j1 归成一行，不能列成三个同名子任务
    { id: 'j5', step: '@chat/sub/h1' },
    { id: 'j6', step: '@chat/sub/h1' },
  ]
  const { sub, own } = splitStepJobs(steps, jobs)
  assert.deepEqual(
    sub.map((x) => [x.step.id, x.jobs.map((j) => j.id)]),
    [['@chat/sub/h1', ['j1', 'j5', 'j6']]],
    '只有 slot=sub 的步骤算子任务：父对话挂在自己计划步骤（slot=step）上的仍算自己的',
  )
  assert.deepEqual(
    own.map((x) => x.id),
    ['j2', 'j3', 'j4'],
  )
  // 这次改动之前的 jobs 没有 step：全部算父对话的，不能因此把父对话的命令弄丢了
  const oldJobs: { id: string; step?: string }[] = [{ id: 'old' }]
  assert.deepEqual(
    splitStepJobs(steps, oldJobs).own.map((x) => x.id),
    ['old'],
  )
  assert.deepEqual(splitStepJobs(steps, oldJobs).sub, [])
})
