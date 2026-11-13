import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BugCase, BugHop, Diagnosis } from './diagnosis-schema.ts'
import { hopsToCallTree, hopTree, mainPath, parseCallTree, type CallNode } from './call-tree.ts'
import { callTreeMd } from './call-tree-md.ts'
import { checkStack, fnWord, matchTrace, stackProblem, traceFrames } from './stack-check.ts'
import { setLang } from '../i18n.ts'

/** 调用栈树（设计稿 2026-11-13「诊断报告：关键调用栈」）：扁平的 stack ↔ calltree 文本、核对、报告里怎么画 */
setLang('zh')

const hop = (over: Partial<BugHop>) => BugHop.parse(over)
const cart = () => [
  hop({
    id: 'S1',
    file: 'web/src/cart/CartPage.tsx',
    line: 88,
    fn: 'CartPage.onDelete',
    note: '点删除',
    role: 'entry',
  }),
  hop({ id: 'S2', parent: 'S1', file: 'web/src/cart/store.ts', line: 48, fn: 'removeItem(id)', note: '算剩几件' }),
  hop({
    id: 'S3',
    parent: 'S2',
    role: 'fault',
    file: 'web/src/cart/store.ts',
    line: 51,
    fn: 'if (left === 0) return',
    note: '剩 0 件提前返回',
    cond: { text: 'left === 0', took: '真' },
    values: [{ name: 'left', actual: '0', expected: '1' }],
    refs: ['H1'],
  }),
  hop({
    id: 'S4',
    parent: 'S2',
    role: 'missed',
    file: 'web/src/cart/store.ts',
    line: 52,
    fn: "emit('cart:change', { count })",
  }),
  hop({
    id: 'S5',
    parent: 'S4',
    role: 'symptom',
    edge: 'event',
    edgeNote: '事件 cart:change',
    file: 'web/src/cart/Badge.tsx',
    line: 15,
    fn: '现象：角标停在 1',
  }),
  hop({ id: 'S6', parent: 'S2', role: 'side', file: 'web/src/cart/store.ts', line: 60, fn: 'persist()' }),
]

const nodes = (items: ReturnType<typeof parseCallTree>['items']): CallNode[] =>
  items.flatMap((i) => (i.kind === 'node' ? [i.node, ...nodes(i.node.children)] : []))

test('stack 转成 calltree 文本再解析回来：层级、角色、边界、条件、值、编号都在', () => {
  const text = hopsToCallTree(cart(), { hits: new Map([['L1', true]]), attach: new Map([['S1', ['L1']]]) })
  assert.match(text, /^CartPage\.onDelete {2}web\/src\/cart\/CartPage\.tsx:88 {2}— 点删除 {2}\{L1\+\}$/m)
  assert.match(
    text,
    /^ {4}! if \(left === 0\) return {2}web\/src\/cart\/store\.ts:51 .*<left === 0 → 真> {2}\[left=0 => 1\] {2}\{H1\}$/m,
  )
  assert.match(text, /^ {6}=> 事件 cart:change$/m)
  const tree = parseCallTree(text)
  const [root] = tree.items
  assert.equal(root.kind, 'node')
  const all = nodes(tree.items)
  assert.deepEqual(
    all.map((n) => [n.role, n.fn]),
    [
      ['entry', 'CartPage.onDelete'],
      ['path', 'removeItem(id)'],
      ['fault', 'if (left === 0) return'],
      ['missed', "emit('cart:change', { count })"],
      ['symptom', '现象：角标停在 1'],
      ['side', 'persist()'],
    ],
  )
  const fault = all[2]
  assert.equal(fault.file, 'web/src/cart/store.ts')
  assert.equal(fault.line, 51)
  assert.deepEqual(fault.cond, { text: 'left === 0', took: '真' })
  assert.deepEqual(fault.values, [{ name: 'left', actual: '0', expected: '1' }])
  assert.deepEqual(all[0].refs, [{ id: 'L1', hit: true }])
  assert.equal(all[4].edge, '事件 cart:change')
  assert.equal(all[1].children.length, 3, 'removeItem 下面三个子项')
})

test('Agent 手写的 calltree：函数名里的括号、单个空格不被拆开；认不出的行照样显示', () => {
  const t = parseCallTree(
    [
      '% 读代码推出',
      'main  src/app.ts:3',
      '  ~ arr[0].run({ a })  src/x.ts:10:4  — 没走到  {L2-} #alt:B',
      '    |>10 arr[0].run({ a })',
      '  --- 断在这里',
      '  随便写的一行',
    ].join('\n'),
  )
  assert.deepEqual(t.caption, ['读代码推出'])
  const [main] = nodes(t.items)
  const kids = (t.items[0] as { node: CallNode }).node.children
  assert.equal(main.role, 'entry')
  const run = (kids[0] as { node: CallNode }).node
  assert.equal(run.fn, 'arr[0].run({ a })')
  assert.equal(run.line, 10, ':列号丢掉')
  assert.deepEqual(run.refs, [{ id: 'L2', hit: false }])
  assert.deepEqual(run.tags, ['alt:B'])
  assert.deepEqual(run.code, [{ mark: true, line: 10, text: 'arr[0].run({ a })' }])
  assert.deepEqual(kids[1], { kind: 'cut', text: '断在这里' })
  assert.equal((kids[2] as { node: CallNode }).node.fn, '随便写的一行')
})

test('旧数据没有 id / parent：按顺序连成一条直线；parent 成环的挂到根上', () => {
  const old = [hop({ file: 'a.ts', fn: 'a' }), hop({ file: 'b.ts', fn: 'b' }), hop({ file: 'c.ts', fn: 'c' })]
  const { roots, kids } = hopTree(old)
  assert.equal(roots.length, 1)
  assert.equal(kids.get(old[1])?.[0], old[2])
  assert.match(hopsToCallTree(old), /^a {2}a\.ts\n {2}b {2}b\.ts\n {4}c {2}c\.ts$/)
  const loop = [hop({ id: 'S1', parent: 'S2', fn: 'x' }), hop({ id: 'S2', parent: 'S1', fn: 'y' })]
  const tree = hopTree(loop)
  assert.ok(tree.roots.length >= 1, '成环时至少有一跳当根，不丢')
  assert.equal(tree.roots.length + [...tree.kids.values()].flat().length, 2)
  const path = mainPath(cart())
  assert.ok(!path.has(cart()[5]) && [...path].length === 5, '旁支不在主路径上')
})

const caseOf = (over: Record<string, unknown> = {}) =>
  BugCase.parse({ stack: cart(), hypotheses: [{ id: 'H1', text: 'x' }], ...over })

test('结构核对：根因、方案必须有入口和出错点；编号要对得上；只写 location 不收', () => {
  assert.equal(stackProblem(caseOf(), 'cause'), '')
  assert.match(stackProblem(BugCase.parse({ location: 'a.ts:1' }), 'cause'), /只写 location 一句话不算/)
  assert.equal(stackProblem(BugCase.parse({}), 'evidence'), '', '论证还可以没有')
  const two = cart().map((h) => (h.id === 'S4' ? { ...h, role: 'fault' as const } : h))
  assert.match(stackProblem(caseOf({ stack: two }), 'cause'), /出错点（role: fault）只能有一个/)
  assert.match(stackProblem(caseOf({ stack: [...cart(), hop({ id: 'S1', fn: 'dup' })] }), 'cause'), /S1 重复了/)
  assert.match(
    stackProblem(caseOf({ stack: [...cart(), hop({ id: 'S9', parent: 'S8', fn: 'x' })] }), 'cause'),
    /S9 → S8/,
  )
  assert.match(stackProblem(caseOf({ hypotheses: [] }), 'cause'), /挂的这些编号.*H1/)
  assert.match(
    stackProblem(caseOf({ options: [{ id: 'A', title: 'a', change: 'x', hops: ['S7'] }] }), 'plan'),
    /options\.hops.*S7/,
  )
  assert.match(stackProblem(caseOf({ stackFrom: { kind: 'trace', trace: 'Q9' } }), 'cause'), /stackFrom\.trace/)
})

test('位置核对：附近找函数名，偏了几行校准过去；出错点存快照；一半以上对不上拒收；修完沿用根因那一版', () => {
  const store = [
    'export function removeItem(id) {',
    '  items.delete(id)',
    '  const left = items.size',
    '  if (left === 0) return',
    "  emit('cart:change', { count: left })",
    '}',
  ].join('\n')
  const files: Record<string, string> = {
    'web/src/cart/store.ts': `${'\n'.repeat(46)}${store}`,
    'web/src/cart/CartPage.tsx': `${'\n'.repeat(87)}  onDelete = () => removeItem(id)`,
    'web/src/cart/Badge.tsx': `${'\n'.repeat(14)}  render() { return n }`,
  }
  const src = { read: (f: string) => files[f] }
  const c = caseOf()
  const notes: string[] = []
  assert.equal(checkStack(c, src, notes, 'cause'), '')
  const s3 = c.stack[2]
  assert.equal(s3.line, 50, '行号从 51 校准到 50（left 在第 50 行）')
  assert.ok(notes.some((n) => n.includes('S3 的行号从 51 校准到 50')))
  assert.equal(s3.check?.ok, true)
  assert.equal(s3.check?.start, 49)
  assert.match(s3.check!.code, /if \(left === 0\) return/)
  assert.equal(c.stack[5].check?.ok, false, 'persist 不在那一行附近')
  assert.ok(notes.some((n) => n.includes('没对上')))
  const bad = caseOf()
  assert.match(checkStack(bad, { read: () => 'x' }, [], 'cause'), /一半以上的跳在代码里对不上/)
  const fixed = caseOf()
  fixed.stack[2].check = { ok: true, why: '', start: 49, code: '旧代码' }
  assert.equal(checkStack(fixed, { read: () => undefined }, [], 'fix'), '')
  assert.equal(fixed.stack[2].check?.code, '旧代码', '修完不重新核对')
  assert.equal(fnWord('cartStore.removeItem(id)'), 'removeItem')
  assert.equal(fnWord('CartPage.onDelete'), 'onDelete')
  assert.equal(fnWord('UMyComp::Tick'), 'Tick')
})

test('报错堆栈：常见格式解析成帧，树上的跳对上就标 frame，一半以上对不上拒收', () => {
  const js = [
    "TypeError: Cannot read properties of undefined (reading 'map')",
    '    at ProjectList (ProjectList.tsx:41:22)',
    '    at renderWithHooks (react-dom.js:15486)',
    '    at SettingsPage (http://x/src/SettingsPage.tsx:77:9)',
  ].join('\n')
  assert.deepEqual(
    traceFrames(js).map((f) => [f.file.split('/').pop(), f.line, f.fn]),
    [
      ['ProjectList.tsx', 41, 'ProjectList'],
      ['react-dom.js', 15486, 'renderWithHooks'],
      ['SettingsPage.tsx', 77, 'SettingsPage'],
    ],
  )
  assert.deepEqual(traceFrames('  File "a/b.py", line 12, in run').at(0), { file: 'a/b.py', line: 12, fn: 'run' })
  assert.equal(traceFrames("game/ui.lua:30: in function 'Open'")[0].fn, 'Open')
  assert.equal(traceFrames('UMyComp::Tick() [D:/P/Source/MyComp.cpp:123]')[0].line, 123)
  const c = BugCase.parse({
    quotes: [{ id: 'Q2', kind: 'log', text: js }],
    stackFrom: { kind: 'trace', trace: 'Q2' },
    stack: [
      { id: 'S1', file: 'web/src/pages/SettingsPage.tsx', line: 77, fn: 'SettingsPage' },
      { id: 'S2', parent: 'S1', role: 'fault', file: 'web/src/settings/ProjectList.tsx', line: 41, fn: 'groups.map' },
    ],
  })
  assert.equal(matchTrace(c, 'cause'), '')
  assert.ok(c.stack.every((h) => h.check?.frame))
  c.stack[1].line = 90
  c.stack[0].line = 10
  assert.match(matchTrace(c, 'cause'), /一半以上的跳不在堆栈里/)
})

test('报告里的调用栈：日志点挂到各自那一跳，标出打没打和断在哪；方案页标出各方案改在哪', () => {
  const base = {
    ...caseOf(),
    version: 1,
    at: '',
    status: 'answered',
    phase: 'evidence',
    logs: '[排查-购物车] L1 click\n[排查-购物车] L2 left=0',
    logPlan: [
      { id: 'L1', file: 'web/src/cart/CartPage.tsx', line: 89, print: 'x' },
      { id: 'L2', file: 'web/src/cart/store.ts', line: 49, print: 'x', hop: 'S2' },
      { id: 'L3', file: 'web/src/cart/store.ts', line: 52, print: 'x', hop: 'S4' },
    ],
  }
  const md = callTreeMd(Diagnosis.parse(base))
  assert.match(md, /^```calltree\n% 读代码推出/)
  assert.match(md, /CartPage\.onDelete .*\{L1\+\}/, 'L1 没写 hop：按同一文件最近的一跳挂上')
  assert.match(md, /removeItem\(id\) .*\{L2\+\}/)
  assert.match(md, /\n {4}--- 断在这里：L2 之后没有 L3\n {4}~ emit/)
  assert.match(md, /~ emit.*\{L3-\}/)
  const plan = Diagnosis.parse({
    ...base,
    phase: 'plan',
    status: 'pending',
    logs: '',
    logPlan: [],
    options: [
      { id: 'A', title: '去掉提前返回', change: 'x', files: ['web/src/cart/store.ts'] },
      { id: 'B', title: '角标自己读', change: 'x', hops: ['S5'] },
    ],
    chosen: { id: 'A', why: '', whyNotOthers: '' },
  })
  const pm = callTreeMd(plan, [Diagnosis.parse(base), plan])
  assert.match(pm, /! if \(left === 0\) return .*#fix:A/)
  assert.match(pm, /\? 现象：角标停在 1 .*#alt:B/)
  assert.match(pm, /CartPage\.onDelete .*\{L1\+\}/, '方案页沿用论证那一轮贴的日志')
})
