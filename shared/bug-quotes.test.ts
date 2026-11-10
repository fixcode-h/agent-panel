import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from './i18n.ts'
import { BugCase, Diagnosis } from './bug-diagnosis-schema.ts'
import { fixDiffs, logHits, outcomeMatches, resolveSources, type BugSource } from './bug-quotes.ts'
import { codeRefMd, hitsMd, outcomesMd, quoteMd } from './bug-quotes-md.ts'
import type { TaskMessage } from './schema.ts'

setLang('zh')

// 实跑（2026-11-10）的样例：load.js 第 15 行是出错的那一行，加了临时日志后挤到第 16 行
const loadJs = [
  'export function normalize(o) {', // 1
  ...Array.from({ length: 12 }, (_, i) => `  // ${i + 2}`), // 2-13
  '  return {', // 14
  "  console.log('[排查-金额] L1', o.shipping, typeof o.shipping)", // 15 临时日志
  '    items: o.items,', // 16
  '    shipping: o.shipping ?? 0,', // 17
  '  }', // 18
  '}', // 19
].join('\n')
const files: Record<string, string> = { 'src/load.js': loadJs }
const src: BugSource = {
  read: (f) => files[f],
  show: () =>
    '@@ -15,2 +15,2 @@\n-    shipping: Number(o.shipping),\n+    shipping: o.shipping ?? 0,\n@@ -40 +40 @@\n-x\n+y',
}
const now = '2026-11-10T00:00:00Z'
const base = (over: Record<string, unknown>) =>
  BugCase.parse({ symptom: '应付 10812', rootCause: 'shipping 是字符串', confirmed: true, ...over })
const ctx = (over: Partial<Parameters<typeof resolveSources>[1]> = {}) => ({
  list: [] as Diagnosis[],
  messages: [] as TaskMessage[],
  phase: 'cause',
  src,
  now,
  ...over,
})

test('代码快照：按 marks.text 校准被临时日志挤偏的行号（F5），取当时的代码存档', () => {
  const c = base({
    codeRefs: [
      {
        id: 'C1',
        role: 'fault',
        file: 'src/load.js',
        start: 13,
        end: 17,
        marks: [{ line: 16, text: 'o.shipping ?? 0', level: 'fault' }],
      },
    ],
  })
  const r = resolveSources(c, ctx())
  assert.equal(r.error, '')
  assert.equal(c.codeRefs[0].marks[0].line, 17)
  assert.equal(c.codeRefs[0].start, 14, '整段跟着挪')
  assert.match(r.notes.join('\n'), /src\/load\.js:16 里没有「o\.shipping \?\? 0」，第 17 行有/)
  assert.match(c.codeRefs[0].snapshot!.text, /shipping: o\.shipping \?\? 0/)
  const md = codeRefMd(c.codeRefs[0])
  assert.match(md, /```js start=14 marks=/)
  const marks = JSON.parse(decodeURIComponent(/marks=(\S+)/.exec(md)![1])) as { l: number; v: string }[]
  assert.ok(
    marks.some((m) => m.l === 15 && m.v === 'dim'),
    '临时日志行变淡',
  )
  assert.ok(marks.some((m) => m.l === 17 && m.v === 'fault'))
})

test('代码原文对不上、超过 30 行、读不到文件都拒收', () => {
  const bad = (ref: Record<string, unknown>) =>
    resolveSources(base({ codeRefs: [{ id: 'C1', file: 'src/load.js', start: 14, end: 18, ...ref }] }), ctx()).error
  assert.match(bad({ marks: [{ line: 17, text: 'left == 0' }] }), /src\/load\.js:17 里没有「left == 0」/)
  assert.match(bad({ start: 1, end: 40 }), /超过 30 行/)
  assert.match(bad({ file: 'src/nope.js' }), /读不到 src\/nope\.js/)
})

test('没有宿主（单测、导入的对话）不取快照；旧写法 codeRef 有宿主时换成一段 codeRefs', () => {
  const c = base({
    codeRefs: [{ id: 'C1', file: 'src/load.js', start: 14, end: 18, snapshot: { text: '假的', at: now } }],
  })
  assert.equal(resolveSources(c, ctx({ src: undefined })).error, '')
  assert.equal(c.codeRefs[0].snapshot, undefined, 'Agent 自己写的快照不认')
  const old = base({ codeRef: { file: 'src/load.js', start: 16, end: 18, mark: 17 } })
  assert.equal(resolveSources(old, ctx()).error, '')
  assert.equal(old.codeRefs[0].role, 'fault')
  assert.ok(old.codeRefs[0].snapshot)
})

const withLogs = (logs: string) =>
  [Diagnosis.parse({ version: 2, at: now, phase: 'evidence', status: 'answered', logs })] as Diagnosis[]
const userLogs = ['[app] start', '[排查-金额] L1 shipping= 12.00 string', '[app] render 应付 10812'].join('\n')

test('日志原文：按行号取；抄的原文被删改（F7）、关键值不在原文里都拒收', () => {
  const c = base({ quotes: [{ id: 'Q1', kind: 'log', from: 2, start: 2, highlight: ['12.00 string'] }] })
  assert.equal(resolveSources(c, ctx({ list: withLogs(userLogs) })).error, '')
  assert.equal(c.quotes[0].text, '[排查-金额] L1 shipping= 12.00 string')
  assert.match(quoteMd(c.quotes[0]), /你贴的日志（报告 #2）第 2~2 行/)
  // 只抄了原文：面板找出行号
  const found = base({ quotes: [{ id: 'Q1', kind: 'log', text: '[app] render 应付 10812' }] })
  assert.equal(resolveSources(found, ctx({ list: withLogs(userLogs) })).error, '')
  assert.equal(found.quotes[0].start, 3)
  const cut = base({ quotes: [{ id: 'Q1', kind: 'log', from: 2, start: 2, text: 'L1 shipping= … string' }] })
  assert.match(resolveSources(cut, ctx({ list: withLogs(userLogs) })).error, /对不上：从日志里原样复制/)
  const hl = base({ quotes: [{ id: 'Q1', kind: 'log', from: 2, start: 2, highlight: ['left=0'] }] })
  assert.match(resolveSources(hl, ctx({ list: withLogs(userLogs) })).error, /原文里没有「left=0」/)
  assert.match(resolveSources(base({ quotes: [{ id: 'Q1', kind: 'log', start: 1 }] }), ctx()).error, /没有用户贴的日志/)
})

test('命令输出原文要在这个对话的工具输出里找得到；描述不核对', () => {
  const messages = [
    { tools: [{ kind: 'run', label: 'npm test', output: 'FAIL  total\n  expected 120\n  received "10812.00"' }] },
  ] as unknown as TaskMessage[]
  const ok = base({ quotes: [{ id: 'Q2', kind: 'run', text: 'expected 120 received "10812.00"' }] })
  assert.equal(resolveSources(ok, ctx({ messages })).error, '', '空白归一后对得上')
  const bad = base({ quotes: [{ id: 'Q2', kind: 'run', text: 'expected 120 received 10812' }] })
  assert.match(resolveSources(bad, ctx({ messages })).error, /命令输出里找不到/)
  assert.equal(resolveSources(base({ quotes: [{ id: 'Q3', kind: 'note', text: '截图里是 10812' }] }), ctx()).error, '')
})

test('引用编号要存在；构造数据的复现不能当排除假设的依据（F8）', () => {
  const chain = [{ step: 'fault', text: 'shipping 没转数字', proof: '', refs: ['Q9'] }]
  assert.match(resolveSources(base({ chain }), ctx()).error, /Q9/)
  const hypotheses = [
    { id: 'H1', text: '公式错', status: 'excluded', basis: '凑出了 10812' },
    { id: 'H2', text: '类型不对', status: 'open', basis: '' },
  ]
  assert.match(
    resolveSources(base({ reproKind: 'constructed', hypotheses }), ctx()).error,
    /构造的数据.*H1 的依据要引用用户日志或命令输出原文/,
  )
})

test('提醒：已证实的根因用了猜测的词、出错点没有代码和日志原文', () => {
  const c = base({ rootCause: '可能是 shipping 没转数字', chain: [{ step: 'fault', text: '应该是这里', proof: 'x' }] })
  const r = resolveSources(c, ctx())
  assert.equal(r.error, '')
  assert.match(r.notes.join('\n'), /「可能、应该是」/)
  assert.match(r.notes.join('\n'), /出错点最好引用一段代码/)
})

test('引入点：取引入那次改动里碰到出错点的那一段 diff', () => {
  const c = base({
    attribution: { category: 'recent', change: 'abc1234', how: 'blame' },
    codeRefs: [{ id: 'C1', file: 'src/load.js', start: 16, end: 18, marks: [{ line: 17, text: 'o.shipping ?? 0' }] }],
  })
  assert.equal(resolveSources(c, ctx()).error, '')
  assert.match(c.attribution!.diff!, /\+    shipping: o\.shipping \?\? 0/)
  assert.doesNotMatch(c.attribution!.diff!, /\+y/, '别的段落不带')
})

test('日志命中表：按 [排查-…] L<n> 数，L1 不算进 L12；没出现的加粗；结果怎么判自动对上', () => {
  const plan = [
    { id: 'L1', file: 'src/load.js', line: 15, fn: '', print: "console.log('[排查-金额] L1')", hypothesis: 'H1' },
    { id: 'L2', file: 'src/checkout.js', line: 17, fn: '', print: "console.log('[排查-金额] L2')", hypothesis: 'H2' },
  ]
  const logs = `${userLogs}\n[排查-金额] L12 别的\n[排查-金额] L1 again`
  const hits = logHits(logs, plan)
  assert.equal(hits[0].count, 2)
  assert.equal(hits[0].first?.line, 2)
  assert.equal(hits[1].count, 0)
  const d = { logs, logPlan: plan }
  assert.match(hitsMd(d), /\| L2 \| `src\/checkout\.js:17` \| \*\*0 次\*\* \| — \|/)
  const collect = {
    steps: [],
    where: '',
    filter: '',
    expect: '',
    outcomes: [
      { see: '有 L1 没有 L2', means: 'H1', match: { point: 'L2', seen: false } },
      { see: 'L2 出现', means: 'H2', match: { point: 'L2', seen: true } },
      { see: '别的', means: '看路标' },
    ],
  }
  assert.deepEqual(outcomeMatches(collect, hits), [true, false, undefined])
  assert.match(outcomesMd(collect, d), /\| 有 L1 没有 L2 \| H1 \| \*\*✓ 对上了\*\* \|/)
})

test('验证：出错点那几段代码修前（根因版快照）和现在对照，临时日志不算', () => {
  const cause = Diagnosis.parse({
    version: 3,
    at: now,
    phase: 'cause',
    status: 'approved',
    codeRefs: [
      {
        id: 'C1',
        file: 'src/load.js',
        start: 14,
        end: 18,
        snapshot: { text: loadJs.split('\n').slice(13, 18).join('\n'), at: now },
      },
    ],
  })
  files['src/load.js'] = loadJs.replace('    shipping: o.shipping ?? 0,', '    shipping: Number(o.shipping ?? 0),')
  const diffs = fixDiffs([cause], src)
  files['src/load.js'] = loadJs
  assert.equal(diffs.length, 1)
  assert.match(diffs[0].diff, /^-    shipping: o\.shipping \?\? 0,$/m)
  assert.match(diffs[0].diff, /^\+    shipping: Number\(o\.shipping \?\? 0\),$/m)
  assert.doesNotMatch(diffs[0].diff, /排查-/)
})
