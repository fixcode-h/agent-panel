import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import { Diagnosis } from './bug-diagnosis-schema.ts'
import { diagnosisCard } from './bug-diagnosis-card.ts'
import { diagnosisMarkdown, diagnosisView } from './bug-diagnosis-md.ts'

/** 诊断报告按步骤排（用户 2026-11-07 确认的设计稿「诊断报告各步骤内容」）：决策卡、这一步要审的、收起的依据和背景 */
setLang('zh')

const diag = (over: Record<string, unknown> = {}) =>
  Diagnosis.parse({
    version: 1,
    at: '',
    status: 'pending',
    phase: 'plan',
    confirmed: true,
    rootCause: 'removeItem 删最后一件时提前 return',
    symptom: '角标不归零',
    ...over,
  })

test('决策卡：一句话结论、要你做的；要注意由面板算，红的在前、最多三条', () => {
  const d = diag({
    confirmed: false,
    before: ['web/src/cart/badge.ts'],
    attribution: { category: 'unknown', how: 'none' },
    options: [{ id: 'A', title: '在源头补派发', change: '去掉 return', touches: ['data'] }],
    chosen: { id: 'A', why: '修在源头' },
  })
  const c = diagnosisCard(d, { list: [d] })
  assert.equal(c.status.text, '等你确认')
  assert.equal(c.headline, '选方案 A：在源头补派发')
  assert.match(c.quote, /`removeItem` 删最后一件时提前 return/)
  assert.deepEqual(
    c.attention.map((x) => x.tone),
    ['danger', 'warning', 'warning'],
  )
  assert.match(c.attention[0].text, /根因还没用日志或测试证实/)
  assert.match(c.attention[1].text, /交报告前已经改了 1 个/)
  // 第四条（会改数据格式）被挤掉：多了就不醒目
  assert.equal(c.attention.length, 3)
})

test('验证页：改了方案以外的文件、影响面没测，都进「要注意」', () => {
  const d = diag({
    phase: 'verify',
    files: ['web/src/cart/store.ts'],
    result: { impactChecks: [{ area: '结算页', command: '手测', output: '' }], regressionTests: ['store.test.ts'] },
  })
  const c = diagnosisCard(d, { list: [d], changed: ['web/src/cart/store.ts', 'web/src/cart/types.ts', 'docs/a.md'] })
  assert.deepEqual(
    c.attention.map((x) => x.text),
    ['1 项影响面还没有验证结果', '改了方案以外的 1 个文件'],
  )
  assert.match(c.headline, /回归测试 1 条/)
})

test('根因页：证据链三环、关键代码按真实行号、缺环标出来；修复方案草案不摆', () => {
  const d = diag({
    phase: 'cause',
    chain: [
      { step: 'trigger', text: '删最后一件', proof: '复现第 2 步' },
      { step: 'fault', text: 'left=0 时提前 return', proof: '日志 L1 left=0' },
    ],
    codeRef: { file: 'web/src/cart/store.ts', start: 48, end: 50, mark: 49 },
    options: [{ id: 'A', title: '补派发', change: 'x' }],
  })
  const v = diagnosisView(d, undefined, {
    list: [d],
    snippet: 'const left = items.size\nif (left === 0) return\nemit()',
  })
  assert.match(v.main, /- \*\*触发\*\*：删最后一件\n {2}- 证据：复现第 2 步/)
  assert.match(v.main, /\[!CAUTION\]\n> 证据链缺了：现象/)
  assert.match(v.main, /出错位置：`web\/src\/cart\/store\.ts:49`\n\n```ts start=48 mark=49\nconst left/)
  assert.match(v.main, /已经想好修法，同意根因后单独交一版方案给你确认/)
  assert.doesNotMatch(v.main, /候选方案/)
  // 现象这类背景收在「依据和背景」里，用 ### 缩在它下面
  assert.match(v.background, /^### 现象\n角标不归零/m)
  assert.doesNotMatch(v.main, /## 现象/)
})

test('方案页：比较表带 ✓ ⚠ ✗，具体改动一个文件一行，改法不在表里重复', () => {
  const d = diag({
    options: [
      { id: 'A', title: '补派发', change: '去掉 return', covers: '所有订阅者', grades: { covers: 'good' } },
      { id: 'B', title: '角标轮询', change: '定时读', covers: '只修角标', grades: { covers: 'cost' } },
    ],
    chosen: { id: 'A', why: '修在源头' },
    changes: [
      { file: 'web/src/cart/store.ts', what: '去掉提前 return' },
      { file: 'web/src/cart/store.test.ts', what: '加用例', isNew: true },
    ],
  })
  const v = diagnosisView(d, undefined, { list: [d] })
  assert.match(v.main, /\| \*\*修得全\*\* \| ✓ 所有订阅者 \| ⚠ 只修角标 \|/)
  assert.doesNotMatch(v.main, /\*\*改法\*\*/)
  assert.match(v.main, /## 具体改动\n\| 文件 \| 改什么 \|/)
  assert.match(v.main, /`web\/src\/cart\/store\.test\.ts` \*\*新增\*\* \| 加用例/)
})

test('论证第 2 轮：上一轮日志说明了什么放最前，假设表多一列这轮变化；结果怎么判是「看到 → 说明」', () => {
  const h = (status: string) => [
    { id: 'H1', text: '没派发', status: 'open' },
    { id: 'H2', text: '订阅晚', status },
  ]
  const one = diag({ phase: 'evidence', confirmed: false, hypotheses: h('open'), status: 'answered' })
  const two = diag({
    phase: 'evidence',
    confirmed: false,
    version: 2,
    hypotheses: h('excluded'),
    next: '第 1 轮日志排除了 H2',
    logPlan: [{ id: 'L1', file: 'web/src/cart/store.ts', line: 52, print: 'left=${left}', hypothesis: 'H1' }],
    collect: { steps: ['删最后一件'], outcomes: [{ see: '有 L1 没有 L2', means: 'H1 成立' }] },
  })
  const v = diagnosisView(two, one, { list: [one, two] })
  assert.match(v.main, /^## 上一轮日志说明了什么\n第 1 轮日志排除了 H2/)
  assert.match(v.main, /\| 假设 \| 结论 \| 这轮变化 \| 依据 \|/)
  assert.match(v.main, /~~H2 订阅晚~~ \| 已排除 \| 待验证 → 已排除/)
  assert.match(v.main, /## 结果怎么判\n\| 看到 \| 说明 \|\n\| --- \| --- \|\n\| 有 L1 没有 L2 \| H1 成立 \|/)
  assert.match(diagnosisCard(two, { list: [one, two] }).headline, /先加 1 处临时日志/)
})

test('回答带态度，相比上一份写在结论里', () => {
  const one = diag({ notes: [{ id: 1, quote: '提前 return', kind: 'question', comment: '为什么以前没出现？' }] })
  const two = diag({
    version: 2,
    answers: [{ id: 1, answer: '上周重构挪了派发', stance: 'explained' }],
    whatChanged: '补了引入点',
  })
  const md = diagnosisMarkdown(two, one, { list: [one, two] })
  assert.match(md, /- 回答（\*\*已解释\*\*）：上周重构挪了派发/)
  assert.match(md, /相比上一份：补了引入点/)
})
