import assert from 'node:assert/strict'
import test from 'node:test'
import { Task } from './schema.ts'
import {
  activeInRange,
  clip,
  collectRangeProjects,
  extractPrompt,
  groupReports,
  inRange,
  parseExtract,
  rangeTask,
  renderReport,
  reportCounts,
  reportGrain,
  reportName,
  reportsInWindow,
  skippedProjects,
  SUMMARY_ASKS_MAX,
  SUMMARY_LINE_MAX,
  SUMMARY_TASKS_PER_PROJECT,
  SummaryRecord,
  summaryPeriod,
  tasksContext,
  type SummaryEntry,
} from './summary.ts'

/** 本机时区的时间：用例里写「今天 09:00」比写 UTC 好读 */
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)
const now = local(2026, 10, 23, 18)
const today = (h: number, min = 0) => local(2026, 10, 23, h, min).toISOString()
const yesterday = local(2026, 10, 22, 20).toISOString()

const msg = (role: 'user' | 'agent' | 'system', text: string, at: string, over: object = {}) =>
  ({
    id: `${role}-${at}-${text.slice(0, 4)}`,
    role,
    text,
    at,
    ...over,
  }) as Task['messages'][number]

/** 节点 / 轮次只写用例用到的字段，其余由 Task.parse 补默认值 */
const step = (id: string, title: string, startedAt: string, endedAt = startedAt) =>
  ({ id, nodeId: id, title, status: 'done', startedAt, endedAt }) as Task['steps'][number]
const turn = (startedAt: string) =>
  ({
    id: 't1',
    title: '修报错',
    status: 'done',
    startedAt,
    from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
  }) as Task['turns'][number]

const makeTask = (over: Partial<Task> = {}) =>
  Task.parse({
    id: 'task',
    createdAt: today(8),
    updatedAt: today(8),
    projectId: 'p1',
    title: '修好登录报错',
    mode: 'chat',
    status: 'done',
    ...over,
  })

const dayWin = summaryPeriod('day', '2026-10-23')

test('summaryPeriod：按天是那一天，按周是周一到周日（左闭右开）', () => {
  assert.equal(dayWin.fromDay, '2026-10-23')
  assert.equal(dayWin.toDay, '2026-10-23')
  assert.equal(dayWin.start, local(2026, 10, 23).getTime())
  assert.equal(dayWin.end, local(2026, 10, 24).getTime())
  // 2026-10-23 是周五：那一周是 10-19（周一）到 10-25（周日）
  const w = summaryPeriod('week', '2026-10-23')
  assert.equal(w.fromDay, '2026-10-19')
  assert.equal(w.toDay, '2026-10-25')
  assert.equal(w.end, local(2026, 10, 26).getTime())
  // 坏日期按今天：不报错，也不返回空窗口
  assert.equal(summaryPeriod('day', '2026-02-30', now).fromDay, '2026-10-23')
})

test('inRange：左闭右开，空时间和坏时间都不算', () => {
  assert.equal(inRange(today(0), dayWin), true)
  assert.equal(inRange(local(2026, 10, 24).toISOString(), dayWin), false)
  assert.equal(inRange(yesterday, dayWin), false)
  assert.equal(inRange('', dayWin), false)
  assert.equal(inRange('不是时间', dayWin), false)
})

test('clip：压成一行并按字数截断', () => {
  assert.equal(clip('  a\n\n b  '), 'a b')
  assert.equal(clip('x'.repeat(SUMMARY_LINE_MAX + 10)).length, SUMMARY_LINE_MAX)
  assert.ok(clip('y'.repeat(SUMMARY_LINE_MAX + 10)).endsWith('…'))
})

test('rangeTask：只取窗口里的消息和节点，范围外和面板推的消息都不算', () => {
  const t = makeTask({
    messages: [
      msg('user', '登录时报 500', yesterday),
      msg('agent', '已经定位到是 token 过期没有刷新', yesterday),
      msg('user', '把这个报错修一下', today(9)),
      msg('agent', '修好了：刷新 token 后再重试', today(9, 30)),
      msg('system', '后台命令跑完了', today(9, 40), { panel: 'background' }),
      msg('agent', '结论：补了刷新逻辑', today(10)),
    ],
    steps: [step('s1', '定位', today(9), today(9, 20)), step('s2', '昨天的节点', yesterday)],
    changes: [{ path: 'server/auth.ts', add: 3, del: 1 }],
    turns: [turn(today(9))],
  })
  const d = rangeTask(t, dayWin)
  assert.ok(d)
  assert.deepEqual(d.asks, ['把这个报错修一下'])
  assert.deepEqual(d.outcomes, ['修好了：刷新 token 后再重试', '结论：补了刷新逻辑'])
  assert.deepEqual(d.steps, [{ title: '定位', status: 'done' }])
  assert.equal(d.userBug, true)
  assert.equal(d.at, today(10))
  // 只有昨天的活动：今天不算执行过
  assert.equal(rangeTask(makeTask({ messages: [msg('user', '昨天的事', yesterday)] }), dayWin), null)
})

test('rangeTask：总结卡的原因和修法交给 CLI，验证、改动、要你处理这类不进报告的字段去掉', () => {
  const card = [
    '改好了。',
    '',
    '### 修复｜登录后不再报 500',
    '- **现象**：登录后首页报 500',
    '- **原因**：token 过期后没有刷新，接口拿旧 token 被拒',
    '- **修复**：请求前检查过期时间，过期先刷新再发',
    '- **验证**：单测全过',
    '- **遗留**：无',
    '- **要你处理**：合并到主干',
  ].join('\n')
  const d = rangeTask(
    makeTask({ messages: [msg('agent', card, today(9)), msg('agent', '已推送', today(10))] }),
    dayWin,
  )!
  assert.equal(d.cards.length, 1)
  assert.equal(d.cards[0].kind, '修复')
  assert.equal(d.cards[0].title, '登录后不再报 500')
  assert.deepEqual(
    d.cards[0].fields.map((x) => x.label),
    ['现象', '原因', '修复', '遗留'],
  )
  assert.equal(d.reply, '', '有卡片时不再带正文')
  const ctx = tasksContext([{ projectId: 'p1', projectName: '面板', tasks: [d] }])
  assert.match(ctx, /总结卡「修复｜登录后不再报 500」\n {4}现象：登录后首页报 500\n {4}原因：token 过期后没有刷新/)
  assert.doesNotMatch(ctx, /单测全过|合并到主干/)
  // 没有卡片的老对话：带最后一条回复的一段正文（代码块去掉），原因常写在中间
  const old = rangeTask(
    makeTask({ messages: [msg('agent', '先看日志\n```\nError 500\n```\n原因是 token 过期没刷新', today(9))] }),
    dayWin,
  )!
  assert.deepEqual(old.cards, [])
  assert.equal(old.reply, '先看日志 原因是 token 过期没刷新')
})

test('rangeTask：用户要求很多时留开头一条和最近几条，Bug 线索扫全量', () => {
  const asks = Array.from({ length: 8 }, (_, i) => msg('user', i === 0 ? '点保存报错' : `第 ${i} 条要求`, today(9, i)))
  const d = rangeTask(makeTask({ title: '整理', messages: asks }), dayWin)!
  assert.equal(d.asks.length, SUMMARY_ASKS_MAX)
  assert.equal(d.asks[0], '点保存报错')
  assert.equal(d.userBug, true)
})

test('activeInRange：按时间字段和消息判断', () => {
  assert.equal(activeInRange(makeTask(), dayWin), true)
  const old = makeTask({ createdAt: yesterday, updatedAt: yesterday })
  assert.equal(activeInRange(old, dayWin), false)
  assert.equal(activeInRange({ ...old, messages: [msg('user', 'x', today(9))] }, dayWin), true)
})

test('collectRangeProjects：按加入顺序分项目，最近执行的在前并截断，没活动的项目跳过', () => {
  const many = Array.from({ length: SUMMARY_TASKS_PER_PROJECT + 3 }, (_, i) =>
    makeTask({ id: `t${i}`, projectId: 'p2', messages: [msg('user', `要求 ${i}`, today(8, i))] }),
  )
  const projects = [
    { id: 'p2', name: '后台' },
    { id: 'p1', name: '面板' },
    { id: 'p3', name: '没动过' },
  ]
  const one = makeTask({ messages: [msg('user', '加个按钮', today(9))] })
  const out = collectRangeProjects([one, ...many], projects, dayWin)
  assert.deepEqual(
    out.map((p) => p.projectName),
    ['后台', '面板'],
  )
  assert.equal(out[0].tasks.length, SUMMARY_TASKS_PER_PROJECT)
  assert.equal(out[0].tasks[0].id, `t${SUMMARY_TASKS_PER_PROJECT + 2}`, '最近执行的在最前')
  assert.deepEqual(skippedProjects(projects, out), ['没动过'])
  assert.match(tasksContext(out), /## 项目：后台/)
})

const entry = (over: Partial<SummaryEntry>): SummaryEntry => ({
  id: over.title ?? 'x',
  kind: 'need',
  project: '面板',
  title: '标题',
  content: '',
  cause: '',
  fix: '',
  ...over,
})

const record = (over: Partial<SummaryRecord>) =>
  SummaryRecord.parse({ id: 'r', createdAt: today(9), updatedAt: today(9), day: '2026-10-23', ...over })

test('renderReport：需求和 Bug 分两节、按项目分小节，需求写内容，Bug 写原因和修复', () => {
  const md = renderReport({
    grain: 'day',
    from: '2026-10-23',
    to: '2026-10-23',
    items: [
      entry({ title: '支持按周生成', content: '可以选一周，从日报汇总成周报' }),
      entry({ kind: 'bug', title: '点暂停显示已停止', cause: '子任务进程已退出但状态没更新', fix: '退出时同步状态' }),
      entry({ project: '后台', title: '加接口', content: '新增删除报告的接口' }),
    ],
  })
  assert.equal(
    md,
    [
      '# 2026-10-23 工作总结',
      '',
      '## 一、需求',
      '',
      '### 1.1 面板',
      '1. **支持按周生成**',
      '   内容：可以选一周，从日报汇总成周报',
      '',
      '### 1.2 后台',
      '1. **加接口**',
      '   内容：新增删除报告的接口',
      '',
      '## 二、Bug',
      '',
      '### 2.1 面板',
      '1. **点暂停显示已停止**',
      '   原因：子任务进程已退出但状态没更新',
      '   修复：退出时同步状态',
      '',
    ].join('\n'),
  )
  // 没有 Bug 时那一节写「暂无」，周报标题带周号
  const week = renderReport({ grain: 'week', from: '2026-10-19', to: '2026-10-25', items: [entry({})] })
  assert.match(week, /^# 第 43 周工作总结（2026-10-19 至 2026-10-25）/)
  assert.match(week, /## 二、Bug\n\n暂无\n$/)
})

test('parseExtract：取 JSON 代码块，丢掉认不出的条目，项目名宽松匹配', () => {
  let n = 0
  const id = () => `id${++n}`
  const answer = [
    '好的，下面是分项：',
    '```json',
    JSON.stringify({
      items: [
        { kind: 'need', project: ' 面 板 ', title: '支持按周', content: '可以按周' },
        { kind: 'BUG', project: '后台', title: '报错', cause: '空指针', fix: '判空', content: '不该保留' },
        { kind: 'other', title: '不认识的种类' },
        { kind: 'need', title: '' },
        { kind: 'need', project: '改过名的项目', title: '老项目的事' },
      ],
    }),
    '```',
  ].join('\n')
  const r = parseExtract(answer, ['面板', '后台'], id)
  assert.equal(r.error, undefined)
  assert.deepEqual(
    r.items.map((x) => [x.kind, x.project, x.title]),
    [
      ['need', '面板', '支持按周'],
      ['bug', '后台', '报错'],
      ['need', '改过名的项目', '老项目的事'],
    ],
  )
  assert.equal(r.items[1].content, '', 'Bug 不留「内容」')
  assert.equal(r.items[1].fix, '判空')
  // 没有 JSON、格式不对都返回错误，不当成「没有内容」
  assert.ok(parseExtract('没有 JSON', [], id).error)
  assert.ok(parseExtract('```json\n{坏的\n```', [], id).error)
  assert.ok(parseExtract('{"list":[]}', [], id).error)
  assert.deepEqual(parseExtract('{"items":[]}', [], id), { items: [] })
})

test('extractPrompt：带上角色设定、范围、项目、JSON 约定和材料', () => {
  const p = extractPrompt({
    role: '你是「每日工作总结」',
    win: summaryPeriod('week', '2026-10-23'),
    source: 'reports',
    projects: ['面板'],
    context: '## 报告：2026-10-20',
  })
  assert.match(p, /^你是「每日工作总结」/)
  assert.match(p, /2026-10-19 至 2026-10-25（第 43 周）/)
  assert.match(p, /范围外的内容一律不写/)
  assert.match(p, /已经生成过的工作总结报告/)
  assert.match(p, /"kind":"bug".*"cause".*"fix"/)
  assert.match(p, /## 材料\n## 报告：2026-10-20/)
})

test('reportsInWindow：只取覆盖范围落在窗口内的报告，按周时不收整周的周报', () => {
  const week = summaryPeriod('week', '2026-10-23')
  const list = [
    record({ id: 'd1', from: '2026-10-20', to: '2026-10-20' }),
    record({ id: 'd2', day: '2026-10-23' }),
    record({ id: 'out', from: '2026-10-18', to: '2026-10-18' }),
    record({ id: 'cross', from: '2026-10-17', to: '2026-10-23' }),
    record({ id: 'w', from: '2026-10-19', to: '2026-10-25', grain: 'week' }),
  ]
  assert.deepEqual(
    reportsInWindow(list, week).map((r) => r.id),
    ['d1', 'd2'],
  )
  // 按天：同一天的几份报告都算
  assert.deepEqual(
    reportsInWindow(list, summaryPeriod('day', '2026-10-23')).map((r) => r.id),
    ['d2'],
  )
})

test('groupReports：按天 / 按周分组，日期新的在前，同一天多份按生成时间倒序', () => {
  const list = [
    record({ id: 'a', day: '2026-10-22', createdAt: local(2026, 10, 22, 9).toISOString() }),
    record({ id: 'b', day: '2026-10-23', createdAt: today(9) }),
    record({ id: 'c', day: '2026-10-23', createdAt: today(15) }),
    record({ id: 'w', from: '2026-10-19', to: '2026-10-25', grain: 'week', createdAt: today(20) }),
    // 改版前的「近 7 天」报告没有 grain：按它开始那天所在的那一周归组
    record({ id: 'old', from: '2026-10-08', to: '2026-10-14', createdAt: local(2026, 10, 14).toISOString() }),
  ]
  const g = groupReports(list)
  assert.deepEqual(
    g.map((x) => x.key),
    ['week:2026-10-19', 'day:2026-10-23', 'day:2026-10-22', 'week:2026-10-05'],
  )
  assert.deepEqual(
    g[1].reports.map((r) => r.id),
    ['c', 'b'],
  )
  assert.equal(reportGrain(list[4]), 'week')
})

test('reportCounts / reportName：有分项时数需求和 Bug，汇总报告和老报告的名字', () => {
  const r = record({ items: [entry({}), entry({ kind: 'bug', title: 'b' })], projectNames: ['面板', '后台'] })
  assert.deepEqual(reportCounts(r), { need: 1, bug: 1 })
  assert.equal(reportCounts(record({})), null)
  assert.equal(reportName(r), '面板、后台')
  assert.equal(reportName(record({ md: '# 2026-10-23 工作总结\n' })), '2026-10-23 工作总结')
})
