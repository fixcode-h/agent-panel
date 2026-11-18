import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BugCase, Diagnosis } from './diagnosis-schema.ts'
import { diagnosisMarkdown } from './diagnosis-md.ts'
import { checkViews, structureMd, viewsProblem, type StructurePayload } from './views.ts'
import { setLang } from '../i18n.ts'

/** 功能结构四个页签（设计稿 2026-11-18「Bug 模式子对话体验」第 2 节）：结构核对、节点位置核对、报告里怎么拼 */
setLang('zh')

const SEQ = [
  'sequenceDiagram',
  '  participant CartPage',
  '  participant Store as cart/store',
  '  participant Badge',
  '  CartPage->>Store: remove(id)',
  '  Note over Store,Badge: cart:change 没派发',
].join('\n')

const stack = [
  { id: 'S1', file: 'web/src/cart/CartPage.tsx', line: 88, fn: 'onDelete', role: 'entry' },
  { id: 'S2', parent: 'S1', file: 'web/src/cart/store.ts', line: 51, fn: 'if (left === 0) return', role: 'fault' },
]

const caseOf = (views: unknown) => BugCase.parse({ stack, views })

test('结构核对：图的开头对得上种类、节点名在图里、默认页签有内容、不是调用栈要写理由', () => {
  assert.equal(viewsProblem(BugCase.parse({})), '', '没写 views 不查')
  const ok = {
    pick: 'sequence',
    why: '4 个参与者来回',
    diagrams: [{ kind: 'sequence', source: SEQ, nodes: [{ id: 'Store' }] }],
  }
  assert.equal(viewsProblem(caseOf(ok)), '')
  assert.equal(
    viewsProblem(caseOf({ ...ok, diagrams: [{ kind: 'sequence', source: `%% 注释\n\n${SEQ}` }] })),
    '',
    '开头的注释、空行跳过',
  )
  assert.match(viewsProblem(caseOf({ ...ok, why: '' })), /views\.why/)
  assert.match(viewsProblem(caseOf({ ...ok, pick: 'class' })), /pick 是 class，但这一页没有内容/)
  assert.match(viewsProblem(caseOf({ ...ok, pick: 'page' })), /pick 是 page/)
  assert.match(viewsProblem(caseOf({ ...ok, diagrams: [{ kind: 'class', source: SEQ }] })), /要以 classDiagram 开头/)
  assert.match(
    viewsProblem(caseOf({ ...ok, diagrams: [{ kind: 'sequence', source: SEQ, nodes: [{ id: 'Cart' }] }] })),
    /名字在图的源码里没有：Cart/,
    '按整词找：CartPage 里的 Cart 不算',
  )
  assert.match(viewsProblem(caseOf({ ...ok, diagrams: [ok.diagrams[0], ok.diagrams[0]] })), /每种图只写一张/)
  assert.match(viewsProblem(caseOf({ ...ok, page: { file: 'docs/arch.png' } })), /\.html/)
  assert.equal(viewsProblem(caseOf({ pick: 'stack' })), '', '默认调用栈不用写理由')
})

test('节点位置核对：偏了几行校准、对不上标出来、一半以上对不上拒收；架构页要读得到；修完沿用', () => {
  const files: Record<string, string> = {
    'web/src/cart/CartPage.tsx': 'a\nb\nexport function CartPage() {\n',
    'web/src/cart/store.ts': 'x\nfunction remove(id) {\n',
    'docs/arch.html': '<html></html>',
  }
  const src = { read: (f: string) => files[f] }
  const c = caseOf({
    pick: 'sequence',
    why: 'x',
    diagrams: [
      {
        kind: 'sequence',
        source: SEQ,
        nodes: [
          { id: 'CartPage', file: 'web/src/cart/CartPage.tsx', line: 1 },
          { id: 'Store', file: 'web/src/cart/store.ts', line: 2, fn: 'remove' },
          { id: 'Badge', file: 'web/src/cart/Badge.tsx', line: 3 },
        ],
      },
    ],
    page: { file: 'docs/arch.html' },
  })
  const notes: string[] = []
  assert.equal(checkViews(c, src, notes, 'cause'), '')
  const [a, b, x] = c.views!.diagrams[0].nodes
  assert.equal(a.line, 3, '没写 fn 按 id 找，校准到第 3 行')
  assert.deepEqual([a.check?.ok, b.check?.ok, x.check?.ok], [true, true, false])
  assert.ok(notes.some((n) => /CartPage 行号从 1 校准到 3/.test(n)))
  assert.ok(notes.some((n) => /Badge/.test(n) && /没对上/.test(n)))

  b.file = 'nope.ts'
  assert.match(checkViews(c, src, [], 'cause'), /一半以上的节点在代码里对不上/)
  assert.equal(checkViews(c, { read: () => undefined }, [], 'fix'), '', '修完不再核对')
  assert.match(checkViews(c, { read: (f) => (f.endsWith('.html') ? undefined : 'x') }, [], 'cause'), /架构页.*读不到/)
})

test('报告里：写了 views 时调用栈那一节换成「功能结构」，structure 代码块带调用栈、图和核对结果', () => {
  const base = {
    stack,
    version: 1,
    at: '',
    status: 'pending',
    phase: 'cause',
    confirmed: true,
    rootCause: 'x',
  }
  const plain = diagnosisMarkdown(Diagnosis.parse(base))
  assert.match(plain, /## 调用栈\n```calltree/, '没写 views 照旧')
  const d = Diagnosis.parse({
    ...base,
    views: {
      pick: 'sequence',
      why: '4 个参与者',
      diagrams: [
        {
          kind: 'sequence',
          title: '删最后一件',
          source: SEQ,
          nodes: [{ id: 'Store', file: 'web/src/cart/store.ts', line: 2, check: { ok: false, why: '附近没有' } }],
        },
      ],
    },
  })
  const md = diagnosisMarkdown(d)
  assert.doesNotMatch(md, /## 调用栈\n/)
  const m = /## 功能结构\n```structure\n([\s\S]*?)\n```/.exec(md)
  assert.ok(m, '功能结构一节是 structure 代码块')
  const p = JSON.parse(m[1]) as StructurePayload
  assert.equal(p.pick, 'sequence')
  assert.equal(p.why, '4 个参与者')
  assert.match(p.stack, /onDelete/, '调用栈页带着 calltree 正文')
  assert.deepEqual(p.diagrams[0].nodes[0], {
    id: 'Store',
    file: 'web/src/cart/store.ts',
    line: 2,
    ok: false,
    why: '附近没有',
  })
  assert.equal(structureMd({ views: undefined }, '```calltree\nx\n```'), '```calltree\nx\n```')
})
