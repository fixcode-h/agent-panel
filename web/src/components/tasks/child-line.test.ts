/**
 * 子对话一行的状态标签：一行只说一件事，全部从 childIcon / childState 派生。
 * 「已关闭」是按服务端真实进程算的 cliAlive，以前不看 childIcon 就往外推，
 * 于是「已关闭」会和计划进度、「等结果」同屏——进程没了却还在等结果，用户看不明白
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang, t } from '@shared/i18n'
import { childIcon, type ChildWait } from '@shared/task'
import { childClosedHint, childLabels, childNote, listedChildren, type ChildSummary } from './child-line'

// 整个文件断言的都是文案：固定成中文，不跟着 CI 的 LANG 变（见 docs/lessons 的测试教训）
setLang('zh')

const waitBackground = (n: number): ChildWait => ({ kind: 'background', n })

/** 用户截图里那一行：进程已经回收，但计划没做完、还在等后台命令 */
const closedWaiting = (over: Partial<ChildSummary> = {}): ChildSummary => ({
  id: 'c1',
  title: '子对话 设置页代理挪位与右栏分类菜单',
  status: 'running',
  working: false,
  // 服务端按真实进程登记算：等后台命令期间进程已经退出
  cliAlive: false,
  startedAt: '2026-10-20T00:00:00.000Z',
  plan: { done: 13, total: 14 },
  background: 1,
  waiting: waitBackground(1),
  summary: '正在改设置页',
  updatedAt: '2026-10-20T00:10:00.000Z',
  ...over,
})

const texts = (c: ChildSummary) => childLabels(c).map((l) => l.text)

test('还在等后台命令时不能说「已关闭」：CLI 进程回收是设计内的，对话还在跑', () => {
  const line = texts(closedWaiting())
  assert.ok(!line.includes(t('已关闭')), `这一行不该出现「已关闭」：${line.join(' / ')}`)
  // 该说的话都在：计划进度、在等什么
  assert.deepEqual(line, [t('计划 {done}/{total}', { done: 13, total: 14 }), t('等结果')])
})

test('派出的子任务 / 工作流还没完时同样不显示「已关闭」', () => {
  for (const over of [
    { background: 0, helpers: true, waiting: { kind: 'helpers' as const, list: ['核对设置页'] } },
    { background: 0, workflow: true, waiting: { kind: 'workflow' as const } },
    // 进程没了、这一轮在等用户回答：那是「等你回答」的事，不是「已关闭」
    { background: 0, waiting: { kind: 'answer' as const, n: 1 }, asking: 1 },
  ]) {
    const line = texts(closedWaiting(over))
    assert.ok(!line.includes(t('已关闭')), `不该出现「已关闭」：${JSON.stringify(over)} → ${line.join(' / ')}`)
  }
})

test('这一轮真的结束了、进程也回收了：只说「已关闭」，不再带状态标签', () => {
  const done = closedWaiting({ status: 'done', plan: { done: 14, total: 14 }, background: 0, waiting: undefined })
  assert.deepEqual(texts(done), [t('已关闭')])
})

test('做完了但 CLI 还开着：不写「已关闭」（完成与否看行首图标，不再重复一句话）', () => {
  const open = closedWaiting({
    status: 'done',
    cliAlive: true,
    plan: { done: 14, total: 14 },
    background: 0,
    waiting: undefined,
  })
  assert.deepEqual(texts(open), [])
})

test('停下（进程回收）时说清是谁结束的，不说「已关闭」', () => {
  const stopped = closedWaiting({
    status: 'stopped',
    stopReason: 'user',
    background: 0,
    plan: { done: 13, total: 14 },
    waiting: undefined,
  })
  assert.deepEqual(texts(stopped), [t('已暂停')])
})

test('独立分支还没合回（未完成）时也不显示「已关闭」：这一轮确实没完', () => {
  const line = texts(closedWaiting({ background: 0, waiting: undefined, unmerged: true }))
  assert.ok(!line.includes(t('已关闭')), `不该出现「已关闭」：${line.join(' / ')}`)
  // 进程回收了就不再转圈（childIcon 是 idle）：计划进度、未完成照写，补一句继续会重新拉起
  assert.deepEqual(line, [
    t('计划 {done}/{total}', { done: 13, total: 14 }),
    t('未完成'),
    t('Agent 进程已回收，继续会重新拉起'),
  ])
  assert.equal(childIcon(closedWaiting({ background: 0, waiting: undefined, unmerged: true })), 'idle')
  // CLI 还活着的未完成照旧转圈
  assert.equal(
    childIcon(closedWaiting({ background: 0, waiting: undefined, unmerged: true, cliAlive: true })),
    'running',
  )
})

test('这一轮失败且进程回收：不说「已关闭」，也不说「进程回收了会重新拉起」（失败由行首图标说明）', () => {
  const failed = closedWaiting({ status: 'failed', background: 0, waiting: undefined })
  assert.deepEqual(texts(failed), [])
  assert.equal(childClosedHint(failed), '')
})

test('进程回收的说明挪到悬停里，不占状态标签那一行', () => {
  assert.equal(
    childLabels(closedWaiting()).some((l) => l.text === t('已关闭')),
    false,
  )
  // 标题变灰、行下写「等 1 个后台命令」已经说清了，悬停只补一句进程没了
  assert.equal(childClosedHint(closedWaiting()), t('Agent 进程已回收，继续会重新拉起'))
  // 这一轮已经结束、会话真的关了：悬停不再提「继续会重新拉起」
  assert.equal(
    childClosedHint(
      closedWaiting({ status: 'done', plan: { done: 14, total: 14 }, background: 0, waiting: undefined }),
    ),
    '',
  )
})

test('进程还活着时悬停不说「已回收」', () => {
  assert.equal(childClosedHint(closedWaiting({ cliAlive: true })), '')
})

test('页面宽限回收后的静止行：说清继续会重新拉起，不写成「已关闭」', () => {
  // 服务端把回收掉的任务落成 stopped（stopReason 是 presence）：行首静止、计划还挂在那里
  const reclaimed = closedWaiting({ status: 'stopped', stopReason: 'presence', background: 0, waiting: undefined })
  assert.equal(childClosedHint(reclaimed), t('Agent 进程已回收，继续会重新拉起'))
  const line = texts(reclaimed)
  assert.ok(!line.includes(t('已关闭')), `静止的行不该说「已关闭」：${line.join(' / ')}`)
  assert.ok(line.includes(t('页面切走后结束')), `要说清为什么停下：${line.join(' / ')}`)
})

test('页面宽限回收后计划没做完的静止行：行上直接写「继续会重新拉起」，不只在悬停里', () => {
  const reclaimed = closedWaiting({ status: 'stopped', stopReason: 'presence', background: 0, waiting: undefined })
  const line = texts(reclaimed)
  assert.ok(line.includes(t('Agent 进程已回收，继续会重新拉起')), `行上要能直接看到这句：${line.join(' / ')}`)
  assert.ok(line.includes(t('页面切走后结束')), `停下原因也留着：${line.join(' / ')}`)
  // 计划做完了的行不再补这句：计划做完时 openPlan 是 undefined，行上根本没有 plan
  const finished = closedWaiting({
    status: 'stopped',
    stopReason: 'presence',
    background: 0,
    waiting: undefined,
    plan: undefined,
  })
  assert.ok(!texts(finished).includes(t('Agent 进程已回收，继续会重新拉起')))
})

test('一轮结束、停在等下一句的子对话不写「正在思考…」：只在服务端说还在想（thinking）时写', () => {
  // 实测报告问题 12：行上同时出现「正在思考… · 等下一句」，它其实已经空闲了十几分钟
  const idle = closedWaiting({
    cliAlive: true,
    background: 0,
    waiting: { kind: 'next' },
    // 没在跑时服务端的 activity 只剩计划进度（shared/task.ts 的 childActivity）
    activity: { plan: { title: '合回', done: 3, total: 4 } },
    plan: { done: 3, total: 4, step: '合回' },
  })
  const line = childNote(idle, true)
  assert.ok(!line.includes(t('正在思考…')), line)
  assert.equal(line, ['合回', t('等下一句')].join(' · '))
  const thinking = closedWaiting({ working: true, waiting: undefined, activity: { thinking: true } })
  assert.ok(childNote(thinking, true).startsWith(t('正在思考…')))
})

test('执行中的说明写「计划这一步 · 最后一次工具调用」，不写回复开头那一段（分析稿 U5）', () => {
  const base = closedWaiting({ working: true, cliAlive: true, background: 0, waiting: undefined })
  // 已经开口说话：activity 只剩那句话，最后一次工具调用单独给（lastTool）
  const talking = {
    ...base,
    activity: { text: '我先看了相关代码。真实执行时会…', plan: { title: '改角标', done: 1, total: 4 } },
    plan: { done: 1, total: 4, step: '改角标' },
    lastTool: { kind: 'edit' as const, label: 'web/src/lib/store.ts' },
  }
  assert.equal(childNote(talking, true), ['改角标', `${t('编辑')} store.ts`].join(' · '))
  // 正在调用的工具比上一次的新：用正在调用的
  const running = { ...talking, activity: { tool: { kind: 'run' as const, label: 'npm test' } } }
  assert.equal(childNote(running, true), ['改角标', `${t('运行命令')} npm test`].join(' · '))
  // 没有计划也有工具调用：只写工具调用
  assert.equal(childNote({ ...talking, plan: undefined }, true), `${t('编辑')} store.ts`)
  // 计划和工具调用都没有：回退到原来的样子（那句话）
  assert.equal(childNote({ ...talking, plan: undefined, lastTool: undefined }, true), '我先看了相关代码。真实执行时会…')
})

test('交了 Bug 诊断报告等你确认（ADR 0045）：还在转圈，状态写「报告待确认」，不写「执行中」', () => {
  const row = closedWaiting({
    cliAlive: false,
    background: 0,
    plan: undefined,
    waiting: undefined,
    diagnosis: true,
    status: 'done',
  })
  assert.equal(childIcon(row), 'running')
  const labels = childLabels(row).map((l) => l.text)
  assert.ok(labels.includes('报告待确认'))
  assert.ok(!labels.includes('执行中'))
})

test('等诊断报告确认时又提了问：运行区仍列这一行，标签同时写「等你回答」和「报告待确认」', () => {
  const base = {
    cliAlive: true,
    background: 0,
    plan: undefined,
    waiting: undefined,
    diagnosis: true,
    status: 'done' as const,
  }
  // 用户报的现象：提问（requests / asking）让它变成「等你处理」不转圈，运行区里这一行被输入框上方的提问顶掉了
  const asking = closedWaiting({ ...base, id: 'ask', asking: 1 })
  const confirming = closedWaiting({ ...base, id: 'req', requests: 1 })
  const running = closedWaiting({ ...base, id: 'run', diagnosis: false, working: true })
  assert.equal(childIcon(asking), 'waiting')
  const ids = listedChildren([running, asking, confirming]).map((c) => c.id)
  assert.deepEqual([...ids].sort(), ['ask', 'req', 'run'])
  const labels = childLabels(asking).map((l) => l.text)
  assert.ok(labels.includes('等你回答'))
  assert.ok(labels.includes('报告待确认'))
  // 停下的、已收起的：照旧不列（没人再处理它的提问）
  const stopped = closedWaiting({ ...base, id: 's', asking: 1, status: 'stopped', stopReason: 'user' })
  const gone = closedWaiting({ ...base, id: 'g', asking: 1, gone: true })
  assert.deepEqual(listedChildren([stopped, gone]), [])
})

test('子对话在提问 / 等你操作：父对话运行区也列这一行（不只诊断报告、阶段确认）', () => {
  const base = { cliAlive: true, background: 0, plan: undefined, waiting: undefined, status: 'done' as const }
  // 用户 2026-11-07 报：子对话「等用户操作」时，父对话消息下面的子对话列表里没有它
  const action = closedWaiting({
    ...base,
    id: 'act',
    action: true,
    waiting: { kind: 'action', title: '重启编辑器复现一次' },
  })
  const asking = closedWaiting({ ...base, id: 'ask', asking: 1 })
  const permit = closedWaiting({ ...base, id: 'req', requests: 1 })
  for (const c of [action, asking, permit]) assert.equal(childIcon(c), 'waiting', c.id)
  assert.deepEqual(
    listedChildren([action, asking, permit])
      .map((c) => c.id)
      .sort(),
    ['act', 'ask', 'req'],
  )
  assert.ok(childLabels(action).some((l) => l.text === '等你操作'))
  // 停下的、已收起的、已解决的：不再算在等你
  const stopped = closedWaiting({ ...base, id: 's', action: true, status: 'stopped', stopReason: 'user' })
  const gone = closedWaiting({ ...base, id: 'g', asking: 1, gone: true })
  const resolved = closedWaiting({ ...base, id: 'r', asking: 1, resolved: true })
  assert.deepEqual(listedChildren([stopped, gone, resolved]), [])
})
