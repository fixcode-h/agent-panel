import assert from 'node:assert/strict'
import test from 'node:test'
import { lineDiffText, semanticSection, SEMANTIC_MAX } from './semantic.ts'

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
