import assert from 'node:assert/strict'
import test from 'node:test'
import { Task } from './schema.ts'
import {
  clip,
  collectDayProjects,
  dayTask,
  extractSummary,
  isToday,
  reportTitle,
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
  assert.equal(d.bug, true, '标题和消息里有「报错 / 修」')
  assert.equal(d.at, today(10))
})

test('dayTask：普通对话里的「失败」「异常」不当作 Bug 修复，明确的问题才算', () => {
  const add = makeTask({
    title: '接口失败要不要加重试',
    messages: [msg('user', '这个接口失败了要不要加重试', today(9))],
  })
  assert.equal(dayTask(add, '2026-10-23')?.bug, false)
  const fix = makeTask({ messages: [msg('user', '登录报错了，修一下', today(9))] })
  assert.equal(dayTask(fix, '2026-10-23')?.bug, true)
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
          bug: true,
        },
      ],
    },
  ])
  assert.match(text, /## 面板/)
  assert.match(text, /对话「修登录报错」（done，可能是 Bug 修复）/)
  assert.match(text, /用户的要求：修一下登录报错/)
  assert.match(text, /结论：补了 token 刷新/)
  assert.match(text, /节点：定位（done）/)
  assert.match(text, /改动的文件：server\/auth\.ts/)
})

test('summaryPrompt：写明今天、语言规则、简短分项的要求和今天的记录', () => {
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
            bug: true,
          },
        ],
      },
    ],
  })
  assert.match(p, /今天是 2026-10-23/)
  assert.match(p, /短分条|每条一句话/)
  assert.match(p, /问题在哪/)
  assert.match(p, /## 面板/)
  assert.match(p, /修一下登录报错/)
  // 今天没有记录时也照样能跑，提示词里写清楚
  assert.match(summaryPrompt({ day: '2026-10-23', projects: [] }), /今天没有执行记录/)
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
