import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LETTER_RESULT_MAX, letterResult } from './child-letter.ts'
import { parseReport } from './peer-message.ts'

const long = (s: string, n: number) => Array.from({ length: n }, () => s).join('')

// 子对话按 summaryDetailRules 写的详细总结：开头一段过程描述，结论在末尾，每段都很长
const detail = [
  '我先看了一下侧栏的渲染逻辑，' + long('然后又查了轮询。', 40),
  '',
  '## 修复｜侧栏的「x 分钟前」不再停在打开页面那一刻',
  '',
  '### 问题',
  long('页面开着不动时相对时间不更新。', 60),
  '',
  '### 原因',
  '相对时间在 Sidebar.tsx:212 渲染时算一次，列表没变就不重画。' + long('补充说明。', 30),
  '',
  '### 修改方案',
  '加一个按整分钟对齐的时钟，只让时间小组件订阅。',
  '',
  '### 改动明细',
  '- `web/src/lib/minute-clock.ts`（新）：MINUTE_CLOCK_DETAIL',
  '',
  '### 影响',
  'IMPACT_DETAIL 只影响相对时间显示。',
  '',
  '### 验证',
  '- 新增的两条单测改前失败、改后通过。',
  '',
  '### 遗留',
  '无',
].join('\n')

test('letterResult：详细总结只摘结论和各段头一句，验证、遗留一定在，改动明细不带', () => {
  assert.ok(detail.length > 1500)
  const r = letterResult(detail)
  assert.equal(r.cut, true)
  assert.ok(r.text.length <= LETTER_RESULT_MAX + 1, `太长：${r.text.length}`)
  assert.match(r.text, /^修复｜侧栏的「x 分钟前」不再停在打开页面那一刻/)
  assert.match(r.text, /- 原因：相对时间在 Sidebar\.tsx:212/)
  assert.match(r.text, /- 验证：- 新增的两条单测改前失败、改后通过。/)
  assert.match(r.text, /- 遗留：无/)
  // 开头的过程描述、逐文件改动和影响不进父对话
  assert.doesNotMatch(r.text, /我先看了一下/)
  assert.doesNotMatch(r.text, /MINUTE_CLOCK_DETAIL|IMPACT_DETAIL/)
})

test('letterResult：没有总结的短回复照原样，长的截到上限', () => {
  assert.deepEqual(letterResult('  已经跑完测试，\n全部通过。 '), { text: '已经跑完测试， 全部通过。', cut: false })
  assert.deepEqual(letterResult(''), { text: '', cut: false })
  const r = letterResult(long('一段很长的说明。', 200))
  assert.equal(r.cut, true)
  assert.ok(r.text.length <= LETTER_RESULT_MAX + 1)
})

test('parseReport：信末尾写给 AI 的「这是摘要」那行不画进界面的结果', () => {
  const r = parseReport(
    '【子对话状态】「修侧栏」（id c1）已完成：合回原分支\n最近的结果：修复｜侧栏时间\n- 验证：通过\n（这是摘要，详细总结在子对话「修侧栏」里：写它的卡片时标题链到它，不用转述细节）',
  )
  assert.equal(r?.result, '修复｜侧栏时间\n- 验证：通过')
})
