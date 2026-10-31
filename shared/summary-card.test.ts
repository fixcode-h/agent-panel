import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isSummaryTitle,
  splitSummaryCards,
  summariesOf,
  summaryCardRules,
  summaryDetailRules,
  SUMMARY_KINDS,
  unfenceSummaries,
} from './summary-card.ts'

test('总结卡：标题加字段列表认成卡片，前后的文字照普通 Markdown 留着', () => {
  const md = [
    '改好了，下面是总结。',
    '',
    '### 修复｜子任务卡住后点暂停显示已停止',
    '- **现象**：点暂停变成「已停止」',
    '- **原因**：暂停没区分等待中（server/tasks/jobs.ts:212）',
    '- **修复**：等待中只挂起',
    '- **验证**：回归用例改前失败、改后通过',
    '- **遗留**：无',
    '',
    '排查报告见下。',
  ].join('\n')
  const segs = splitSummaryCards(md)
  assert.equal(segs.length, 3)
  assert.deepEqual(segs[0], { md: '改好了，下面是总结。\n' })
  const card = 'card' in segs[1] ? segs[1].card : undefined
  assert.ok(card)
  assert.equal(card.kind, 'fix')
  assert.equal(card.title, '子任务卡住后点暂停显示已停止')
  assert.deepEqual(
    card.fields.map((x) => [x.key, x.label]),
    [
      ['symptom', '现象'],
      ['cause', '原因'],
      ['fix', '修复'],
      ['verified', '验证'],
      ['remaining', '遗留'],
    ],
  )
  assert.deepEqual(segs[2], { md: '\n排查报告见下。' })
})

test('总结卡：英文类型名、冒号写在粗体里、缩进的子列表都认', () => {
  const md = [
    '### Feature: weekly reports',
    '- **What:** weekly grain',
    '- **How to use**: pick a week',
    '  - then click Extract',
    '- **Needs you**: confirm Monday start',
  ].join('\n')
  const [seg] = splitSummaryCards(md)
  assert.ok('card' in seg)
  assert.equal(seg.card.kind, 'feature')
  assert.equal(seg.card.label, 'Feature')
  assert.deepEqual(
    seg.card.fields.map((x) => x.key),
    ['what', 'usage', 'needs'],
  )
  assert.equal(seg.card.fields[1].text, 'pick a week\n- then click Extract')
})

test('总结卡：代码块里的、只有标题没有字段的、不认识的类型都不画成卡片', () => {
  const inFence = '```markdown\n### 修复｜示例\n- **原因**：x\n```'
  assert.deepEqual(splitSummaryCards(inFence), [{ md: inFence }])
  const bare = '### 修复｜只有标题\n\n普通段落'
  assert.deepEqual(splitSummaryCards(bare), [{ md: bare }])
  const other = '### 背景｜不是总结\n- **原因**：x'
  assert.deepEqual(splitSummaryCards(other), [{ md: other }])
})

test('总结卡：几张卡连着写各自成卡，不认识的字段保留成一行', () => {
  const md = '### 功能｜A\n- **做了什么**：a\n- **截图**：见附件\n\n### 分析｜B\n- **结论**：b'
  const cards = splitSummaryCards(md).flatMap((s) => ('card' in s ? [s.card] : []))
  assert.deepEqual(
    cards.map((c) => c.kind),
    ['feature', 'analysis'],
  )
  assert.deepEqual(cards[0].fields[1], { key: undefined, label: '截图', text: '见附件' })
})

test('总结格式提示词：每一类的字段都按回复语言列出，示例本身能被解析成卡片', () => {
  for (const lang of ['zh', 'en'] as const) {
    const rules = summaryCardRules(lang)
    for (const d of Object.values(SUMMARY_KINDS)) {
      assert.ok(rules.includes(d[lang]), `${lang} 缺类型 ${d[lang]}`)
      for (const x of d.fields) assert.ok(rules.includes(x[lang]), `${lang} 缺字段 ${x[lang]}`)
    }
    const example = /```markdown\n([\s\S]*?)\n```/.exec(rules)?.[1] ?? ''
    const [seg] = splitSummaryCards(example)
    assert.ok('card' in seg, `${lang} 的示例认不出`)
    assert.equal(seg.card.fields.length, SUMMARY_KINDS.fix.fields.length)
  }
})

test('父对话的卡片：标题链到子对话时取出子对话 id，只有标题行也画成卡片', () => {
  const md =
    '### 优化｜[POI 图标修复收尾完成](child:t_abc-1)\n- **效果**：旧图标不再残留\n\n### 修复｜[只写标题](child:t2)\n\n下面是别的说明'
  const segs = splitSummaryCards(md)
  const cards = segs.flatMap((s) => ('card' in s ? [s.card] : []))
  assert.deepEqual(
    cards.map((c) => [c.title, c.child, c.fields.length]),
    [
      ['POI 图标修复收尾完成', 't_abc-1', 1],
      ['只写标题', 't2', 0],
    ],
  )
  assert.ok(segs.some((s) => 'md' in s && s.md.includes('下面是别的说明')))
  // 没链到子对话的只有标题照旧不算卡片
  assert.deepEqual(splitSummaryCards('### 修复｜只有标题\n\n段落'), [{ md: '### 修复｜只有标题\n\n段落' }])
})

test('子对话的详细总结：不会被画成卡片，按段落取出字段供提炼工作总结', () => {
  const md = [
    '改好了。',
    '',
    '## 修复｜暂停后显示已停止',
    '',
    '### 问题',
    '点暂停变成「已停止」。',
    '',
    '### 原因',
    '- 暂停没区分等待中（server/tasks/jobs.ts:212）',
    '- 等待中的子任务被直接结束',
    '',
    '### 改动明细',
    '- `jobs.ts`：等待中只挂起',
    '',
    '## 排查报告',
    '不算在总结里',
  ].join('\n')
  assert.ok(splitSummaryCards(md).every((s) => 'md' in s))
  const [c] = summariesOf(md)
  assert.equal(c.kind, 'fix')
  assert.equal(c.title, '暂停后显示已停止')
  assert.deepEqual(
    c.fields.map((x) => [x.key, x.label]),
    [
      ['problem', '问题'],
      ['cause', '原因'],
      ['changes', '改动明细'],
    ],
  )
  assert.equal(c.fields[1].text, '- 暂停没区分等待中（server/tasks/jobs.ts:212）\n- 等待中的子任务被直接结束')
  assert.equal(summariesOf(md).length, 1)
})

test('子对话的总结格式提示词：每类段落按语言列出，示例能按段落解析，不教它写卡片', () => {
  for (const lang of ['zh', 'en'] as const) {
    const rules = summaryDetailRules(lang)
    for (const d of Object.values(SUMMARY_KINDS)) for (const x of d.detail) assert.ok(rules.includes(x[lang]))
    const example = /```markdown\n([\s\S]*?)\n```/.exec(rules)?.[1] ?? ''
    assert.ok(
      splitSummaryCards(example).every((s) => 'md' in s),
      `${lang} 的示例被认成了卡片`,
    )
    const [c] = summariesOf(example)
    assert.equal(c.fields.length, SUMMARY_KINDS.fix.detail.length)
  }
  assert.match(summaryCardRules('zh', true), /child:<子对话 id>/)
  assert.doesNotMatch(summaryCardRules('zh'), /child:/)
})

test('包在 markdown 代码块里的总结放回正文，别的代码块不动', () => {
  const wrapped = '结果如下\n```markdown\n### 优化｜两条日志改前缀\n- **效果**：一致\n```\n```ts\nconst a = 1\n```'
  assert.equal(
    unfenceSummaries(wrapped),
    '结果如下\n### 优化｜两条日志改前缀\n- **效果**：一致\n```ts\nconst a = 1\n```',
  )
  const doc = '```markdown\n# 标题\n正文\n```'
  assert.equal(unfenceSummaries(doc), doc)
  assert.equal(summariesOf(wrapped)[0].title, '两条日志改前缀')
})

test('渲染出的标题文字认得出是不是总结', () => {
  assert.ok(isSummaryTitle('修复｜暂停后显示已停止'))
  assert.ok(isSummaryTitle(' Feature: weekly '))
  assert.ok(!isSummaryTitle('背景｜不是总结'))
  assert.ok(!isSummaryTitle('问题'))
})
