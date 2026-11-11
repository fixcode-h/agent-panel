import assert from 'node:assert/strict'
import test from 'node:test'
import { lineDiffText, semanticSection, workbookDiffText, SEMANTIC_MAX } from './review-semantic.ts'
import { TableSchema } from './tables.ts'

const schema = TableSchema.parse({})
const head = [
  ['optional', 'optional', 'optional'],
  ['uint32', 'string', 'uint32'],
  ['ID', 'Name', 'Price'],
]
const book = (rows: string[][], name = '道具') => [{ name, rows: [...head, ...rows] }]

test('表格语义差异：按字段名写出改了哪格、加删了哪行', () => {
  const a = book([
    ['1', '木剑', '100'],
    ['2', '铁剑', '200'],
  ])
  const b = book([
    ['1', '木剑', '120'],
    ['3', '金剑', '500'],
  ])
  const text = workbookDiffText('Data/Item.xlsx', a, b, schema)
  assert.match(text, /工作表「道具」/)
  assert.match(text, /Price 100 → 120/, '改了的格子写字段名和前后的值')
  assert.match(text, /金剑/, '新加的行写出内容')
  assert.match(text, /铁剑/, '删掉的行写出原来的内容')
})

test('表格语义差异：两版一样时为空，新建、删表、加工作表都说清', () => {
  const a = book([['1', '木剑', '100']])
  assert.equal(workbookDiffText('x.xlsx', a, a, schema), '')
  assert.match(workbookDiffText('x.xlsx', null, a, schema), /新建的表格[\s\S]*1 行数据/)
  assert.match(workbookDiffText('x.xlsx', a, null, schema), /删掉的表格/)
  const more = [...a, { name: '掉落', rows: [['ID'], ['1']] }]
  assert.match(workbookDiffText('x.xlsx', a, more, schema), /新加的工作表[\s\S]*掉落/)
  assert.match(workbookDiffText('x.xlsx', more, a, schema), /删掉的工作表[\s\S]*掉落/)
})

test('逐行差异：只带改动前后几行，没改的折起来', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const b = a.replace('line 10', 'line ten')
  const d = lineDiffText(a, b, 1)
  assert.match(d, /^-line 10$/m)
  assert.match(d, /^\+line ten$/m)
  assert.match(d, /^ line 9$/m)
  assert.match(d, /省掉 9 行没改的/)
  assert.equal(lineDiffText(a, a), '')
})

test('语义差异一节：没有文件不出、出错如实写、太长截断', () => {
  assert.equal(semanticSection([]), '')
  const s = semanticSection([
    { path: 'a.uasset', how: '插件 ue 转成文本后逐行比较', text: '', error: '编辑器没开' },
    { path: 'b.xlsx', how: '表格，按格子比较', text: '' },
  ])
  assert.match(s, /## 二进制文件的语义差异/)
  assert.match(s, /读不出语义差异：编辑器没开/)
  assert.match(s, /两版读出来的内容一样/)
  const big = semanticSection(
    Array.from({ length: 10 }, (_, i) => ({ path: `${i}.xlsx`, how: '表格', text: 'x'.repeat(20_000) })),
  )
  assert.ok(big.length < SEMANTIC_MAX + 2000)
  assert.match(big, /太长，后面的没放进来/)
  assert.match(big, /放不下/)
})
