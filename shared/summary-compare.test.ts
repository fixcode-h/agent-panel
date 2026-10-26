import assert from 'node:assert/strict'
import test from 'node:test'
import { compareHasChanges, compareSummaryReports, parseSummaryReport } from './summary.ts'

/** 按生成报告的模板拼一份报告：只需要三节和条目 */
function report(opts: { needs: string[]; bugs: string[]; wrap: string }) {
  return [
    '# 2026-10-23 工作总结',
    '',
    '## 一、需求进度',
    '',
    ...opts.needs,
    '',
    '## 二、用户报告的 Bug',
    '',
    ...opts.bugs,
    '',
    '## 三、今日小结',
    opts.wrap,
    '',
  ].join('\n')
}

const before = report({
  needs: [
    '### 1.1 商城前台',
    '1. **购物车数量不同步** ｜ 已完成（4/4）',
    '   实现：以服务端返回为准',
    '2. **商品列表缺加载骨架** ｜ 进行中（2/3）',
    '   实现：先渲染等高占位块',
    '3. **价格显示格式不统一** ｜ 已完成（2/2）',
    '   实现：收成一个格式化函数',
    '',
    '### 1.2 设置页',
    '1. **弹窗打开时闪一下** ｜ 已完成（2/2）',
    '   实现：挂载完成后再定位',
  ],
  bugs: [
    '### 2.1 商城前台',
    '1. **点「全部应用」后按钮没有变化**',
    '   原因：保存只改了内存',
    '   修复：保存后重新拉一遍配置',
    '2. **设置弹窗打开时先闪在左上角**',
    '   原因：挂载时还没有锚点',
    '   修复：等挂载完再定位',
  ],
  wrap: '今天完成了商城前台的主要需求，剩下的按计划推进。',
})

const after = report({
  needs: [
    '### 1.1 商城前台',
    '1. **购物车数量不同步** ｜ 已完成（4/4）',
    '   实现：以服务端返回为准',
    '2. **商品列表缺加载骨架** ｜ 已完成（3/3）',
    '   实现：先渲染等高占位块',
    '3. **搜索框不支持拼音** ｜ 进行中（1/4）',
    '   实现：先接一个拼音转换',
    '',
    '### 1.2 设置页',
    '1. **弹窗打开时闪一下** ｜ 已完成（2/2）',
    '   实现：挂载完成后再定位',
  ],
  bugs: [
    '### 2.1 商城前台',
    '1. **点「全部应用」后按钮没有变化**',
    '   原因：保存只改了内存',
    '   修复：保存后重新拉一遍配置',
    '2. **结算页金额算错了优惠**',
    '   原因：优惠券和满减重复抵扣',
    '   修复：先算满减再减优惠券',
  ],
  wrap: '今天完成了商品列表骨架，新开的搜索拼音需求还在做。',
})

test('parseSummaryReport：按三节拆出项目、条目、状态和缩进说明', () => {
  const p = parseSummaryReport(before)
  assert.equal(p.ok, true)
  assert.equal(p.title, '2026-10-23 工作总结')
  assert.deepEqual(
    p.needs.map((s) => [s.no, s.name, s.items.length]),
    [
      ['1.1', '商城前台', 3],
      ['1.2', '设置页', 1],
    ],
  )
  const first = p.needs[0].items[0]
  assert.equal(first.no, 1)
  assert.equal(first.title, '购物车数量不同步')
  assert.equal(first.status, '已完成（4/4）')
  assert.equal(first.detail, '实现：以服务端返回为准')
  // Bug 节没有状态，缩进的「原因 / 修复」都收进说明里
  assert.equal(p.bugs[0].items[0].status, '')
  assert.equal(p.bugs[0].items[0].detail, '原因：保存只改了内存\n修复：保存后重新拉一遍配置')
  assert.equal(p.wrapUp, '今天完成了商城前台的主要需求，剩下的按计划推进。')
})

test('parseSummaryReport：缺节、格式乱时 ok 为 false，不抛错', () => {
  assert.equal(parseSummaryReport('# 随便写写\n\n## 一、需求进度\n1. **条目** ｜ 已完成\n').ok, false)
  assert.equal(parseSummaryReport('').ok, false)
  // 条目写在项目标题之前：没法归类，不收（也不凭空造一个项目）；有条目行没解析出来就算格式失败
  const stray = parseSummaryReport(
    '# x 工作总结\n\n## 一、需求进度\n\n1. **没有项目** ｜ 已完成\n\n## 二、用户报告的 Bug\n\n暂无\n\n## 三、今日小结\n暂无\n',
  )
  assert.equal(stray.ok, false)
  assert.deepEqual(stray.needs, [])
})

test('parseSummaryReport：手改报告用半角竖线、状态留空也能解析', () => {
  const md = [
    '# 2026-10-23 工作总结',
    '',
    '## 一、需求进度',
    '',
    '### 1.1 商城前台',
    '1. **购物车数量不同步** | 已完成（4/4）',
    '2. **搜索框不支持拼音** ｜',
    '',
    '## 二、用户报告的 Bug',
    '',
    '### 2.1 商城前台',
    '1. **点「全部应用」后按钮没有变化**',
    '',
    '## 三、今日小结',
    '暂无',
    '',
  ].join('\n')
  const p = parseSummaryReport(md)
  assert.equal(p.ok, true)
  assert.equal(p.needs[0].items[0].status, '已完成（4/4）')
  assert.equal(p.needs[0].items[1].status, '')
})

test('parseSummaryReport：条目写法偏离模板时整份判失败，对比退回逐行 diff', () => {
  const broken = [
    '# 2026-10-23 工作总结',
    '',
    '## 一、需求进度',
    '',
    '### 1.1 商城前台',
    '1. 购物车数量不同步 ｜ 已完成（4/4）',
    '',
    '## 二、用户报告的 Bug',
    '',
    '暂无',
    '',
    '## 三、今日小结',
    '暂无',
    '',
  ].join('\n')
  assert.equal(parseSummaryReport(broken).ok, false)
  // 两边都解析不了时不能把这条当成「消失」：退回逐行对比
  const c = compareSummaryReports(before, broken)
  assert.equal(c.parsed, false)
  assert.deepEqual(c.needs, [])
  assert.ok(c.lines.some((l) => l.kind === 'del' && l.text.includes('购物车数量不同步')))
})

test('compareSummaryReports：需求进度给出新增 / 消失 / 状态变化三类', () => {
  const c = compareSummaryReports(before, after)
  assert.equal(c.parsed, true)
  assert.equal(c.same, false)
  const kinds = (list: typeof c.needs) => list.map((x) => `${x.kind}:${x.project}/${x.title}`)
  assert.deepEqual(kinds(c.needs).sort(), [
    'added:商城前台/搜索框不支持拼音',
    'changed:商城前台/商品列表缺加载骨架',
    'removed:商城前台/价格显示格式不统一',
  ])
  const changed = c.needs.find((x) => x.kind === 'changed')
  assert.equal(changed?.from, '进行中（2/3）')
  assert.equal(changed?.to, '已完成（3/3）')
  assert.ok(compareHasChanges(c))
})

test('compareSummaryReports：Bug 节给出新增和已修复（消失），小结并排', () => {
  const c = compareSummaryReports(before, after)
  const dropped = c.bugs.find((x) => x.kind === 'removed')
  assert.equal(dropped?.title, '设置弹窗打开时先闪在左上角')
  assert.equal(dropped?.detail, '原因：挂载时还没有锚点\n修复：等挂载完再定位')
  const added = c.bugs.find((x) => x.kind === 'added')
  assert.equal(added?.title, '结算页金额算错了优惠')
  // Bug 没有状态：标题相同就是没变化，不会给出空的状态变化
  assert.equal(c.bugs.filter((x) => x.kind === 'changed').length, 0)
  assert.equal(c.wrapUp.changed, true)
  assert.ok(c.wrapUp.before.startsWith('今天完成了商城前台'))
  assert.ok(c.wrapUp.after.startsWith('今天完成了商品列表骨架'))
})

test('compareSummaryReports：同一份对比自己没有差异', () => {
  const c = compareSummaryReports(before, before)
  assert.equal(c.same, true)
  assert.equal(c.parsed, true)
  assert.deepEqual(c.needs, [])
  assert.deepEqual(c.bugs, [])
  assert.equal(c.wrapUp.changed, false)
  assert.equal(compareHasChanges(c), false)
})

test('compareSummaryReports：解析不了格式时退回行级 diff', () => {
  const c = compareSummaryReports('第一行\n旧的内容', '第一行\n新的内容')
  assert.equal(c.parsed, false)
  assert.deepEqual(c.needs, [])
  assert.deepEqual(c.bugs, [])
  assert.deepEqual(c.lines, [
    { kind: 'same', text: '第一行' },
    { kind: 'del', text: '旧的内容' },
    { kind: 'add', text: '新的内容' },
  ])
})
