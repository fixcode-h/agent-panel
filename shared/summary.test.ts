import assert from 'node:assert/strict'
import test from 'node:test'
import { Task } from './schema.ts'
import {
  activeInRange,
  activeOnDay,
  checkSummaryFormat,
  clip,
  collectDayProjects,
  collectRangeProjects,
  dayTask,
  extractSummary,
  inRange,
  isToday,
  rangeLabel,
  rangeTask,
  rangeWindow,
  reportTitle,
  reportWindowLabel,
  skippedProjects,
  SUMMARY_ASKS_MAX,
  SUMMARY_LINE_MAX,
  SUMMARY_STEPS_MAX,
  SUMMARY_TASKS_PER_PROJECT,
  summaryContext,
  summaryPrompt,
  todayWindow,
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

test('todayWindow：本机时区的今天 00:00 到现在', () => {
  const w = todayWindow(now)
  assert.equal(w.day, '2026-10-23')
  assert.equal(new Date(w.start).getHours(), 0)
  assert.equal(new Date(w.start).getDate(), 23)
  assert.equal(w.end, now.getTime())
})

test('isToday：按本机时区判断，空时间和坏时间都不算今天', () => {
  assert.equal(isToday(today(9), '2026-10-23'), true)
  assert.equal(isToday(yesterday, '2026-10-23'), false)
  assert.equal(isToday('', '2026-10-23'), false)
  assert.equal(isToday('不是时间', '2026-10-23'), false)
})

test('clip：压成一行并按字数截断', () => {
  assert.equal(clip('  a\n\n b  '), 'a b')
  assert.equal(clip('x'.repeat(SUMMARY_LINE_MAX + 10)).length, SUMMARY_LINE_MAX)
  assert.ok(clip('y'.repeat(SUMMARY_LINE_MAX + 10)).endsWith('…'))
})

test('dayTask：只取今天的消息和节点，面板推的消息不算工作内容', () => {
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
  const d = dayTask(t, '2026-10-23')
  assert.ok(d)
  assert.deepEqual(d.asks, ['把这个报错修一下'])
  assert.deepEqual(d.outcomes, ['修好了：刷新 token 后再重试', '结论：补了刷新逻辑'])
  assert.deepEqual(d.steps, [{ title: '定位', status: 'done' }])
  assert.deepEqual(d.files, ['server/auth.ts'])
  assert.equal(d.userBug, true, '标题和用户要求里有「报错 / 修」')
  assert.equal(d.at, today(10))
})

test('dayTask：Bug 线索只按用户提的要求判断，Agent 自查修掉的不算', () => {
  // 用户没报问题，Agent 自己发现并修了一个：标题和结论里有「报错 / 修复」，但都不该算用户报的 Bug
  const t = makeTask({
    title: '给列表加个加载骨架',
    messages: [
      msg('user', '给列表加个加载骨架', today(9)),
      msg('agent', '顺手发现一个报错并修复了：空列表时取下标越界', today(9, 30)),
    ],
  })
  assert.equal(dayTask(t, '2026-10-23')?.userBug, false)
  assert.equal(
    summaryContext([{ projectId: 'p1', projectName: '面板', tasks: [dayTask(t, '2026-10-23')!] }]),
    '## 面板\n- 对话「给列表加个加载骨架」（done）\n  关键词命中问题词：否\n  用户的要求：给列表加个加载骨架\n  结论：顺手发现一个报错并修复了：空列表时取下标越界',
  )
})

test('dayTask：关键词没命中但用户明确在报问题，也给 CLI 一个线索以外的判断依据', () => {
  // 「没反应」这类词本来不在旧列表里：现在收进来，但即使没命中，用户要求原文也会交给 CLI
  const t = makeTask({ title: '优化保存按钮样式', messages: [msg('user', '点保存没反应，帮我看看', today(9))] })
  const d = dayTask(t, '2026-10-23')
  assert.ok(d)
  assert.equal(d.userBug, true)
  assert.match(summaryContext([{ projectId: 'p1', projectName: '面板', tasks: [d] }]), /用户的要求：点保存没反应/)
})

test('activeOnDay：按今天的时间字段判断，页面和服务端用同一处口径', () => {
  assert.equal(activeOnDay(makeTask({ updatedAt: today(9) }), '2026-10-23'), true)
  assert.equal(
    activeOnDay(makeTask({ updatedAt: yesterday, messages: [msg('user', 'x', today(9))] }), '2026-10-23'),
    true,
  )
  assert.equal(activeOnDay(makeTask({ updatedAt: yesterday, messages: [] }), '2026-10-23'), false)
})

test('dayTask：普通对话里的「失败」「异常」不当作 Bug 修复，明确的问题才算', () => {
  const add = makeTask({
    title: '接口失败要不要加重试',
    messages: [msg('user', '这个接口失败了要不要加重试', today(9))],
  })
  assert.equal(dayTask(add, '2026-10-23')?.userBug, false)
  const fix = makeTask({ messages: [msg('user', '登录报错了，修一下', today(9))] })
  assert.equal(dayTask(fix, '2026-10-23')?.userBug, true)
})

test('dayTask：节点多时保留最后几个（和结论同一口径）', () => {
  const steps = Array.from({ length: SUMMARY_STEPS_MAX + 2 }, (_, i) => step(`s${i}`, `节点${i}`, today(9, i)))
  const t = makeTask({ messages: [msg('user', '做事', today(9))], steps })
  const d = dayTask(t, '2026-10-23')
  assert.ok(d)
  assert.equal(d.steps.length, SUMMARY_STEPS_MAX)
  assert.equal(d.steps[0].title, '节点2')
  assert.equal(d.steps.at(-1)!.title, `节点${SUMMARY_STEPS_MAX + 1}`)
})

test('dayTask：今天打开但没执行的任务不算', () => {
  const t = makeTask({ messages: [], steps: [] })
  assert.equal(dayTask(t, '2026-10-23'), null)
})

test('dayTask：只有昨天的记录时不算今天的活动', () => {
  const t = makeTask({
    messages: [msg('user', '昨天的要求', yesterday), msg('agent', '昨天的结论', yesterday)],
    steps: [step('s1', '昨天', yesterday)],
  })
  assert.equal(dayTask(t, '2026-10-23'), null)
})

test('collectDayProjects：只保留有活动的项目，项目按传入顺序，任务新的在前', () => {
  const tasks = [
    makeTask({ id: 't1', projectId: 'p1', messages: [msg('user', '早上的事', today(9))] }),
    makeTask({ id: 't2', projectId: 'p1', messages: [msg('user', '下午的事', today(15))] }),
    makeTask({ id: 't3', projectId: 'p2', messages: [msg('user', '昨天的', yesterday)] }),
    makeTask({ id: 't4', projectId: 'p3', messages: [] }),
  ]
  const out = collectDayProjects(
    tasks,
    [
      { id: 'p3', name: '没执行' },
      { id: 'p2', name: '只有昨天' },
      { id: 'p1', name: '有今天' },
    ],
    now,
  )
  assert.deepEqual(
    out.map((p) => p.projectId),
    ['p1'],
  )
  assert.deepEqual(
    out[0].tasks.map((t) => t.id),
    ['t2', 't1'],
    '新的对话在前',
  )
})

test('collectDayProjects：每个项目最多交几条对话给 CLI，留下的是最新的', () => {
  const tasks = Array.from({ length: SUMMARY_TASKS_PER_PROJECT + 3 }, (_, i) =>
    makeTask({ id: `t${i}`, projectId: 'p1', messages: [msg('user', `第 ${i} 条`, today(9, i))] }),
  )
  const out = collectDayProjects(tasks, [{ id: 'p1', name: '项目' }], now)
  assert.equal(out[0].tasks.length, SUMMARY_TASKS_PER_PROJECT)
  // 超过上限时丢掉最早的（t0…t2），留下最新的一批
  assert.deepEqual(
    out[0].tasks.map((t) => t.id),
    Array.from({ length: SUMMARY_TASKS_PER_PROJECT }, (_, i) => `t${SUMMARY_TASKS_PER_PROJECT + 2 - i}`),
  )
})

test('collectDayProjects：传了 taskIds 时只分析选中的对话，空列表才是全部', () => {
  const tasks = [
    makeTask({ id: 't1', projectId: 'p1', messages: [msg('user', '早上的事', today(9))] }),
    makeTask({ id: 't2', projectId: 'p1', messages: [msg('user', '下午的事', today(15))] }),
    makeTask({ id: 't3', projectId: 'p2', messages: [msg('user', '另一个项目', today(11))] }),
  ]
  const only = collectDayProjects(tasks, [{ id: 'p1', name: '面板', taskIds: ['t1'] }], now)
  assert.deepEqual(
    only.map((p) => p.tasks.map((t) => t.id)),
    [['t1']],
  )
  // 选中的对话今天都没执行：这个项目不出现在报告里
  assert.deepEqual(collectDayProjects(tasks, [{ id: 'p1', name: '面板', taskIds: ['没有的 id'] }], now), [])
  // 没选对话的项目仍拿今天全部
  assert.equal(collectDayProjects(tasks, [{ id: 'p1', name: '面板', taskIds: [] }], now)[0].tasks.length, 2)
})

test('skippedProjects：选了但今天没内容的项目要能被页面提示出来', () => {
  const tasks = [makeTask({ id: 't1', projectId: 'p1', messages: [msg('user', '今天的事', today(9))] })]
  const projects = collectDayProjects(tasks, [{ id: 'p1', name: '面板' }], now)
  // p2 今天只改了状态、没有今天的对话和节点：collectDayProjects 不会收它
  assert.deepEqual(
    skippedProjects(
      [
        { id: 'p1', name: '面板' },
        { id: 'p2', name: '只有状态变化' },
      ],
      projects,
    ),
    ['只有状态变化'],
  )
  // 都进了报告时没有要提示的
  assert.deepEqual(skippedProjects([{ id: 'p1', name: '面板' }], projects), [])
})

test('summaryContext：按项目分节，带上要求、结论、节点和改动文件', () => {
  const text = summaryContext([
    {
      projectId: 'p1',
      projectName: '面板',
      tasks: [
        {
          id: 't1',
          title: '修登录报错',
          status: 'done',
          asks: ['修一下登录报错'],
          outcomes: ['补了 token 刷新'],
          steps: [{ title: '定位', status: 'done' }],
          files: ['server/auth.ts'],
          at: today(9),
          userBug: true,
        },
      ],
    },
  ])
  assert.match(text, /## 面板/)
  assert.match(text, /对话「修登录报错」（done）/)
  assert.match(text, /用户的要求：修一下登录报错/)
  assert.match(text, /结论：补了 token 刷新/)
  assert.match(text, /节点：定位（done）/)
  assert.match(text, /改动的文件：server\/auth\.ts/)
})

test('summaryPrompt：按固定模板写三节，写明只收用户报的 Bug', () => {
  const p = summaryPrompt({
    day: '2026-10-23',
    projects: [
      {
        projectId: 'p1',
        projectName: '面板',
        tasks: [
          {
            id: 't1',
            title: '修登录报错',
            status: 'done',
            asks: ['修一下登录报错'],
            outcomes: ['补了 token 刷新'],
            steps: [],
            files: [],
            at: today(9),
            userBug: true,
          },
        ],
      },
    ],
  })
  assert.match(p, /今天（2026-10-23）的工作总结报告/)
  // 模板里的固定结构：一级标题、三个二级标题、三级项目标题、条目形状
  assert.match(p, /# 2026-10-23 工作总结/)
  assert.match(p, /## 一、需求进度/)
  assert.match(p, /## 二、用户报告的 Bug/)
  assert.match(p, /## 三、今日小结/)
  assert.match(p, /### 1\.1 <项目名>/)
  assert.match(p, /1\. \*\*<需求标题>\*\* ｜ 已完成/)
  assert.match(p, /实现：<一两句原理/)
  assert.match(p, /原因：<根因/)
  // 「只写用户报的 Bug」是硬约束，Agent 自查的不算
  assert.match(p, /Agent 自己写代码、自测、评审时发现并修掉的问题一律不写/)
  assert.match(p, /关键词命中问题词：是/)
  // 关键词只是线索：没命中也不能把用户报的问题丢掉
  assert.match(p, /关键词命中问题词：否` 只说明没命中关键词，不是没报问题/)
  assert.match(p, /用户原文描述了异常现象/)
  // 只是在讨论「要不要修」，没报告故障的不算用户报的 Bug
  assert.match(p, /只是在讨论要不要处理某个问题、没有报告故障的不算报 Bug/)
  assert.match(p, /## 面板/)
  assert.match(p, /修一下登录报错/)
  // 今天没有记录时也照样能跑，提示词里写清楚
  assert.match(summaryPrompt({ day: '2026-10-23', projects: [] }), /这段时间没有执行记录/)
})

/** 一份合格式的报告：合格 / 不合格的用例都拿它做基底，只改一处 */
const GOOD_REPORT = [
  '# 2026-10-23 工作总结',
  '',
  '## 一、需求进度',
  '',
  '### 1.1 面板',
  '1. **改造工作总结的格式** ｜ 已完成（3/3）',
  '   实现：把提示词换成固定三节模板，生成后再校一遍结构',
  '2. **选择器改成下拉增加** ｜ 进行中（2/4）',
  '   实现：项目先选再加入，每个项目下再挑对话',
  '',
  '## 二、用户报告的 Bug',
  '',
  '### 2.1 面板',
  '1. **点「全部应用」后按钮没有变化**',
  '   原因：保存时只更新了内存里的值，没有回写接口',
  '   修复：保存后重新拉一遍配置',
  '',
  '## 三、今日小结',
  '今天做完了工作总结的选择器和统一格式，还剩端到端测试没跑。',
  '',
].join('\n')

test('checkSummaryFormat：合格的报告直接通过', () => {
  assert.deepEqual(checkSummaryFormat(GOOD_REPORT), { ok: true, issues: [] })
})

test('checkSummaryFormat：缺节、错标题、错条目、空节不给「暂无」都要报出来', () => {
  const bad = [
    '# 工作总结',
    '',
    '## 一、需求进度',
    '',
    '1. 改了工作总结',
    '',
    '## 二、用户报告的 Bug',
    '',
    '## 三、今日小结',
    '完成了。',
  ].join('\n')
  const { ok, issues } = checkSummaryFormat(bad)
  assert.equal(ok, false)
  assert.ok(issues.includes('title'), '一级标题缺日期')
  assert.ok(issues.includes('item'), '条目没写成 1. **标题**')
  assert.ok(issues.includes('empty'), 'Bug 一节空着没写「暂无」')
  // 三个二级标题齐全且顺序对时不再报 sections
  assert.ok(!issues.includes('sections'))
  // 少了第三节
  assert.ok(checkSummaryFormat(bad.replace('## 三、今日小结\n完成了。', '')).issues.includes('sections'))
  // 自己加了一节
  assert.ok(checkSummaryFormat(GOOD_REPORT + '## 四、其它\n暂无\n').issues.includes('sections'))
  // 项目标题缺编号
  assert.ok(checkSummaryFormat(GOOD_REPORT.replace('### 1.1 面板', '### 面板')).issues.includes('project'))
})

test('extractSummary：去掉包着报告的代码块和 CLI 的说明', () => {
  const fenced = ['看完了今天的记录，结果如下：', '```markdown', '## 面板', '- **做了**：修好登录报错', '```', ''].join(
    '\n',
  )
  assert.equal(extractSummary(fenced), '## 面板\n- **做了**：修好登录报错\n')
  // 没有代码块时就是正文，原样留着一级标题
  assert.equal(extractSummary('# 工作总结\n\n今天没做事'), '# 工作总结\n\n今天没做事\n')
  assert.equal(extractSummary('   '), '')
})

test('extractSummary：没有标题的代码块也取里面的正文', () => {
  assert.equal(extractSummary('```markdown\n- **做了**：修好登录报错\n```\n'), '- **做了**：修好登录报错\n')
})

test('extractSummary：正文后面跟着代码块时保留正文，不把代码块当成报告', () => {
  const text = '## 面板\n- **做了**：修好登录报错\n\n```bash\nnpm run test\n```\n'
  const out = extractSummary(text)
  assert.ok(out.startsWith('## 面板'))
  assert.ok(out.includes('npm run test'), '正文里的代码块原样留着')
})

test('reportTitle：取第一行标题，没有标题时用日期', () => {
  assert.equal(reportTitle('## 面板\n- 做了什么', '2026-10-23'), '面板')
  assert.equal(reportTitle('今天没有执行记录', '2026-10-23'), '今天没有执行记录')
  assert.equal(reportTitle('', '2026-10-23'), '2026-10-23')
})

test('rangeWindow：今天 / 昨天 / 近 7 天都按本机时区的自然日算，今天的行为和改造前一样', () => {
  const now = local(2026, 10, 23, 18)
  const winToday = rangeWindow({ id: 'today', from: '', to: '' }, now)
  assert.equal(winToday.fromDay, '2026-10-23')
  assert.equal(winToday.toDay, '2026-10-23')
  assert.deepEqual(winToday.days, ['2026-10-23'])
  assert.equal(new Date(winToday.start).getHours(), 0)
  assert.equal(winToday.end, now.getTime(), '今天到「现在」为止，和一次完整快照一致')

  const winYesterday = rangeWindow({ id: 'yesterday', from: '', to: '' }, now)
  assert.equal(winYesterday.fromDay, '2026-10-22')
  assert.equal(winYesterday.toDay, '2026-10-22')
  assert.deepEqual(winYesterday.days, ['2026-10-22'])
  // 结束时间是今天 0 点（不含）：23:59 还算昨天，0:00 已经是今天
  assert.equal(new Date(winYesterday.end).getDate(), 23)
  assert.equal(new Date(winYesterday.end).getHours(), 0)
  assert.equal(inRange(local(2026, 10, 22, 23, 59).toISOString(), winYesterday), true)
  assert.equal(inRange(local(2026, 10, 23, 0, 0).toISOString(), winYesterday), false)

  const win7 = rangeWindow({ id: 'last7', from: '', to: '' }, now)
  assert.equal(win7.fromDay, '2026-10-17')
  assert.equal(win7.toDay, '2026-10-23')
  assert.equal(win7.days.length, 7)
  assert.equal(win7.days[0], '2026-10-17')
  assert.equal(win7.days.at(-1), '2026-10-23')
})

test('rangeWindow：自选日期跨月，起止写反时按用户想要的那几天算', () => {
  const now = local(2026, 10, 23, 18)
  const custom = rangeWindow({ id: 'custom', from: '2026-09-28', to: '2026-10-02' }, now)
  assert.equal(custom.fromDay, '2026-09-28')
  assert.equal(custom.toDay, '2026-10-02')
  // 自选范围可能跨很多年，不逐天生成 days（只有 last7 用它数天数）
  assert.deepEqual(custom.days, [])
  // 结束那天 23:59 还在范围里，次日 0 点不在
  assert.equal(inRange(local(2026, 10, 2, 23, 59).toISOString(), custom), true)
  assert.equal(inRange(local(2026, 10, 3, 0, 0).toISOString(), custom), false)

  const swapped = rangeWindow({ id: 'custom', from: '2026-10-05', to: '2026-10-01' }, now)
  assert.equal(swapped.fromDay, '2026-10-01')
  assert.equal(swapped.toDay, '2026-10-05')

  // 格式不对 / 日期不存在时回落到今天，不返回空范围
  assert.equal(rangeWindow({ id: 'custom', from: '不是日期', to: '' }, now).fromDay, '2026-10-23')
  assert.equal(rangeWindow({ id: 'custom', from: '2026-02-30', to: '' }, now).fromDay, '2026-10-23')
})

test('activeInRange：按范围筛任务，页面和服务端同一个判定', () => {
  const now = local(2026, 10, 23, 18)
  const task = makeTask({ updatedAt: yesterday, messages: [] })
  assert.equal(activeInRange(task, rangeWindow({ id: 'today', from: '', to: '' }, now)), false)
  assert.equal(activeInRange(task, rangeWindow({ id: 'yesterday', from: '', to: '' }, now)), true)
  assert.equal(activeInRange(task, rangeWindow({ id: 'last7', from: '', to: '' }, now)), true)
  // 范围外的消息不算
  const only = makeTask({ updatedAt: yesterday, messages: [msg('user', 'x', today(9))] })
  assert.equal(activeInRange(only, rangeWindow({ id: 'yesterday', from: '', to: '' }, now)), true, 'updatedAt 在昨天')
})

test('rangeTask：只取范围内的消息和节点，跨天时用户要求留最近几条', () => {
  const now = local(2026, 10, 23, 18)
  const win7 = rangeWindow({ id: 'last7', from: '', to: '' }, now)
  const many = Array.from({ length: SUMMARY_ASKS_MAX + 2 }, (_, i) => msg('user', `第${i}条`, today(9, i)))
  const d = rangeTask(makeTask({ messages: many }), win7)
  assert.ok(d)
  assert.equal(d.asks.length, SUMMARY_ASKS_MAX)
  assert.deepEqual(d.asks, ['第0条', '第3条', '第4条', '第5条'], '开头一条（常是报的问题）+ 最近三条')
  // 范围内没有活动时返回 null
  assert.equal(rangeTask(makeTask({ messages: [], steps: [] }), win7), null)
})

test('collectRangeProjects：昨天 / 近 7 天按各自范围收对话', () => {
  const now = local(2026, 10, 23, 18)
  const tasks = [
    makeTask({ id: 't1', projectId: 'p1', messages: [msg('user', '昨天的事', yesterday)] }),
    makeTask({ id: 't2', projectId: 'p1', messages: [msg('user', '今天的事', today(9))] }),
  ]
  const picks = [{ id: 'p1', name: '面板' }]
  assert.deepEqual(
    collectRangeProjects(tasks, picks, { id: 'yesterday', from: '', to: '' }, now)[0].tasks.map((t) => t.id),
    ['t1'],
  )
  assert.deepEqual(
    collectRangeProjects(tasks, picks, { id: 'last7', from: '', to: '' }, now)[0].tasks.map((t) => t.id),
    ['t2', 't1'],
  )
  assert.deepEqual(
    collectRangeProjects(tasks, picks, { id: 'today', from: '', to: '' }, now)[0].tasks.map((t) => t.id),
    ['t2'],
  )
})

test('summaryPrompt：范围写进第一行和一级标题，三节结构不变', () => {
  const now = local(2026, 10, 23, 18)
  const win7 = rangeWindow({ id: 'last7', from: '', to: '' }, now)
  const p = summaryPrompt({ day: win7.toDay, projects: [], range: win7 })
  assert.match(p, /近 7 天（2026-10-17 至 2026-10-23）/)
  assert.match(p, /# 2026-10-17 - 2026-10-23 工作总结/)
  assert.match(p, /## 一、需求进度/)
  assert.match(p, /## 二、用户报告的 Bug/)
  assert.match(p, /## 三、今日小结/)

  // 昨天：标题是那一天的日期，仍然是单日格式
  const winYesterday = rangeWindow({ id: 'yesterday', from: '', to: '' }, now)
  const y = summaryPrompt({ day: winYesterday.toDay, projects: [], range: winYesterday })
  assert.match(y, /昨天（2026-10-22）/)
  assert.match(y, /# 2026-10-22 工作总结/)
})

test('checkSummaryFormat：多天的区间标题也算合格', () => {
  const report = GOOD_REPORT.replace('# 2026-10-23 工作总结', '# 2026-10-17 - 2026-10-23 工作总结')
  assert.deepEqual(checkSummaryFormat(report), { ok: true, issues: [] })
})

test('rangeLabel / reportWindowLabel：范围在界面上的名字，老报告只有单日也能显示', () => {
  const now = local(2026, 10, 23, 18)
  assert.equal(rangeLabel(rangeWindow({ id: 'today', from: '', to: '' }, now)), '今天')
  assert.equal(rangeLabel(rangeWindow({ id: 'last7', from: '', to: '' }, now)), '近 7 天')
  assert.equal(
    rangeLabel(rangeWindow({ id: 'custom', from: '2026-10-01', to: '2026-10-05' }, now)),
    '2026-10-01 至 2026-10-05',
  )
  assert.equal(reportWindowLabel('2026-10-23', '2026-10-23', now), '今天的报告')
  assert.equal(reportWindowLabel('2026-10-22', '2026-10-22', now), '昨天的报告')
  assert.equal(reportWindowLabel('2026-10-17', '2026-10-23', now), '近 7 天的报告')
  assert.equal(reportWindowLabel('2026-10-01', '2026-10-02', now), '2026-10-01 至 2026-10-02 的报告')
  // 老报告只有 day：页面会传 (day, day)，按单日显示；完全没日期时给一个中性标题
  assert.equal(reportWindowLabel('2026-10-20', '2026-10-20', now), '2026-10-20 的报告')
  assert.equal(reportWindowLabel('', '', now), '报告')
})

test('rangeTask：开头报的 Bug 不会被条数上限挤掉', () => {
  const now = local(2026, 10, 23, 18)
  const win7 = rangeWindow({ id: 'last7', from: '', to: '' }, now)
  const messages = [
    msg('user', '登录报错，点了没反应', today(9, 0)),
    ...Array.from({ length: SUMMARY_ASKS_MAX }, (_, i) => msg('user', `再改个样式 ${i}`, today(9, i + 1))),
  ]
  const d = rangeTask(makeTask({ title: '改造登录', messages }), win7)
  assert.ok(d)
  // asks 只留 4 条，但 Bug 判定扫窗口里的全部用户消息：开头那条「报错」不能被截掉
  assert.equal(d.asks.length, SUMMARY_ASKS_MAX)
  assert.equal(d.asks[0], '登录报错，点了没反应')
  assert.equal(d.userBug, true)
  // 提示词里也带着开头那条，CLI 能把它写进「二、用户报告的 Bug」
  assert.match(
    summaryContext([{ projectId: 'p1', projectName: '面板', tasks: [d] }]),
    /用户的要求：登录报错，点了没反应/,
  )
})
