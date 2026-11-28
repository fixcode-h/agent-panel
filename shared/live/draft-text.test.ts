/**
 * 工具入参的 JSON 片段边收边转成能读的文字（draft-text.ts）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDraftReader, draftTail, DRAFT_TEXT_MAX } from './draft-text.ts'

const read = (json: string, size: number) => {
  const r = createDraftReader()
  let out = ''
  for (let i = 0; i < json.length; i += size) out += r.feed(json.slice(i, i + size))
  return out
}

test('片段在任何位置断开，转出来都一样', () => {
  const json = JSON.stringify({
    phase: 'evidence',
    symptom: '点了没反应\n第二行 中 "引号"',
    hypotheses: [{ cause: '缓存', score: 3 }, '另一个'],
    nums: [12, 3.5, true],
  })
  const whole = read(json, json.length)
  for (const n of [1, 2, 3, 7]) assert.equal(read(json, n), whole, `每段 ${n} 个字`)
  assert.equal(
    whole.trim(),
    [
      'phase：evidence',
      '',
      'symptom：点了没反应\n第二行 中 "引号"',
      '',
      'hypotheses：',
      '  - ',
      '    cause：缓存',
      '    score：3',
      '  - 另一个',
      '',
      'nums：',
      '  - 12',
      '  - 3.5',
      '  - true',
    ].join('\n'),
  )
})

test('\\u 编码被拆开也能还原', () => {
  const r = createDraftReader()
  assert.equal(r.feed('{"a":"\\u4e') + r.feed('2d"}'), '\n\na：中')
})

test('太长只留尾巴', () => {
  const s = 'x'.repeat(DRAFT_TEXT_MAX + 10)
  const tail = draftTail(s)
  assert.equal(tail.length, DRAFT_TEXT_MAX + 1)
  assert.ok(tail.startsWith('…'))
  assert.equal(draftTail('短'), '短')
})

test('fields 只转出这几个顶层字段，labels 换字段名（嵌套的同名字段也换）', () => {
  const r = createDraftReader({ fields: ['tasks'], labels: { title: '标题', instructions: '任务说明' } })
  const out = ['{"agent":"x","tas', 'ks":[{"title":"查","instructions":"看\\n代码"}],"tier":"hi"}']
    .map((c) => r.feed(c))
    .join('')
  assert.equal(out.trimStart(), 'tasks：\n  - \n    标题：查\n    任务说明：看\n      代码')
})
