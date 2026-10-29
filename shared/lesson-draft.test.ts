import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LessonDraftInput,
  lessonDraftProblems,
  lessonDraftsFromReport,
  MAX_DRAFTS_PER_REPORT,
  missingDrafts,
} from '../shared/lesson-draft.ts'
import { renderReport } from '../shared/summary.ts'

const report = (md: string, over: Partial<{ id: string; day: string; projectNames: string[] }> = {}) => ({
  id: 'r1',
  day: '2026-10-23',
  projectNames: ['Agent 面板'],
  md,
  ...over,
})

const BUG_MD = [
  '# 2026-10-23 工作总结',
  '',
  '## 一、概览',
  '这一天都在做分享包。',
  '',
  '## 二、需求进度',
  '',
  '### 2.1 Agent 面板',
  '1. **角色分享包导入** ｜ 已完成',
  '   实现：新增分享包格式与指纹校验',
  '',
  '## 三、问题与修复',
  '',
  '### 3.1 Agent 面板',
  '1. **导入后角色名重复** ｜ 已修复',
  '   修复：导入时按名字复用，重名加「（副本）」',
  '2. **弹窗先出现在左上角** ｜ 已修复',
  '   修复：打开时按最终位置渲染',
  '',
  '## 四、下一步',
  '',
  '### 4.1 Agent 面板',
  '1. **补分享包导入的回归测试**',
  '   说明：覆盖重名和指纹不一致两种情况',
].join('\n')

/** 老报告的三节写法：升级后仍要能提炼出同样的草稿 */
const LEGACY_BUG_MD = [
  '# 2026-10-23 工作总结',
  '',
  '## 一、需求进度',
  '',
  '### 1.1 Agent 面板',
  '1. **角色分享包导入** ｜ 已完成',
  '   实现：新增分享包格式与指纹校验',
  '',
  '## 二、用户报告的 Bug',
  '',
  '1. **导入后角色名重复** ｜ 已修复',
  '   修复：导入时按名字复用，重名加「（副本）」',
  '',
  '## 三、今日小结',
  '这一天都在做分享包。',
].join('\n')

test('教训草稿：问题与修复里每条都提炼，正文里「修复：」写成规则', () => {
  const drafts = lessonDraftsFromReport(report(BUG_MD))
  assert.equal(drafts.length, 2)
  assert.deepEqual(
    drafts.map((d) => d.title),
    ['导入后角色名重复', '弹窗先出现在左上角'],
  )
  assert.equal(drafts[0].rule, '导入时按名字复用，重名加「（副本）」')
  assert.match(drafts[0].cause, /2026-10-23 的工作总结/)
  assert.equal(drafts[0].reportId, 'r1')
  assert.deepEqual(drafts[0].projectNames, ['Agent 面板'])
  // 老报告的三节写法也认：升级后老报告不用重新提炼，「用户报告的 Bug」里的条目照样出草稿
  const legacy = lessonDraftsFromReport(report(LEGACY_BUG_MD))
  assert.deepEqual(
    legacy.map((d) => d.title),
    ['导入后角色名重复'],
  )
  assert.equal(legacy[0].rule, '导入时按名字复用，重名加「（副本）」')
})

test('教训草稿：只写了标题、没有「怎么修的」不生成（没痕迹就不是教训）', () => {
  const md = ['## 二、用户报告的 Bug', '1. **机器有点慢** ｜ 待确认', '', '## 三、今日小结', '暂无'].join('\n')
  assert.deepEqual(lessonDraftsFromReport(report(md)), [])
})

test('教训草稿：需求进度里写了返工的也算，没写的不算', () => {
  const md = [
    '## 一、需求进度',
    '1. **改了分享包** ｜ 已完成',
    '   实现：加了指纹',
    '2. **评审门禁** ｜ 已完成',
    '   实现：按评审意见改了一版，被纠正后又改回原来的做法',
    '',
    '## 二、用户报告的 Bug',
    '暂无',
  ].join('\n')
  const drafts = lessonDraftsFromReport(report(md))
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].title, '评审门禁')
  assert.match(drafts[0].cause, /返工/)
})

test('教训草稿：同一标题只留一条，最多提炼几条', () => {
  const rows = Array.from({ length: 9 }, (_, i) => `${i + 1}. **重复的问题** ｜ 已修复\n   修复：第 ${i + 1} 次修`)
  const md = ['## 二、用户报告的 Bug', ...rows, '', '## 三、今日小结', '暂无'].join('\n')
  const drafts = lessonDraftsFromReport(report(md))
  assert.equal(drafts.length, 1, '同名只留一条')

  const many = Array.from({ length: 9 }, (_, i) => `${i + 1}. **问题 ${i + 1}** ｜ 已修复\n   修复：处理 ${i + 1}`)
  const md2 = ['## 二、用户报告的 Bug', ...many, '', '## 三、今日小结', '暂无'].join('\n')
  assert.equal(lessonDraftsFromReport(report(md2)).length, MAX_DRAFTS_PER_REPORT)
})

test('教训草稿：报告里没有返工痕迹时一条都不生成', () => {
  const md = [
    '# 2026-10-23 工作总结',
    '## 一、需求进度',
    '暂无',
    '## 二、用户报告的 Bug',
    '暂无',
    '## 三、今日小结',
    '暂无',
  ].join('\n')
  assert.deepEqual(lessonDraftsFromReport(report(md)), [])
})

test('教训草稿：提炼依据保留原文，供用户判断要不要留', () => {
  const drafts = lessonDraftsFromReport(report(BUG_MD))
  assert.match(drafts[0].source, /导入后角色名重复/)
  assert.match(drafts[0].source, /按名字复用/)
})

test('教训草稿：落盘前校验格式（规则必填、不超过 6 行、起因必填）', () => {
  const base = LessonDraftInput.parse({ title: '标题', rule: '规则', cause: '起因' })
  assert.deepEqual(lessonDraftProblems(base), [])
  assert.match(lessonDraftProblems({ ...base, rule: '' }).join(), /规则还没写/)
  assert.match(lessonDraftProblems({ ...base, rule: Array(7).fill('一行').join('\n') }).join(), /最多 6 行/)
  assert.match(lessonDraftProblems({ ...base, cause: '  ' }).join(), /起因还没写/)
})

test('教训草稿：多项目报告的项目标题不会被拼进上一条的规则', () => {
  const md = [
    '## 二、用户报告的 Bug',
    '### 2.1 商城前台',
    '1. **按钮没反应** ｜ 已修复',
    '   修复：保存后重新拉一遍配置',
    '### 2.2 后台管理',
    '1. **列表不刷新** ｜ 已修复',
    '   修复：提交后重新请求列表',
    '',
    '## 三、今日小结',
    '暂无',
  ].join('\n')
  const drafts = lessonDraftsFromReport(report(md))
  assert.deepEqual(
    drafts.map((d) => d.title),
    ['按钮没反应', '列表不刷新'],
    '两个项目的条目都要提炼',
  )
  assert.equal(drafts[0].rule, '保存后重新拉一遍配置', '项目标题不能拼进上一条的规则')
  assert.equal(drafts[1].rule, '提交后重新请求列表')
})

test('教训草稿：再次提炼只补草稿区还没有的条目（丢掉一条能找回来，改过的不覆盖）', () => {
  const found = [
    { title: '甲', rule: '规则甲', source: '甲 ｜ 已修复 修复：规则甲' },
    { title: '乙', rule: '规则乙', source: '乙 ｜ 已修复 修复：规则乙' },
  ].map((x) => LessonDraftInput.parse({ ...x, cause: '起因' }))
  // 草稿区里甲还在（用户改了规则正文，没动标题和提炼依据），乙被丢掉了
  const existing = [
    LessonDraftInput.parse({
      title: '甲',
      rule: '用户改过的规则',
      cause: '起因',
      source: '甲 ｜ 已修复 修复：规则甲',
    }),
  ]
  const missing = missingDrafts(found, existing)
  assert.deepEqual(
    missing.map((d) => d.title),
    ['乙'],
    '只补丢掉的那条，已有的不重新生成',
  )
  assert.deepEqual(missingDrafts(found, found), [], '都在时一条都不补')
})

test('教训草稿：用户把标题改成「该怎么做」后再提炼，不会重复生成同一条', () => {
  const found = [
    LessonDraftInput.parse({
      title: '按钮没反应',
      rule: '保存后重新拉一遍配置',
      cause: '2026-10-23 的工作总结（用户报告的 Bug）：按钮没反应',
      source: '按钮没反应 ｜ 已修复 修复：保存后重新拉一遍配置',
    }),
  ]
  // 按指引把标题改成「该怎么做」并保存；提炼依据界面上不提供编辑，保持不变
  const existing = [{ ...found[0], title: '保存后按最终位置重新渲染' }]
  assert.deepEqual(missingDrafts(found, existing), [], '已经提炼过的那条不能再生成一份')
})

test('lessonDraftsFromReport：改版后的两节报告（需求 / Bug）也能提炼', () => {
  const md = renderReport({
    grain: 'day',
    from: '2026-10-29',
    to: '2026-10-29',
    items: [
      { id: 'n', kind: 'need', project: '面板', title: '支持按周生成', content: '可以按周汇总', cause: '', fix: '' },
      {
        id: 'b',
        kind: 'bug',
        project: '面板',
        title: '子任务点暂停显示已停止',
        content: '',
        cause: '进程退出后状态没同步',
        fix: '退出时同步状态',
      },
    ],
  })
  const drafts = lessonDraftsFromReport({ id: 'r', day: '2026-10-29', md })
  assert.deepEqual(
    drafts.map((d) => d.title),
    ['子任务点暂停显示已停止'],
  )
  assert.equal(drafts[0].rule, '进程退出后状态没同步\n退出时同步状态')
})
