/**
 * 工作总结页的状态存档：切页面 / 刷新后要能恢复已选项目、对话、当前报告（含未保存的编辑）。
 * 这里测的是纯逻辑——存进去的脏数据怎么读回来、跨天怎么处理、项目和对话被删了怎么剪掉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  forDay,
  loadSummaryPage,
  parseSummaryPage,
  prunePicks,
  saveSummaryPage,
  SUMMARY_PAGE_KEY,
  type SummaryPageState,
} from './summary-page.ts'

const sample = (): SummaryPageState => ({
  day: '2026-10-23',
  picks: [
    { projectId: 'p1', taskIds: ['t1', 't2'] },
    { projectId: 'p2', taskIds: [] },
  ],
  report: { id: 'r1', md: '# 2026-10-23 工作总结\n' },
  mode: 'edit',
  jobId: 'j1',
  cli: 'claude',
})

test('存档键只有一个，读写的都是整份页面状态', () => {
  assert.equal(SUMMARY_PAGE_KEY, 'summary-page:v1')
  saveSummaryPage(sample())
  assert.deepEqual(loadSummaryPage(), sample())
  // 没有存档时是 null，页面按空状态打开
  saveSummaryPage(null)
  assert.equal(loadSummaryPage(), null)
})

test('读回存档：坏 JSON 和缺失字段都按默认值处理，不崩', () => {
  assert.equal(parseSummaryPage(null), null)
  assert.equal(parseSummaryPage('不是 JSON'), null)

  const empty = parseSummaryPage('{}')
  assert.deepEqual(empty, { day: '', picks: [], report: null, mode: 'preview', jobId: '', cli: '' })

  // 类型不对的字段逐个剔除，不影响其余能用的部分
  const mixed = parseSummaryPage(
    JSON.stringify({
      day: 42,
      picks: [
        { projectId: 'p1', taskIds: ['t1', 7, '', 't2'] },
        { projectId: '', taskIds: ['t3'] },
        { projectId: 'p1', taskIds: ['t9'] },
        { projectId: 'p2' },
        'p3',
      ],
      report: { id: '', md: 'x' },
      mode: 'edit',
      jobId: 'j1',
      cli: 'codex',
    }),
  )
  assert.deepEqual(mixed, {
    day: '',
    // 空的项目 id 丢掉；taskIds 里不是字符串的和空串丢掉；同一个项目只留第一次（重复的 key 会让列表渲染出两条）
    picks: [
      { projectId: 'p1', taskIds: ['t1', 't2'] },
      { projectId: 'p2', taskIds: [] },
    ],
    // 报告 id 为空就没法保存，当作没打开报告
    report: null,
    mode: 'edit',
    jobId: 'j1',
    cli: 'codex',
  })

  // 报告的正文可以没有（旧版本存档）：按空串；这种存档没有正文可恢复，编辑框是空的
  assert.deepEqual(parseSummaryPage(JSON.stringify({ report: { id: 'r1' } }))?.report, { id: 'r1', md: '' })
  // 只认 edit，别的值都回到预览
  assert.equal(parseSummaryPage(JSON.stringify({ mode: '其他' }))?.mode, 'preview')
})

test('写不进 localStorage 时靠内存存档：切页面回来还在', () => {
  // 配额满 / 无痕模式：setItem 抛错但 getItem 正常返回 null，不能因此丢掉内存里那份
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    },
  })
  try {
    saveSummaryPage(sample())
    assert.deepEqual(loadSummaryPage(), sample())
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
    // 内存存档不留给后面的用例
    saveSummaryPage(null)
  }
})

test('同一天原样恢复；跨天只留项目选择，上一天的报告和生成不再算「今天」', () => {
  const s = sample()
  assert.equal(forDay(s, '2026-10-23'), s)

  assert.deepEqual(forDay(s, '2026-10-24'), {
    day: '2026-10-24',
    // 项目顺序保留、对话清空：昨天的对话今天多半没有执行记录，留着也是脏 id
    picks: [
      { projectId: 'p1', taskIds: [] },
      { projectId: 'p2', taskIds: [] },
    ],
    // 上一天的报告不再是「今天的报告」（「最近的报告」里还能点开），job 也不会跨天还在跑
    report: null,
    mode: 'edit',
    jobId: '',
    cli: 'claude',
  })
})

test('剪掉已经不存在的项目和对话，保留其余的原有顺序', () => {
  const picks = [
    { projectId: 'p1', taskIds: ['t1', 'gone', 't2'] },
    { projectId: 'deleted', taskIds: ['t3'] },
    { projectId: 'p2', taskIds: ['t4'] },
  ]
  const projects = [{ id: 'p1' }, { id: 'p2' }]
  const tasks = [
    { id: 't1', projectId: 'p1' },
    { id: 't2', projectId: 'p1' },
    // 换到别的项目了：在这个项目的选择里算不在了
    { id: 't4', projectId: 'p3' },
  ]
  assert.deepEqual(prunePicks(picks, projects, tasks), {
    picks: [
      { projectId: 'p1', taskIds: ['t1', 't2'] },
      { projectId: 'p2', taskIds: [] },
    ],
    removedProjects: 1,
    removedTasks: 2,
  })

  // 没有要剪的时候原样返回，页面不用多写一次
  const clean = [{ projectId: 'p1', taskIds: ['t1'] }]
  assert.deepEqual(prunePicks(clean, projects, tasks), { picks: clean, removedProjects: 0, removedTasks: 0 })
})
