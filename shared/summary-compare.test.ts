import assert from 'node:assert/strict'
import test from 'node:test'
import { compareHasChanges, compareSummaryReports, parseSummaryReport } from './summary.ts'

/** 按新报告模板拼一份报告：四节、条目 */
function report(opts: { needs: string[]; bugs: string[]; next: string[]; wrap: string }) {
  return [
    '# 2026-10-23 工作总结',
    '',
    '## 一、概览',
    opts.wrap,
    '',
    '## 二、需求进度',
    '',
    ...opts.needs,
    '',
    '## 三、问题与修复',
    '',
    ...opts.bugs,
    '',
    '## 四、下一步',
    '',
    ...opts.next,
    '',
  ].join('\n')
}

/** 老报告：三节（需求进度 / 用户报告的 Bug / 今日小结），升级后仍要能解析和对比 */
function legacyReport(opts: { needs: string[]; bugs: string[]; wrap: string }) {
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

const LEGACY = legacyReport({
  needs: ['### 1.1 商城前台', '1. **购物车数量不同步** ｜ 已完成（4/4）', '   实现：以服务端返回为准'],
  bugs: [
    '### 2.1 商城前台',
    '1. **点「全部应用」后按钮没有变化**',
    '   原因：保存只改了内存',
    '   修复：保存后重新拉一遍配置',
  ],
  wrap: '今天完成了商城前台的主要需求。',
})

const before = report({
  needs: [
    '### 2.1 商城前台',
    '1. **购物车数量不同步** ｜ 已完成（4/4）',
    '   实现：以服务端返回为准',
    '2. **商品列表缺加载骨架** ｜ 进行中（2/3）',
    '   实现：先渲染等高占位块',
    '3. **价格显示格式不统一** ｜ 已完成（2/2）',
    '   实现：收成一个格式化函数',
    '',
    '### 2.2 设置页',
    '1. **弹窗打开时闪一下** ｜ 已完成（2/2）',
    '   实现：挂载完成后再定位',
  ],
  bugs: [
    '### 3.1 商城前台',
    '1. **点「全部应用」后按钮没有变化** ｜ 已修复',
    '   原因：保存只改了内存',
    '   修复：保存后重新拉一遍配置',
    '2. **设置弹窗打开时先闪在左上角** ｜ 已修复',
    '   原因：挂载时还没有锚点',
    '   修复：等挂载完再定位',
  ],
  next: [
    '### 4.1 商城前台',
    '1. **补购物车并发测试**',
    '   说明：覆盖两个人同时加减数量',
    '2. **统一价格格式化入口**',
    '   说明：页面里不再各自格式化',
  ],
  wrap: '今天完成了商城前台的主要需求，剩下的按计划推进。',
})

const after = report({
  needs: [
    '### 2.1 商城前台',
    '1. **购物车数量不同步** ｜ 已完成（4/4）',
    '   实现：以服务端返回为准',
    '2. **商品列表缺加载骨架** ｜ 已完成（3/3）',
    '   实现：先渲染等高占位块',
    '3. **搜索框不支持拼音** ｜ 进行中（1/4）',
    '   实现：先接一个拼音转换',
    '',
    '### 2.2 设置页',
    '1. **弹窗打开时闪一下** ｜ 已完成（2/2）',
    '   实现：挂载完成后再定位',
  ],
  bugs: [
    '### 3.1 商城前台',
    '1. **点「全部应用」后按钮没有变化** ｜ 已修复',
    '   原因：保存只改了内存',
    '   修复：保存后重新拉一遍配置',
    '2. **结算页金额算错了优惠** ｜ 已修复',
    '   原因：优惠券和满减重复抵扣',
    '   修复：先算满减再减优惠券',
  ],
  next: [
    '### 4.1 商城前台',
    '1. **统一价格格式化入口**',
    '   说明：页面里不再各自格式化',
    '2. **补退款流程的验收**',
    '   说明：退款后金额和库存都要对',
  ],
  wrap: '今天完成了商品列表骨架，新开的搜索拼音需求还在做。',
})

test('parseSummaryReport：按四节拆出项目、条目、状态和缩进说明', () => {
  const p = parseSummaryReport(before)
  assert.equal(p.ok, true)
  assert.equal(p.title, '2026-10-23 工作总结')
  assert.deepEqual(
    p.needs.map((s) => [s.no, s.name, s.items.length]),
    [
      ['2.1', '商城前台', 3],
      ['2.2', '设置页', 1],
    ],
  )
  const first = p.needs[0].items[0]
  assert.equal(first.no, 1)
  assert.equal(first.title, '购物车数量不同步')
  assert.equal(first.status, '已完成（4/4）')
  assert.equal(first.detail, '实现：以服务端返回为准')
  // 问题与修复一节没有状态，缩进的「原因 / 修复」都收进说明里
  assert.equal(p.bugs[0].items[0].status, '')
  assert.equal(p.bugs[0].items[0].detail, '原因：保存只改了内存\n修复：保存后重新拉一遍配置')
  // 下一步同样没有状态，缩进的「说明」收进说明里
  assert.equal(p.next[0].items[0].title, '补购物车并发测试')
  assert.equal(p.next[0].items[0].detail, '说明：覆盖两个人同时加减数量')
  assert.equal(p.wrapUp, '今天完成了商城前台的主要需求，剩下的按计划推进。')
  // 老报告（三节）仍能解析：今日小结当概览，用户报告的 Bug 当问题，没有下一步
  const legacy = parseSummaryReport(LEGACY)
  assert.equal(legacy.ok, true)
  assert.equal(legacy.needs[0].items[0].title, '购物车数量不同步')
  assert.equal(legacy.bugs[0].items[0].title, '点「全部应用」后按钮没有变化')
  assert.deepEqual(legacy.next, [])
  assert.equal(legacy.wrapUp, '今天完成了商城前台的主要需求。')
  // 老三节和新四节能一起对比：同名节按同一套节配对
  const cross = compareSummaryReports(LEGACY, after)
  assert.equal(cross.parsed, true)
  assert.ok(cross.needs.some((x) => x.kind === 'added' && x.title === '搜索框不支持拼音'))
  assert.ok(cross.bugs.some((x) => x.kind === 'added' && x.title === '结算页金额算错了优惠'))
  assert.equal(cross.wrapUp.changed, true)
})

test('parseSummaryReport：缺节、格式乱时 ok 为 false，不抛错', () => {
  assert.equal(parseSummaryReport('# 随便写写\n\n## 二、需求进度\n1. **条目** ｜ 已完成\n').ok, false)
  assert.equal(parseSummaryReport('').ok, false)
  // 条目写在项目标题之前：没法归类，不收（也不凭空造一个项目）；有条目行没解析出来就算格式失败
  const stray = parseSummaryReport(
    '# x 工作总结\n\n## 一、概览\n暂无\n\n## 二、需求进度\n\n1. **没有项目** ｜ 已完成\n\n## 三、问题与修复\n\n暂无\n\n## 四、下一步\n暂无\n',
  )
  assert.equal(stray.ok, false)
  assert.deepEqual(stray.needs, [])
})

test('parseSummaryReport：手改报告用半角竖线、状态留空也能解析', () => {
  const md = [
    '# 2026-10-23 工作总结',
    '',
    '## 一、概览',
    '暂无',
    '',
    '## 二、需求进度',
    '',
    '### 2.1 商城前台',
    '1. **购物车数量不同步** | 已完成（4/4）',
    '2. **搜索框不支持拼音** ｜',
    '',
    '## 三、问题与修复',
    '',
    '### 3.1 商城前台',
    '1. **点「全部应用」后按钮没有变化**',
    '',
    '## 四、下一步',
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
    '## 一、概览',
    '暂无',
    '',
    '## 二、需求进度',
    '',
    '### 2.1 商城前台',
    '1. 购物车数量不同步 ｜ 已完成（4/4）',
    '',
    '## 三、问题与修复',
    '',
    '暂无',
    '',
    '## 四、下一步',
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

test('compareSummaryReports：问题与修复给出新增和已修复（消失），概览并排', () => {
  const c = compareSummaryReports(before, after)
  const dropped = c.bugs.find((x) => x.kind === 'removed')
  assert.equal(dropped?.title, '设置弹窗打开时先闪在左上角')
  assert.equal(dropped?.detail, '原因：挂载时还没有锚点\n修复：等挂载完再定位')
  const added = c.bugs.find((x) => x.kind === 'added')
  assert.equal(added?.title, '结算页金额算错了优惠')
  // 问题没有状态：标题相同就是没变化，不会给出空的状态变化
  assert.equal(c.bugs.filter((x) => x.kind === 'changed').length, 0)
  assert.equal(c.wrapUp.changed, true)
  assert.ok(c.wrapUp.before.startsWith('今天完成了商城前台'))
  assert.ok(c.wrapUp.after.startsWith('今天完成了商品列表骨架'))
  // 下一步同样给出新增和消失（没有状态）
  const nextKinds = c.next.map((x) => `${x.kind}:${x.title}`)
  assert.deepEqual(nextKinds.sort(), ['added:补退款流程的验收', 'removed:补购物车并发测试'])
  assert.equal(c.next.find((x) => x.kind === 'added')?.detail, '说明：退款后金额和库存都要对')
})

test('compareSummaryReports：同一份对比自己没有差异', () => {
  const c = compareSummaryReports(before, before)
  assert.equal(c.same, true)
  assert.equal(c.parsed, true)
  assert.deepEqual(c.needs, [])
  assert.deepEqual(c.bugs, [])
  assert.deepEqual(c.next, [])
  assert.equal(c.wrapUp.changed, false)
  assert.equal(compareHasChanges(c), false)
})

test('compareSummaryReports：解析不了格式时退回行级 diff', () => {
  const c = compareSummaryReports('第一行\n旧的内容', '第一行\n新的内容')
  assert.equal(c.parsed, false)
  assert.deepEqual(c.needs, [])
  assert.deepEqual(c.bugs, [])
  assert.deepEqual(c.next, [])
  assert.deepEqual(c.lines, [
    { kind: 'same', text: '第一行' },
    { kind: 'del', text: '旧的内容' },
    { kind: 'add', text: '新的内容' },
  ])
})
